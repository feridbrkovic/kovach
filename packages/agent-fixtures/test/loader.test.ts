import { describe, expect, it } from "vitest";
import { FixtureError, loadFixture, parseFixture } from "../src/index.js";
import { SAMPLE } from "./helpers.js";

const header = JSON.stringify({ type: "header", formatVersion: 1, recordedAt: 1, model: "m" });
const lines = (...rows: unknown[]) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

function errorOf(fn: () => unknown): FixtureError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FixtureError) return e;
    throw e;
  }
  throw new Error("expected a FixtureError");
}

describe("loader", () => {
  it("loads the sample fixture", () => {
    const f = loadFixture(SAMPLE);
    expect(f.complete).toBe(true);
    expect(f.header.model).toBe("qwen3.6-35b-a3b-4bit");
    expect(f.header.meta).toEqual({ title: "Fix cart total type error", synthetic: true });
    expect(f.events.map((e) => e.type)).toEqual([
      "user",
      "model",
      "tool_result",
      "model",
      "tool_result",
      "model",
      "tool_result",
      "model",
      "end",
    ]);
  });

  it("reports invalid JSON with its line number", () => {
    const e = errorOf(() => parseFixture(lines(header, { type: "user", at: 2, content: "hi" }, "{not json", { type: "end", at: 3 }), "x.jsonl"));
    expect(e.line).toBe(3);
    expect(e.message).toBe("x.jsonl:3: not valid JSON");
  });

  it("reports a schema error with line number and field", () => {
    const e = errorOf(() => parseFixture(lines(header, { type: "model", at: 2, content: 5 }), "x.jsonl"));
    expect(e.line).toBe(2);
    expect(e.message).toMatch(/^x\.jsonl:2: invalid "model" line: content: /);
  });

  it("rejects an unknown event type", () => {
    expect(() => parseFixture(lines(header, { type: "note", at: 2 }))).toThrow(/:2: invalid "note" line/);
  });

  it("requires the header first", () => {
    expect(() => parseFixture(lines({ type: "user", at: 2, content: "hi" }, header))).toThrow(/:1: first line must be the header/);
    expect(() => parseFixture("")).toThrow(/missing header/);
  });

  it("rejects an unsupported format version clearly", () => {
    const v2 = { type: "header", formatVersion: 2, recordedAt: 1, model: "m" };
    expect(() => parseFixture(lines(v2))).toThrow(/:1: unsupported fixture formatVersion 2 \(this loader reads 1\)/);
  });

  it("rejects events after end and unmatched tool results", () => {
    expect(() => parseFixture(lines(header, { type: "end", at: 2 }, { type: "user", at: 3, content: "x" }))).toThrow(/:3: "user" event after end/);
    const call = { type: "model", at: 2, content: "", toolCalls: [{ id: "c1", name: "shell" }] };
    const result = { type: "tool_result", at: 3, toolCallId: "c1", outputExcerpt: "" };
    expect(() => parseFixture(lines(header, call, result, result))).toThrow(/:4: tool result for "c1"/);
    // A result must answer the latest model turn.
    expect(() => parseFixture(lines(header, call, { type: "model", at: 3, content: "" }, result))).toThrow(/:4: tool result/);
  });

  it("rejects an output excerpt over 8 KB", () => {
    const call = { type: "model", at: 2, content: "", toolCalls: [{ id: "c1", name: "shell" }] };
    const result = { type: "tool_result", at: 3, toolCallId: "c1", outputExcerpt: "x".repeat(8193) };
    expect(() => parseFixture(lines(header, call, result))).toThrow(/:3: invalid "tool_result" line: outputExcerpt/);
  });

  it("ignores blank lines but not a broken line in the middle", () => {
    expect(parseFixture(`${header}\n\n${JSON.stringify({ type: "end", at: 2 })}\n\n`).complete).toBe(true);
    expect(() => parseFixture(`${header}\n{"type":"us\n${JSON.stringify({ type: "end", at: 2 })}`)).toThrow(/:2: not valid JSON/);
  });
});
