import type { MemoryChangeEvent } from "@kovach-dev/memory-contract";
import { contextBridge, ipcRenderer } from "electron";
import type { AgentStatusEvent, ApprovalPrompt } from "../shared/agent";
import { CHANNELS, type KovachBridge } from "../shared/ipc";

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: KovachBridge = {
  history: {
    invoke: (method, args) => ipcRenderer.invoke(CHANNELS.invoke, method, args),
    onChange: (cb) => subscribe<MemoryChangeEvent>(CHANNELS.change, cb),
  },
  agent: {
    invoke: (method, args) => ipcRenderer.invoke(CHANNELS.agentInvoke, method, args),
    onStatus: (cb) => subscribe<AgentStatusEvent>(CHANNELS.agentStatus, cb),
    onApproval: (cb) => subscribe<ApprovalPrompt>(CHANNELS.agentApproval, cb),
    onMediaProgress: (cb) => subscribe<string>(CHANNELS.agentMedia, cb),
    onOpenSession: (cb) => subscribe<string>(CHANNELS.openSession, cb),
  },
};

contextBridge.exposeInMainWorld("kovach", bridge);
