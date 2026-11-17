import type { Fixture, ModelEvent, RecordedToolCall } from "./format.js";
import { toExcerpt } from "./recorder.js";
import { redact } from "./redact.js";

/**
 * What the agent loop hands the model since the previous turn: new user
 * messages and the results of the tool calls the previous turn requested.
 */
export type ScriptInput =
  | { type: "user"; content: string }
  | {
      type: "tool_result";
      toolCallId: string;
      /** Compared only when given. */
      command?: string;
      /** Compared only when given. */
      exitCode?: number;
      /** Compared only when given, after the same redaction and 8 KB cut the recorder applies. */
      output?: string;
    };

export interface ModelTurn {
  content: string;
  toolCalls: RecordedToolCall[];
  tokens?: number;
}

export interface ScriptedModel {
  /** Returns the next recorded model turn. Throws when the script is exhausted. */
  next(input?: readonly ScriptInput[]): ModelTurn;
  /** Model turns not yet returned. */
  readonly remaining: number;
}

export class ScriptDivergenceError extends Error {
  constructor(
    readonly turn: number,
    detail: string,
  ) {
    super(`scripted model diverged before turn ${turn}: ${detail}`);
    this.name = "ScriptDivergenceError";
  }
}

export class ScriptExhaustedError extends Error {
  constructor(readonly turns: number) {
    super(`scripted model has no more turns: the fixture recorded ${turns} model turn(s)`);
    this.name = "ScriptExhaustedError";
  }
}

interface Step {
  /** Recorded inputs (user messages, tool results) between the previous model turn and this one. */
  inputs: ScriptInput[];
  turn: ModelEvent;
}

/**
 * Replays a fixture's model turns in order.
 *
 * In strict mode every call must pass exactly the inputs that were recorded
 * before that turn (the delta since the previous turn, not the full history);
 * any difference throws a `ScriptDivergenceError` naming the first mismatch.
 */
export function createScriptedModel(fixture: Fixture, options: { strict?: boolean } = {}): ScriptedModel {
  const strict = options.strict ?? false;
  const steps: Step[] = [];
  let pending: ScriptInput[] = [];
  for (const e of fixture.events) {
    if (e.type === "user") pending.push({ type: "user", content: e.content });
    else if (e.type === "tool_result") {
      pending.push({
        type: "tool_result",
        toolCallId: e.toolCallId,
        ...(e.command !== undefined && { command: e.command }),
        ...(e.exitCode !== undefined && { exitCode: e.exitCode }),
        output: e.outputExcerpt,
      });
    } else if (e.type === "model") {
      steps.push({ inputs: pending, turn: e });
      pending = [];
    }
  }

  let index = 0;
  return {
    next(input = []) {
      const step = steps[index];
      if (step === undefined) throw new ScriptExhaustedError(steps.length);
      if (strict) compare(index + 1, step.inputs, input);
      index++;
      const { content, toolCalls, tokens } = step.turn;
      return structuredClone({ content, toolCalls, ...(tokens !== undefined && { tokens }) });
    },
    get remaining() {
      return steps.length - index;
    },
  };
}

function compare(turn: number, recorded: readonly ScriptInput[], received: readonly ScriptInput[]): void {
  const n = Math.max(recorded.length, received.length);
  for (let i = 0; i < n; i++) {
    const want = recorded[i];
    const got = received[i];
    if (want === undefined) throw new ScriptDivergenceError(turn, `unexpected extra input[${i}] ${describe(got!)}`);
    if (got === undefined) throw new ScriptDivergenceError(turn, `missing input[${i}], expected ${describe(want)}`);
    if (want.type !== got.type) {
      throw new ScriptDivergenceError(turn, `input[${i}] is ${describe(got)}, expected ${describe(want)}`);
    }
    if (want.type === "user" && got.type === "user") {
      const content = redact(got.content);
      if (content !== want.content) throw mismatch(turn, i, "user content", want.content, content);
    } else if (want.type === "tool_result" && got.type === "tool_result") {
      if (got.toolCallId !== want.toolCallId) throw mismatch(turn, i, "toolCallId", want.toolCallId, got.toolCallId);
      if (got.command !== undefined && redact(got.command) !== want.command) {
        throw mismatch(turn, i, "command", want.command, redact(got.command));
      }
      if (got.exitCode !== undefined && got.exitCode !== want.exitCode) {
        throw mismatch(turn, i, "exitCode", want.exitCode, got.exitCode);
      }
      if (got.output !== undefined) {
        const output = toExcerpt(got.output).excerpt;
        if (output !== want.output) throw mismatch(turn, i, "output", want.output, output);
      }
    }
  }
}

function mismatch(turn: number, i: number, field: string, want: unknown, got: unknown): ScriptDivergenceError {
  return new ScriptDivergenceError(turn, `input[${i}] ${field} differs\n  recorded: ${show(want)}\n  received: ${show(got)}`);
}

function describe(input: ScriptInput): string {
  return input.type === "user" ? `user message ${show(input.content)}` : `tool result for "${input.toolCallId}"`;
}

function show(value: unknown): string {
  const s = value === undefined ? "(none)" : JSON.stringify(value);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
