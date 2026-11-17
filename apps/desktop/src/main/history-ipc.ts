import { MemoryApiError, type MemoryChangeEvent } from "@kovach-dev/memory-contract";
import type { HistoryStore, MemoryServiceApi } from "@kovach-dev/memory-service";
import { CHANNELS, type Envelope, type HistoryApi, isHistoryMethod } from "../shared/ipc";

/** The part of Electron's `ipcMain` this module uses (a fake in tests). */
export interface IpcHandlerHost {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/**
 * Serve the history methods to the renderer. Every call returns an
 * `Envelope`; errors become `{ code, message }` so the renderer can rebuild a
 * `MemoryApiError`. Change events are forwarded with `broadcast`.
 * Returns a function that stops serving.
 */
export function serveHistory(
  ipc: IpcHandlerHost,
  history: HistoryApi,
  broadcast: (e: MemoryChangeEvent) => void,
): () => void {
  ipc.handle(CHANNELS.invoke, async (_event, method, args): Promise<Envelope> => {
    if (!isHistoryMethod(method) || !Array.isArray(args)) {
      return { ok: false, error: { code: "invalid", message: `unknown history call: ${String(method)}` } };
    }
    try {
      const fn = history[method] as (...a: unknown[]) => Promise<unknown>;
      const value = await fn(...args);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: MemoryApiError.from(err).toJSON() };
    }
  });
  const unsubscribe = history.onChange(broadcast);
  return () => {
    ipc.removeHandler(CHANNELS.invoke);
    unsubscribe();
  };
}

/** History and memory behind one API for the renderer; change events from both. */
export function combineApi(history: HistoryStore, memory: MemoryServiceApi): HistoryApi {
  return {
    listSessions: (q) => history.listSessions(q),
    getSession: (id, q) => history.getSession(id, q),
    renameSession: (id, t) => history.renameSession(id, t),
    deleteSession: (id) => history.deleteSession(id),
    searchMessages: (q) => history.searchMessages(q),
    clearHistory: (q) => history.clearHistory(q),
    listMemories: (f) => memory.listMemories(f),
    getMemory: (id) => memory.getMemory(id),
    getEvidence: (id) => memory.getEvidence(id),
    createMemory: (i) => memory.createMemory(i),
    updateMemory: (id, p) => memory.updateMemory(id, p),
    deleteMemory: (id) => memory.deleteMemory(id),
    setPinned: (id, p) => memory.setPinned(id, p),
    listCandidates: () => memory.listCandidates(),
    resolveCandidate: (id, r) => memory.resolveCandidate(id, r),
    reviewStats: () => memory.reviewStats(),
    retrieve: (t) => memory.retrieve(t),
    getUsedMemories: (id) => memory.getUsedMemories(id),
    listDocPacks: (id) => memory.listDocPacks(id),
    buildDocPack: (id, lib, v) => memory.buildDocPack(id, lib, v),
    suggestDocPacks: (id) => memory.suggestDocPacks(id),
    seedProject: (id, o) => memory.seedProject(id, o),
    listEpisodes: (q) => memory.listEpisodes(q),
    getEpisode: (id) => memory.getEpisode(id),
    deleteEpisode: (id) => memory.deleteEpisode(id),
    getSettings: () => memory.getSettings(),
    updateSettings: (p) => memory.updateSettings(p),
    onChange: (cb) => {
      const a = history.onChange(cb);
      const b = memory.onChange(cb);
      return () => {
        a();
        b();
      };
    },
  };
}
