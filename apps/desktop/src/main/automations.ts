import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryApiError } from "@kovach-dev/memory-contract";
import type { AgentStatusEvent, ApprovalPrompt, Automation, AutomationInput, AutomationsView, RunRef, StartInput } from "../shared/agent";
import { describeSchedule, nextRunAt, validSchedule } from "../shared/schedule";

/** Where automations are kept: one JSON file, written whole through a temporary file. */
export interface AutomationStore {
  load(): AutomationsView;
  save(view: AutomationsView): void;
}

export function createAutomationStore(path: string): AutomationStore {
  return {
    load() {
      if (!existsSync(path)) return { paused: false, items: [] };
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutomationsView>;
        return { paused: raw.paused === true, items: Array.isArray(raw.items) ? raw.items : [] };
      } catch {
        return { paused: false, items: [] };
      }
    },
    save(view) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(view, null, 2), "utf8");
      renameSync(`${path}.tmp`, path);
    },
  };
}

export function memoryAutomationStore(initial: AutomationsView = { paused: false, items: [] }): AutomationStore {
  let view = structuredClone(initial);
  return { load: () => structuredClone(view), save: (v) => (view = structuredClone(v)) };
}

/** What the runner needs from the agent: starting and stopping runs. */
export interface AutomationHost {
  start(input: StartInput): Promise<RunRef>;
  stop(runId: string): Promise<void>;
  activeRun(): Promise<RunRef | undefined>;
  projectExists(id: string): boolean;
}

export interface AutomationDeps {
  store: AutomationStore;
  host: AutomationHost;
  /** A system notification; clicking it should open the session. */
  notify?: (title: string, body: string, sessionId?: string) => void;
  now?: () => number;
  /** How long a run may take before it is stopped with a report. */
  budgetMs?: number;
}

const DRY_RUN = (prompt: string) =>
  `This is a trial run of a scheduled task. Don't change anything: no edits, no commands that change files. Look at what the task needs and report exactly what you would do on a real run, step by step, and anything that would stop it.\n\nThe task:\n${prompt}`;

/**
 * Starts automations when they are due, one at a time, as ordinary sessions. A due automation
 * waits while another task runs. Runs missed while the Mac slept or the app was closed run once.
 */
export class AutomationRunner {
  private view: AutomationsView;
  private readonly now: () => number;
  /** Runs started by the runner, by run id. */
  private readonly running = new Map<string, { id: string; timer?: ReturnType<typeof setTimeout> }>();
  private ticking = false;

  constructor(private readonly deps: AutomationDeps) {
    this.now = deps.now ?? Date.now;
    this.view = deps.store.load();
    // Recompute what lies in the past: a run missed while closed is due now, once.
    for (const a of this.view.items) {
      if (a.lastRun?.status === "running") a.lastRun = { ...a.lastRun, status: "aborted", message: "The app was closed during the run." };
    }
    this.persist();
  }

  list(): AutomationsView {
    return structuredClone(this.view);
  }

  save(input: AutomationInput): Automation {
    const name = input.name?.trim();
    const prompt = input.prompt?.trim();
    if (!name) throw new MemoryApiError("invalid", "Give the automation a name");
    if (!prompt) throw new MemoryApiError("invalid", "Write what the automation should do");
    const problem = validSchedule(input.schedule);
    if (problem) throw new MemoryApiError("invalid", problem);
    if (input.projectId && !this.deps.host.projectExists(input.projectId)) throw new MemoryApiError("not_found", "That project no longer exists");
    const now = this.now();
    const existing = input.id ? this.view.items.find((a) => a.id === input.id) : undefined;
    if (input.id && !existing) throw new MemoryApiError("not_found", "That automation no longer exists");
    const changedTask = existing && (existing.prompt !== prompt || existing.projectId !== input.projectId);
    const next: Automation = {
      id: existing?.id ?? `aut_${randomUUID()}`,
      name,
      prompt,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      schedule: input.schedule,
      enabled: input.enabled ?? existing?.enabled ?? true,
      // A changed task gets a new trial run first.
      dryRunDone: changedTask ? false : (existing?.dryRunDone ?? false),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
    };
    const at = next.enabled ? nextRunAt(next.schedule, now) : undefined;
    if (at !== undefined) next.nextRunAt = at;
    this.view.items = existing ? this.view.items.map((a) => (a.id === next.id ? next : a)) : [...this.view.items, next];
    this.persist();
    return structuredClone(next);
  }

  delete(id: string): void {
    this.view.items = this.view.items.filter((a) => a.id !== id);
    this.persist();
  }

  setPaused(paused: boolean): AutomationsView {
    this.view.paused = paused;
    this.persist();
    return this.list();
  }

  /** Start one now (the "Run now" and "Try it" buttons). */
  async run(id: string, options: { dryRun?: boolean } = {}): Promise<RunRef> {
    const a = this.view.items.find((x) => x.id === id);
    if (!a) throw new MemoryApiError("not_found", "That automation no longer exists");
    return this.launch(a, options.dryRun ?? !a.dryRunDone);
  }

  /** Called every half minute: start the first automation that is due, if nothing is running. */
  async tick(): Promise<void> {
    if (this.ticking || this.view.paused) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.view.items
        .filter((a) => a.enabled && a.nextRunAt !== undefined && a.nextRunAt <= now)
        .sort((x, y) => x.nextRunAt! - y.nextRunAt!)[0];
      if (!due || (await this.deps.host.activeRun())) return;
      try {
        await this.launch(due, !due.dryRunDone);
      } catch (err) {
        // A run that can't start (project gone, model unreachable) is reported, not retried every tick.
        this.schedule(due, now);
        due.lastRun = { at: now, sessionId: due.lastRun?.sessionId ?? "", dryRun: !due.dryRunDone, status: "error", message: err instanceof Error ? err.message : String(err) };
        this.persist();
        this.deps.notify?.(`${due.name} didn't start`, due.lastRun.message ?? "");
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Fed every status event of every run. */
  onStatus(e: AgentStatusEvent): void {
    if (e.type !== "finished") return;
    const run = this.running.get(e.runId);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    this.running.delete(e.runId);
    const a = this.view.items.find((x) => x.id === run.id);
    if (!a?.lastRun) return;
    const dryRun = a.lastRun.dryRun;
    a.lastRun = { ...a.lastRun, status: e.status, message: e.message.slice(0, 500) };
    // A trial that finished shows the user what a real run will do; real runs follow it.
    if (dryRun && (e.status === "done" || e.status === "done_with_failing_checks")) a.dryRunDone = true;
    this.persist();
    const title = dryRun ? `${a.name}: trial run finished` : e.status === "done" ? `${a.name} finished` : `${a.name} stopped`;
    this.deps.notify?.(title, firstLine(e.message), e.sessionId);
  }

  /** Fed every approval request: an automation that waits on the user says so. */
  onApproval(p: ApprovalPrompt): void {
    const run = this.running.get(p.runId);
    if (!run) return;
    const a = this.view.items.find((x) => x.id === run.id);
    if (a) this.deps.notify?.(`${a.name} needs your OK`, p.command.slice(0, 140), p.sessionId);
  }

  private async launch(a: Automation, dryRun: boolean): Promise<RunRef> {
    const now = this.now();
    const ref = await this.deps.host.start({
      text: dryRun ? DRY_RUN(a.prompt) : a.prompt,
      ...(a.projectId ? { projectId: a.projectId } : {}),
      title: `${a.name}${dryRun ? " (trial)" : ""} · ${new Date(now).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
      ...(dryRun ? { readOnly: true } : {}),
    });
    const budget = this.deps.budgetMs ?? 20 * 60_000;
    const timer = setTimeout(() => void this.deps.host.stop(ref.runId), budget);
    timer.unref?.();
    this.running.set(ref.runId, { id: a.id, timer });
    a.lastRun = { at: now, sessionId: ref.sessionId, dryRun, status: "running" };
    this.schedule(a, now);
    this.persist();
    return ref;
  }

  private schedule(a: Automation, from: number): void {
    const at = a.enabled ? nextRunAt(a.schedule, from) : undefined;
    if (at === undefined) {
      delete a.nextRunAt;
      if (a.schedule.kind === "once") a.enabled = false;
    } else a.nextRunAt = at;
  }

  private persist(): void {
    this.deps.store.save(this.view);
  }
}

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.slice(0, 160) ?? "";

/** For the menu and logs. */
export const summary = (a: Automation) => `${a.name}: ${describeSchedule(a.schedule)}`;
