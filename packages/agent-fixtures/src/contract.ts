import { Message, SessionSummary, type ToolCall } from "@kovach-dev/memory-contract";
import type { Fixture } from "./format.js";

/**
 * Converts a fixture into memory-contract records, e.g. to seed a mock
 * `MemoryApi` or to check that a stored session round-trips.
 *
 * - User and model events become `user` / `assistant` messages.
 * - Tool results are attached as `toolCalls` on the assistant message that
 *   requested them; a call without a recorded result keeps only name and args.
 * - Ids are deterministic: `<sessionId>-m<n>` for messages and
 *   `<sessionId>-t<n>` for tool calls, numbered from 0 in fixture order.
 * - Timestamps come from the fixture. A complete fixture yields a `done`
 *   session, an incomplete one an `open` session.
 *
 * The output is validated with the contract's zod schemas.
 */
export function toContractSession(
  fixture: Fixture,
  options: { sessionId: string; title?: string },
): { session: SessionSummary; messages: Message[] } {
  const { sessionId } = options;
  const { header } = fixture;
  // Built as plain objects and validated at the end, because tool results
  // complete a call after its message was created.
  const messages: Array<Omit<Message, "toolCalls"> & { toolCalls?: ToolCall[] }> = [];
  /** Tool calls of the latest assistant message, by recorded call id. */
  let open = new Map<string, ToolCall>();
  let toolIndex = 0;
  let updatedAt = header.recordedAt;

  for (const e of fixture.events) {
    updatedAt = Math.max(updatedAt, e.at);
    switch (e.type) {
      case "user":
        messages.push({
          id: `${sessionId}-m${messages.length}`,
          sessionId,
          role: "user",
          content: e.content,
          createdAt: e.at,
        });
        break;
      case "model": {
        open = new Map();
        const toolCalls: ToolCall[] = e.toolCalls.map((c) => {
          const call: ToolCall = {
            id: `${sessionId}-t${toolIndex++}`,
            name: c.name,
            ...(c.args !== undefined && { args: c.args }),
            createdAt: e.at,
          };
          open.set(c.id, call);
          return call;
        });
        messages.push({
          id: `${sessionId}-m${messages.length}`,
          sessionId,
          role: "assistant",
          content: e.content,
          model: header.model,
          ...(e.tokens !== undefined && { tokens: e.tokens }),
          toolCalls,
          createdAt: e.at,
        });
        break;
      }
      case "tool_result": {
        const call = open.get(e.toolCallId);
        // The loader guarantees a matching call; guard for hand-built fixtures.
        if (call === undefined) throw new Error(`tool result for unknown tool call "${e.toolCallId}"`);
        if (e.command !== undefined) call.command = e.command;
        if (e.exitCode !== undefined) call.exitCode = e.exitCode;
        if (e.durationMs !== undefined) call.durationMs = e.durationMs;
        call.outputExcerpt = e.outputExcerpt;
        break;
      }
      case "end":
        break;
    }
  }

  const validated = messages.map((m) => Message.parse(m));
  const title = options.title ?? (typeof header.meta.title === "string" ? header.meta.title : undefined);
  const session = SessionSummary.parse({
    id: sessionId,
    ...(header.projectId !== undefined && { projectId: header.projectId }),
    ...(title !== undefined && { title }),
    model: header.model,
    status: fixture.complete ? "done" : "open",
    messageCount: validated.length,
    createdAt: header.recordedAt,
    updatedAt,
  });
  return { session, messages: validated };
}
