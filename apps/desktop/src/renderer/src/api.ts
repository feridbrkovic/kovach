import { MemoryApiError } from "@kovach-dev/memory-contract";
import type { AgentApi, AgentMethod } from "../../shared/agent";
import type { Envelope, HistoryApi, HistoryMethod, KovachBridge } from "../../shared/ipc";

declare global {
  interface Window {
    /** Set by the preload script inside the desktop app; absent in a plain browser. */
    kovach?: KovachBridge;
  }
}

async function unwrap<T>(promise: Promise<Envelope>): Promise<T> {
  const result = await promise;
  if (result.ok) return result.value as T;
  throw MemoryApiError.from(result.error);
}

/** History API backed by the main process over IPC. */
export function createIpcHistoryApi(bridge: KovachBridge["history"]): HistoryApi {
  const call = <T>(method: HistoryMethod, args: unknown[]) => unwrap<T>(bridge.invoke(method, args));
  return {
    listSessions: (q) => call("listSessions", [q]),
    getSession: (id, q) => call("getSession", q === undefined ? [id] : [id, q]),
    renameSession: (id, title) => call("renameSession", [id, title]),
    deleteSession: (id) => call("deleteSession", [id]),
    searchMessages: (q) => call("searchMessages", [q]),
    clearHistory: (q) => call("clearHistory", [q]),
    listMemories: (f) => call("listMemories", [f]),
    getMemory: (id) => call("getMemory", [id]),
    getEvidence: (id) => call("getEvidence", [id]),
    createMemory: (input) => call("createMemory", [input]),
    updateMemory: (id, patch) => call("updateMemory", [id, patch]),
    deleteMemory: (id) => call("deleteMemory", [id]),
    setPinned: (id, pinned) => call("setPinned", [id, pinned]),
    listCandidates: () => call("listCandidates", []),
    resolveCandidate: (id, resolution) => call("resolveCandidate", [id, resolution]),
    retrieve: (task) => call("retrieve", [task]),
    getUsedMemories: (messageId) => call("getUsedMemories", [messageId]),
    listDocPacks: (projectId) => call("listDocPacks", [projectId]),
    buildDocPack: (projectId, library, version) => call("buildDocPack", [projectId, library, version]),
    suggestDocPacks: (projectId) => call("suggestDocPacks", [projectId]),
    seedProject: (projectId, opts) => call("seedProject", opts === undefined ? [projectId] : [projectId, opts]),
    listEpisodes: (q) => call("listEpisodes", [q]),
    getEpisode: (id) => call("getEpisode", [id]),
    deleteEpisode: (id) => call("deleteEpisode", [id]),
    reviewStats: () => call("reviewStats", []),
    getSettings: () => call("getSettings", []),
    updateSettings: (patch) => call("updateSettings", [patch]),
    onChange: (cb) => bridge.onChange(cb),
  };
}

/** Agent API backed by the main process over IPC. */
export function createIpcAgentApi(bridge: KovachBridge["agent"]): AgentApi {
  const call = <T>(method: AgentMethod, args: unknown[] = []) => unwrap<T>(bridge.invoke(method, args));
  return {
    getSettings: () => call("getSettings"),
    saveSettings: (s) => call("saveSettings", [s]),
    checkModel: () => call("checkModel"),
    listProjects: () => call("listProjects"),
    addProject: () => call("addProject"),
    sessionFiles: (id) => call("sessionFiles", [id]),
    showSessionFiles: (id) => call("showSessionFiles", [id]),
    openSessionPage: (id) => call("openSessionPage", [id]),
    saveSessionFiles: (id) => call("saveSessionFiles", [id]),
    start: (input) => call("start", [input]),
    stop: (runId) => call("stop", [runId]),
    respond: (requestId, decision) => call("respond", [requestId, decision]),
    activeRun: () => call("activeRun"),
    computerPermissions: () => call("computerPermissions"),
    openPermissionSettings: (which) => call("openPermissionSettings", [which]),
    mediaStatus: () => call("mediaStatus"),
    installMedia: () => call("installMedia"),
    readAttachment: (name) => call("readAttachment", [name]),
    listAutomations: () => call("listAutomations"),
    saveAutomation: (input) => call("saveAutomation", [input]),
    deleteAutomation: (id) => call("deleteAutomation", [id]),
    runAutomation: (id, options) => call("runAutomation", [id, options ?? {}]),
    setAutomationsPaused: (paused) => call("setAutomationsPaused", [paused]),
    onStatus: (cb) => bridge.onStatus(cb),
    onApproval: (cb) => bridge.onApproval(cb),
    onMediaProgress: (cb) => bridge.onMediaProgress(cb),
    onOpenSession: (cb) => bridge.onOpenSession(cb),
  };
}

export type DataSource = "app" | "demo";

/** Real history and agent inside the desktop app; the mock and a demo agent in a plain browser. */
export async function connect(): Promise<{ api: HistoryApi; agent: AgentApi; source: DataSource }> {
  if (window.kovach) {
    return { api: createIpcHistoryApi(window.kovach.history), agent: createIpcAgentApi(window.kovach.agent), source: "app" };
  }
  const [{ createMockMemoryApi, demoSeed }, { createDemoAgentApi }] = await Promise.all([
    import("@kovach-dev/memory-contract/mock"),
    import("./demo-agent"),
  ]);
  return { api: createMockMemoryApi({ seed: demoSeed(), latencyMs: 120 }), agent: createDemoAgentApi(), source: "demo" };
}
