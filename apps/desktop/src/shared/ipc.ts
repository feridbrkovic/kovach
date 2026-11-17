import type { MemoryApi, MemoryApiErrorData, MemoryChangeEvent } from "@kovach-dev/memory-contract";
import type { AgentMethod, AgentStatusEvent, ApprovalPrompt } from "./agent";

/** The contract's history and memory methods the renderer may call over IPC. */
export const HISTORY_METHODS = [
  "listSessions",
  "getSession",
  "renameSession",
  "deleteSession",
  "searchMessages",
  "clearHistory",
  // Memory (Phase 2)
  "listMemories",
  "getMemory",
  "getEvidence",
  "createMemory",
  "updateMemory",
  "deleteMemory",
  "setPinned",
  "listCandidates",
  "resolveCandidate",
  "retrieve",
  "getUsedMemories",
  "getSettings",
  "updateSettings",
  // Docs packs and seeding (Phase 3)
  "listDocPacks",
  "buildDocPack",
  "suggestDocPacks",
  "seedProject",
  // Experience memory (Phase 4)
  "listEpisodes",
  "getEpisode",
  "deleteEpisode",
  // Review precision (Phase 5)
  "reviewStats",
] as const;
export type HistoryMethod = (typeof HISTORY_METHODS)[number];

/** What the UI needs from the memory service: history, memory, settings, plus live updates. */
export type HistoryApi = Pick<MemoryApi, HistoryMethod | "onChange">;

export const CHANNELS = {
  invoke: "kovach:history:invoke",
  change: "kovach:history:change",
  agentInvoke: "kovach:agent:invoke",
  agentStatus: "kovach:agent:status",
  agentApproval: "kovach:agent:approval",
  agentMedia: "kovach:agent:media",
  /** Main asks the window to open a session (a clicked notification). */
  openSession: "kovach:open-session",
} as const;

/**
 * Electron's IPC turns a thrown error into a plain message, so results travel
 * in an envelope and errors keep their contract code.
 */
export type Envelope<T = unknown> = { ok: true; value: T } | { ok: false; error: MemoryApiErrorData };

/** What the preload script exposes as `window.kovach`. */
export interface KovachBridge {
  history: {
    invoke(method: HistoryMethod, args: unknown[]): Promise<Envelope>;
    onChange(cb: (e: MemoryChangeEvent) => void): () => void;
  };
  agent: {
    invoke(method: AgentMethod, args: unknown[]): Promise<Envelope>;
    onStatus(cb: (e: AgentStatusEvent) => void): () => void;
    onApproval(cb: (p: ApprovalPrompt) => void): () => void;
    onMediaProgress(cb: (line: string) => void): () => void;
    onOpenSession(cb: (sessionId: string) => void): () => void;
  };
}

export function isHistoryMethod(value: unknown): value is HistoryMethod {
  return typeof value === "string" && (HISTORY_METHODS as readonly string[]).includes(value);
}
