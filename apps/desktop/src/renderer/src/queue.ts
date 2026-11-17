import type { ComposerSubmit } from "./components/Composer";

/**
 * A message written while a task was running. Only one task runs at a time, so messages wait
 * here, in the order they were written, and the next one starts when the current task finishes.
 */
export interface QueuedMessage {
  id: string;
  /** The session it continues; absent for a new task. */
  sessionId?: string | undefined;
  /** For a new task: the project it runs in, if any. */
  projectId?: string | undefined;
  input: ComposerSubmit;
}

let seq = 0;
export const queueId = () => `q_${Date.now().toString(36)}_${++seq}`;

/** The messages a composer shows: those for its session, or the new tasks on the start screen. */
export const queuedFor = (queue: QueuedMessage[], sessionId: string | undefined) => queue.filter((m) => m.sessionId === sessionId);

/** True when starting failed only because the previous task hasn't fully ended yet. */
export const isStillRunning = (err: unknown) =>
  (err as { code?: unknown } | undefined)?.code === "conflict" || /still running/i.test(err instanceof Error ? err.message : String(err));
