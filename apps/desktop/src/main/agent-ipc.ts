import { MemoryApiError } from "@kovach-dev/memory-contract";
import { isAgentMethod } from "../shared/agent";
import { CHANNELS, type Envelope } from "../shared/ipc";
import type { AgentService } from "./agent-service";
import type { IpcHandlerHost } from "./history-ipc";

/** Serve the agent service to the renderer, with the same envelope as history calls. */
export function serveAgent(ipc: IpcHandlerHost, service: AgentService): () => void {
  ipc.handle(CHANNELS.agentInvoke, async (_event, method, args): Promise<Envelope> => {
    if (!isAgentMethod(method) || !Array.isArray(args)) {
      return { ok: false, error: { code: "invalid", message: `unknown agent call: ${String(method)}` } };
    }
    try {
      const fn = service[method] as (...a: unknown[]) => Promise<unknown>;
      return { ok: true, value: await fn.apply(service, args) };
    } catch (err) {
      return { ok: false, error: MemoryApiError.from(err).toJSON() };
    }
  });
  return () => ipc.removeHandler(CHANNELS.agentInvoke);
}
