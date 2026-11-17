import { MemoryApiError } from "@kovach-dev/memory-contract";
import {
  type AgentApi,
  type AgentSettings,
  type AgentStatusEvent,
  type ApprovalDecision,
  type ApprovalPrompt,
  type Automation,
  type AutomationsView,
  DEFAULT_SETTINGS,
  type ProjectInfo,
  type RunRef,
  type StatusBody,
} from "../../shared/agent";
import { nextRunAt } from "../../shared/schedule";

/**
 * A pretend agent for the browser preview and UI tests: it walks through a
 * plan, asks to run the typecheck, and finishes. Nothing is written anywhere.
 */
export function createDemoAgentApi(options: { stepMs?: number; projects?: ProjectInfo[] } = {}): AgentApi {
  const stepMs = options.stepMs ?? 600;
  let settings: AgentSettings = { ...DEFAULT_SETTINGS };
  let hasApiKey = false;
  const projects: ProjectInfo[] = options.projects ?? [
    { id: "proj_shop_app", name: "shop-app", path: "~/Projects/shop-app" },
    { id: "proj_billing_api", name: "billing-api", path: "~/Projects/billing-api" },
  ];
  const statusListeners = new Set<(e: AgentStatusEvent) => void>();
  const approvalListeners = new Set<(p: ApprovalPrompt) => void>();
  let automations: AutomationsView = { paused: false, items: [] };
  let active: (RunRef & { stopped: boolean }) | undefined;
  const pending = new Map<string, (d: ApprovalDecision) => void>();
  let seq = 0;

  const emit = (e: AgentStatusEvent) => {
    // As in the app: the run is over before anyone hears that it finished.
    if (e.type === "finished" && active?.runId === e.runId) active = undefined;
    statusListeners.forEach((cb) => cb(e));
  };
  const wait = () => new Promise((r) => setTimeout(r, stepMs));

  async function play(run: RunRef & { stopped: boolean }, sessionId: string) {
    const ref = { runId: run.runId, sessionId };
    const step = async (e: StatusBody) => {
      if (run.stopped) throw new Error("stopped");
      emit({ ...ref, ...e });
      await wait();
    };
    try {
      await step({ type: "activity", text: "Thinking" });
      await step({
        type: "plan",
        summary: "Return a number from total() and prove it with the typecheck",
        steps: [
          { title: "Read total() in src/cart.ts", files: ["src/cart.ts"] },
          { title: "Return a rounded number instead of a string", files: ["src/cart.ts"] },
          { title: "Run the typecheck", files: [] },
        ],
      });
      await step({ type: "activity", text: "Reading src/cart.ts" });
      await step({ type: "activity", text: "Editing src/cart.ts" });
      const requestId = `req_${++seq}`;
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        pending.set(requestId, resolve);
        approvalListeners.forEach((cb) =>
          cb({ ...ref, requestId, kind: "check", command: "pnpm typecheck", cwd: "~/Projects/shop-app" }),
        );
      });
      if (run.stopped) throw new Error("stopped");
      if (decision === "deny") {
        emit({ ...ref, type: "finished", status: "done_with_failing_checks", message: "I couldn't verify the change because the typecheck wasn't run." });
        return;
      }
      await step({ type: "activity", text: "Running checks" });
      emit({ ...ref, type: "checks", passed: true, results: [{ kind: "typecheck", command: "pnpm typecheck", exitCode: 0 }] });
      emit({ ...ref, type: "finished", status: "done", message: "Fixed: total() in src/cart.ts now returns a number, and the typecheck passes." });
    } catch {
      emit({ ...ref, type: "finished", status: "aborted", message: "Stopped by the user." });
    } finally {
      active = undefined;
    }
  }

  return {
    getSettings: async () => ({ ...settings, hasApiKey }),
    async saveSettings({ apiKey, ...s }) {
      settings = { ...settings, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) };
      if (apiKey !== undefined) hasApiKey = apiKey !== "";
      return { ...settings, hasApiKey };
    },
    checkModel: async () => ({ ok: false, message: "Demo mode: no model server is connected." }),
    listProjects: async () => projects,
    addProject: async () => undefined,
    sessionFiles: async () => ({ count: 0, names: [] }),
    showSessionFiles: async () => undefined,
    openSessionPage: async () => undefined,
    saveSessionFiles: async () => undefined,
    onOpenSession: () => () => undefined,
    listAutomations: async () => structuredClone(automations),
    async saveAutomation(input) {
      const at = Date.now();
      const existing = automations.items.find((a) => a.id === input.id);
      const saved: Automation = {
        id: existing?.id ?? `aut_demo_${++seq}`,
        name: input.name,
        prompt: input.prompt,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        schedule: input.schedule,
        enabled: input.enabled ?? true,
        dryRunDone: existing?.dryRunDone ?? false,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      const next = saved.enabled ? nextRunAt(saved.schedule, at) : undefined;
      if (next !== undefined) saved.nextRunAt = next;
      automations.items = existing ? automations.items.map((a) => (a.id === saved.id ? saved : a)) : [...automations.items, saved];
      return structuredClone(saved);
    },
    async deleteAutomation(id) {
      automations.items = automations.items.filter((a) => a.id !== id);
    },
    async runAutomation(id, options) {
      const a = automations.items.find((x) => x.id === id);
      if (!a) throw new MemoryApiError("not_found", "That automation no longer exists");
      const ref = await this.start({ text: a.prompt, ...(a.projectId ? { projectId: a.projectId } : {}) });
      a.lastRun = { at: Date.now(), sessionId: ref.sessionId, dryRun: options?.dryRun ?? !a.dryRunDone, status: "running" };
      return ref;
    },
    async setAutomationsPaused(paused) {
      automations.paused = paused;
      return structuredClone(automations);
    },
    activeRun: async () => (active ? { runId: active.runId, sessionId: active.sessionId } : undefined),
    async start(input) {
      if (!input.text.trim()) throw new MemoryApiError("invalid", "Write what you want done first");
      if (active) throw new MemoryApiError("conflict", "Another task is still running.");
      const sessionId = input.sessionId ?? "ses_demo_new";
      active = { runId: `run_${++seq}`, sessionId, stopped: false };
      const ref = { runId: active.runId, sessionId };
      emit({ ...ref, type: "started" });
      void play(active, sessionId);
      return ref;
    },
    async stop(runId) {
      if (active?.runId !== runId) return;
      active.stopped = true;
      for (const [id, resolve] of pending) {
        pending.delete(id);
        resolve("deny");
      }
    },
    async respond(requestId, decision) {
      const resolve = pending.get(requestId);
      if (!resolve) throw new MemoryApiError("not_found", "That approval request is no longer open");
      pending.delete(requestId);
      resolve(decision);
    },
    computerPermissions: async () => ({ screenRecording: false, accessibility: false }),
    openPermissionSettings: async () => {},
    mediaStatus: async () => ({ state: "not_installed" as const }),
    installMedia: async () => ({ state: "not_installed" as const, detail: "Demo mode: nothing is installed." }),
    readAttachment: async () => "data:image/png;base64,iVBORw0KGgo=",
    onMediaProgress: () => () => {},
    onStatus(cb) {
      statusListeners.add(cb);
      return () => void statusListeners.delete(cb);
    },
    onApproval(cb) {
      approvalListeners.add(cb);
      return () => void approvalListeners.delete(cb);
    },
  };
}
