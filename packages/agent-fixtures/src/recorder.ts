import { closeSync, openSync, writeSync } from "node:fs";
import type { z } from "zod";
import {
  EndEvent,
  FixtureHeader,
  type FixtureLine,
  FORMAT_VERSION,
  formatIssues,
  ModelEvent,
  OUTPUT_EXCERPT_MAX,
  type RecordedToolCall,
  SequenceChecker,
  ToolResultEvent,
  UserEvent,
} from "./format.js";
import { redact, redactDeep } from "./redact.js";

export interface RecorderOptions {
  /** File to write. An existing file is replaced. */
  path: string;
  header: {
    model: string;
    projectId?: string;
    meta?: Record<string, unknown>;
    /** Defaults to `now()`. */
    recordedAt?: number;
  };
  /** Clock for event timestamps; defaults to `Date.now`. */
  now?: () => number;
}

export interface ToolResultInput {
  toolCallId: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  /** Full output; it is redacted, then cut to the 8 KB excerpt. */
  output: string;
}

export interface Recorder {
  user(content: string): void;
  model(turn: { content: string; toolCalls?: RecordedToolCall[]; tokens?: number }): void;
  toolResult(result: ToolResultInput): void;
  /** Writes the end event. Nothing can be appended afterwards. */
  end(status?: EndEvent["status"]): void;
  /** Closes the file. Idempotent. Without `end()` the fixture stays incomplete. */
  close(): void;
}

/**
 * Records an agent session as a JSONL fixture.
 *
 * Each event is validated, redacted and written with one synchronous write,
 * so a crash at any point leaves a file whose lines are all complete and valid.
 */
export function createRecorder(options: RecorderOptions): Recorder {
  const now = options.now ?? Date.now;
  const checker = new SequenceChecker();
  const h = options.header;
  const header = validate(
    FixtureHeader,
    {
      type: "header",
      formatVersion: FORMAT_VERSION,
      recordedAt: h.recordedAt ?? now(),
      model: redact(h.model),
      ...(h.projectId !== undefined && { projectId: redact(h.projectId) }),
      meta: redactDeep(h.meta ?? {}),
    },
    "header",
  );

  let fd: number | undefined = openSync(options.path, "w");
  let ended = false;

  const write = (line: FixtureLine) => {
    if (fd === undefined) throw new Error(`recorder for ${options.path} is closed`);
    const problem = checker.check(line);
    if (problem) throw new Error(`cannot record ${line.type} event: ${problem}`);
    writeSync(fd, `${JSON.stringify(line)}\n`);
  };

  write(header);

  return {
    user(content) {
      write(validate(UserEvent, { type: "user", at: now(), content: redact(content) }, "user event"));
    },

    model(turn) {
      const toolCalls = (turn.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: redact(c.name),
        ...(c.args !== undefined && { args: redactDeep(c.args) }),
      }));
      write(
        validate(
          ModelEvent,
          {
            type: "model",
            at: now(),
            content: redact(turn.content),
            toolCalls,
            ...(turn.tokens !== undefined && { tokens: turn.tokens }),
          },
          "model event",
        ),
      );
    },

    toolResult(r) {
      const { excerpt, truncated } = toExcerpt(r.output);
      write(
        validate(
          ToolResultEvent,
          {
            type: "tool_result",
            at: now(),
            toolCallId: r.toolCallId,
            ...(r.command !== undefined && { command: redact(r.command) }),
            ...(r.exitCode !== undefined && { exitCode: r.exitCode }),
            ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
            outputExcerpt: excerpt,
            ...(truncated && { outputTruncated: true }),
          },
          "tool result",
        ),
      );
    },

    end(status = "done") {
      if (ended) throw new Error("end() was already called");
      write(validate(EndEvent, { type: "end", at: now(), status }, "end event"));
      ended = true;
    },

    close() {
      if (fd === undefined) return;
      closeSync(fd);
      fd = undefined;
    },
  };
}

function validate<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${what}: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

/**
 * Redacts first so a secret straddling the cut is still caught, then cuts to
 * the excerpt size without splitting a surrogate pair.
 */
export function toExcerpt(output: string): { excerpt: string; truncated: boolean } {
  const clean = redact(output);
  if (clean.length <= OUTPUT_EXCERPT_MAX) return { excerpt: clean, truncated: false };
  let end = OUTPUT_EXCERPT_MAX;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { excerpt: clean.slice(0, end), truncated: true };
}
