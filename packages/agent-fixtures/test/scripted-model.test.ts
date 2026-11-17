import { describe, expect, it } from "vitest";
import {
  createScriptedModel,
  type Fixture,
  loadFixture,
  parseFixture,
  ScriptDivergenceError,
  ScriptExhaustedError,
  type ScriptInput,
} from "../src/index.js";
import { FAKE, SAMPLE } from "./helpers.js";

/** The inputs an agent loop would pass when replaying the sample fixture. */
const SAMPLE_INPUTS: ScriptInput[][] = [
  [{ type: "user", content: "pnpm typecheck fails in src/cart.ts, please fix it." }],
  [{ type: "tool_result", toolCallId: "call_1", exitCode: 2 }],
  [{ type: "tool_result", toolCallId: "call_2" }],
  [{ type: "tool_result", toolCallId: "call_3", command: "pnpm typecheck", exitCode: 0, output: "" }],
];

describe("scripted model", () => {
  it("replays the sample fixture in strict mode", () => {
    const model = createScriptedModel(loadFixture(SAMPLE), { strict: true });
    expect(model.remaining).toBe(4);
    const turns = SAMPLE_INPUTS.map((input) => model.next(input));
    expect(turns.map((t) => t.toolCalls.map((c) => c.name))).toEqual([["shell"], ["edit_file"], ["shell"], []]);
    expect(turns[3]?.content).toMatch(/typecheck` passes/);
    expect(model.remaining).toBe(0);
  });

  it("throws when the script runs out", () => {
    const model = createScriptedModel(loadFixture(SAMPLE));
    for (let i = 0; i < 4; i++) model.next();
    expect(() => model.next()).toThrow(ScriptExhaustedError);
    expect(() => model.next()).toThrow(/no more turns: the fixture recorded 4 model turn/);
  });

  it("ignores input when not strict", () => {
    const model = createScriptedModel(loadFixture(SAMPLE));
    expect(model.next([{ type: "user", content: "something else" }]).toolCalls[0]?.id).toBe("call_1");
  });

  it("reports a different user message", () => {
    const model = createScriptedModel(loadFixture(SAMPLE), { strict: true });
    const err = (() => {
      try {
        model.next([{ type: "user", content: "pnpm lint fails" }]);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ScriptDivergenceError);
    expect((err as ScriptDivergenceError).turn).toBe(1);
    expect((err as Error).message).toBe(
      'scripted model diverged before turn 1: input[0] user content differs\n  recorded: "pnpm typecheck fails in src/cart.ts, please fix it."\n  received: "pnpm lint fails"',
    );
    // A failed call does not advance the script.
    expect(model.remaining).toBe(4);
  });

  it.each<[string, ScriptInput[], RegExp]>([
    ["exit code", [{ type: "tool_result", toolCallId: "call_1", exitCode: 0 }], /input\[0\] exitCode differs\n {2}recorded: 2\n {2}received: 0/],
    ["tool call id", [{ type: "tool_result", toolCallId: "call_9" }], /input\[0\] toolCallId differs/],
    ["command", [{ type: "tool_result", toolCallId: "call_1", command: "pnpm tsc" }], /input\[0\] command differs/],
    ["output", [{ type: "tool_result", toolCallId: "call_1", output: "ok" }], /input\[0\] output differs/],
    ["missing input", [], /missing input\[0\], expected tool result for "call_1"/],
    ["input type", [{ type: "user", content: "hi" }], /input\[0\] is user message "hi", expected tool result for "call_1"/],
    [
      "extra input",
      [
        { type: "tool_result", toolCallId: "call_1" },
        { type: "user", content: "also" },
      ],
      /unexpected extra input\[1\] user message "also"/,
    ],
  ])("reports a divergent %s at turn 2", (_name, input, message) => {
    const model = createScriptedModel(loadFixture(SAMPLE), { strict: true });
    model.next(SAMPLE_INPUTS[0]);
    let error: unknown;
    try {
      model.next(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ScriptDivergenceError);
    expect((error as Error).message).toMatch(/^scripted model diverged before turn 2: /);
    expect((error as Error).message).toMatch(message);
  });

  it("compares live input after the same redaction the recorder applied", () => {
    const fixture: Fixture = parseFixture(
      [
        { type: "header", formatVersion: 1, recordedAt: 1, model: "m" },
        { type: "user", at: 2, content: "Use key [REDACTED:stripe_key]" },
        { type: "model", at: 3, content: "Done." },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const model = createScriptedModel(fixture, { strict: true });
    expect(model.next([{ type: "user", content: `Use key ${FAKE.stripeLive}` }]).content).toBe("Done.");
  });

  it("returns copies, so callers cannot change the script", () => {
    const fixture = loadFixture(SAMPLE);
    const a = createScriptedModel(fixture).next();
    a.toolCalls.length = 0;
    expect(createScriptedModel(fixture).next().toolCalls).toHaveLength(1);
  });
});
