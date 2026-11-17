/**
 * A small persistent job queue (MASTER_PLAN › Architecture, "Background
 * jobs"). Jobs live in the `jobs` table, run one at a time, survive restarts,
 * and pause while the user runs a task so they don't compete with the model.
 */
import type { JobRef } from "@kovach-dev/memory-contract";
import type { Db } from "./db.js";

export type JobKind = JobRef["kind"];

export interface JobContext {
  signal: AbortSignal;
  /** Await between steps: waits while the queue is paused, throws if cancelled. */
  checkpoint(): Promise<void>;
  /** Progress for the UI, e.g. "Embedding 320 of 2,100". */
  progress(text: string): void;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

export interface JobRunner {
  register(kind: JobKind, handler: JobHandler): void;
  enqueue(kind: JobKind, payload: Record<string, unknown>): JobRef;
  get(id: string): (JobRef & { error?: string; progress?: string; payload: Record<string, unknown> }) | undefined;
  /** Jobs not finished yet, oldest first. */
  pending(): (JobRef & { payload: Record<string, unknown>; progress?: string })[];
  cancel(id: string): void;
  pause(): void;
  resume(): void;
  /** Resolves when nothing is queued or running (tests and shutdown). */
  idle(): Promise<void>;
  /** Start working through the queue (also picks up jobs left from the last run). */
  start(): void;
  stop(): void;
}

interface JobRow {
  id: string;
  kind: JobKind;
  status: JobRef["status"];
  payload_json: string;
  attempts: number;
  last_error: string | null;
}

export function createJobRunner(
  db: Db,
  opts: { now?: () => number; newId?: (prefix: string) => string; onChange?: (job: JobRef) => void; maxAttempts?: number } = {},
): JobRunner {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? ((p: string) => `${p}_${Math.random().toString(36).slice(2, 12)}`);
  const maxAttempts = opts.maxAttempts ?? 2;
  const handlers = new Map<JobKind, JobHandler>();
  const progress = new Map<string, string>();
  let paused = false;
  let running = false;
  let stopped = true;
  let current: { id: string; controller: AbortController } | undefined;
  let resumeWaiters: (() => void)[] = [];
  let idleWaiters: (() => void)[] = [];

  const ref = (r: Pick<JobRow, "id" | "kind" | "status">): JobRef => ({ id: r.id, kind: r.kind, status: r.status });
  const setStatus = (id: string, status: JobRef["status"], error?: string) => {
    db.prepare("UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(status, error ?? null, now(), id);
    const r = db.prepare("SELECT id, kind, status FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (r) opts.onChange?.(ref(r));
  };

  const next = () =>
    db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at, rowid LIMIT 1")
      .get(now()) as JobRow | undefined;

  const loop = async () => {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        if (stopped) break;
        if (paused) await new Promise<void>((r) => resumeWaiters.push(r));
        if (stopped) break;
        const job = next();
        if (!job) break;
        const handler = handlers.get(job.kind);
        if (!handler) {
          setStatus(job.id, "failed", `no handler for ${job.kind}`);
          continue;
        }
        db.prepare("UPDATE jobs SET attempts = attempts + 1 WHERE id = ?").run(job.id);
        setStatus(job.id, "running");
        const controller = new AbortController();
        current = { id: job.id, controller };
        const ctx: JobContext = {
          signal: controller.signal,
          checkpoint: async () => {
            if (paused) await new Promise<void>((r) => resumeWaiters.push(r));
            if (controller.signal.aborted) throw new Error("cancelled");
          },
          progress: (text) => {
            progress.set(job.id, text);
            opts.onChange?.(ref({ ...job, status: "running" }));
          },
        };
        try {
          await handler(JSON.parse(job.payload_json) as Record<string, unknown>, ctx);
          setStatus(job.id, controller.signal.aborted ? "cancelled" : "done");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) setStatus(job.id, "cancelled");
          else if (job.attempts + 1 < maxAttempts && !/^(No |npm has no|.* doesn't name)/.test(message)) {
            // Network hiccups: one retry a minute later. Missing docs won't appear by retrying.
            db.prepare("UPDATE jobs SET status = 'queued', last_error = ?, run_after = ?, updated_at = ? WHERE id = ?").run(message, now() + 60_000, now(), job.id);
            opts.onChange?.(ref({ ...job, status: "queued" }));
          } else setStatus(job.id, "failed", message);
        } finally {
          current = undefined;
          progress.delete(job.id);
        }
      }
    } finally {
      running = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  return {
    register(kind, handler) {
      handlers.set(kind, handler);
    },
    enqueue(kind, payload) {
      const id = newId("job");
      const t = now();
      db.prepare("INSERT INTO jobs (id, kind, status, payload_json, run_after, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)").run(
        id,
        kind,
        JSON.stringify(payload),
        t,
        t,
        t,
      );
      const job: JobRef = { id, kind, status: "queued" };
      opts.onChange?.(job);
      void loop();
      return job;
    },
    get(id) {
      const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
      if (!r) return undefined;
      const p = progress.get(id);
      return { ...ref(r), payload: JSON.parse(r.payload_json) as Record<string, unknown>, ...(r.last_error ? { error: r.last_error } : {}), ...(p ? { progress: p } : {}) };
    },
    pending() {
      return (db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at, rowid").all() as JobRow[]).map((r) => {
        const p = progress.get(r.id);
        return { ...ref(r), payload: JSON.parse(r.payload_json) as Record<string, unknown>, ...(p ? { progress: p } : {}) };
      });
    },
    cancel(id) {
      if (current?.id === id) current.controller.abort();
      else {
        const r = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | undefined;
        if (r?.status === "queued") setStatus(id, "cancelled");
      }
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      const w = resumeWaiters;
      resumeWaiters = [];
      for (const r of w) r();
    },
    idle() {
      if (!running && !next()) return Promise.resolve();
      return new Promise((r) => idleWaiters.push(r));
    },
    start() {
      stopped = false;
      // A job that was running when the app quit starts over.
      db.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now());
      void loop();
    },
    stop() {
      stopped = true;
      current?.controller.abort();
      this.resume();
    },
  };
}
