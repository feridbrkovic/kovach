/**
 * Agent session fixture format.
 *
 * A fixture is a JSONL file: one JSON object per line. Line 1 is the header,
 * every following line is an event, in the order it happened. A fixture that
 * ends without an `end` event is an incomplete recording (for example, the
 * agent crashed); every line before that point is still valid.
 */
import { z } from "zod";

/** Bump on any change that an older loader cannot read. */
export const FORMAT_VERSION = 1;

/** Matches `ToolCall.outputExcerpt` in the memory contract. */
export const OUTPUT_EXCERPT_MAX = 8192;

/** Unix epoch milliseconds. */
const Timestamp = z.number().int().nonnegative();

export const FixtureHeader = z.object({
  type: z.literal("header"),
  formatVersion: z.literal(FORMAT_VERSION),
  recordedAt: Timestamp,
  model: z.string().min(1),
  projectId: z.string().min(1).optional(),
  /** Free-form notes about the recording: task, repo snapshot, tool versions. */
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type FixtureHeader = z.infer<typeof FixtureHeader>;

export const UserEvent = z.object({
  type: z.literal("user"),
  at: Timestamp,
  content: z.string(),
});
export type UserEvent = z.infer<typeof UserEvent>;

/** A tool call as the model requested it. */
export const RecordedToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
});
export type RecordedToolCall = z.infer<typeof RecordedToolCall>;

export const ModelEvent = z.object({
  type: z.literal("model"),
  at: Timestamp,
  content: z.string(),
  toolCalls: z.array(RecordedToolCall).default([]),
  tokens: z.number().int().nonnegative().optional(),
});
export type ModelEvent = z.infer<typeof ModelEvent>;

export const ToolResultEvent = z.object({
  type: z.literal("tool_result"),
  at: Timestamp,
  /** Id of a tool call requested by the most recent model turn. */
  toolCallId: z.string().min(1),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outputExcerpt: z.string().max(OUTPUT_EXCERPT_MAX),
  /** True when the original output was longer than the excerpt. */
  outputTruncated: z.boolean().optional(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEvent>;

export const EndEvent = z.object({
  type: z.literal("end"),
  at: Timestamp,
  status: z.enum(["done", "aborted", "error"]).default("done"),
});
export type EndEvent = z.infer<typeof EndEvent>;

export const FixtureEvent = z.discriminatedUnion("type", [UserEvent, ModelEvent, ToolResultEvent, EndEvent]);
export type FixtureEvent = z.infer<typeof FixtureEvent>;

export const FixtureLine = z.discriminatedUnion("type", [FixtureHeader, UserEvent, ModelEvent, ToolResultEvent, EndEvent]);
export type FixtureLine = z.infer<typeof FixtureLine>;

export interface Fixture {
  header: FixtureHeader;
  events: FixtureEvent[];
  /** False when the recording stopped before an `end` event. */
  complete: boolean;
}

/**
 * Ordering rules shared by the recorder and the loader:
 * the header comes first and only once, nothing follows `end`, and a tool
 * result answers a call from the most recent model turn, at most once.
 * Returns an error message, or undefined when the line is acceptable.
 */
export class SequenceChecker {
  private sawHeader = false;
  private ended = false;
  private pending = new Set<string>();

  check(line: FixtureLine): string | undefined {
    if (line.type === "header") {
      if (this.sawHeader) return "duplicate header";
      this.sawHeader = true;
      return undefined;
    }
    if (!this.sawHeader) return "first line must be the header";
    if (this.ended) return `"${line.type}" event after end`;
    switch (line.type) {
      case "model": {
        const ids = new Set<string>();
        for (const call of line.toolCalls) {
          if (ids.has(call.id)) return `duplicate tool call id "${call.id}" in one model turn`;
          ids.add(call.id);
        }
        this.pending = ids;
        return undefined;
      }
      case "tool_result":
        if (!this.pending.delete(line.toolCallId)) {
          return `tool result for "${line.toolCallId}", which the latest model turn did not request or which was already answered`;
        }
        return undefined;
      case "end":
        this.ended = true;
        return undefined;
      case "user":
        return undefined;
    }
  }
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");
}
