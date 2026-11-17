import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecorder, FORMAT_VERSION, loadFixture, OUTPUT_EXCERPT_MAX, type Recorder } from "../src/index.js";
import { FAKE, stepClock, tempDir } from "./helpers.js";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

function recordSample(r: Recorder): void {
  r.user("Run the tests.");
  r.model({ content: "Running them.", toolCalls: [{ id: "c1", name: "shell", args: { command: "pnpm test" } }], tokens: 5 });
  r.toolResult({ toolCallId: "c1", command: "pnpm test", exitCode: 0, durationMs: 1200, output: "3 passed\n" });
  r.model({ content: "All 3 tests pass." });
}

describe("recorder", () => {
  it("round-trips record -> load", () => {
    const path = tmp.file("s.jsonl");
    const r = createRecorder({ path, header: { model: "qwen-test", projectId: "p1", meta: { task: "t" } }, now: stepClock() });
    recordSample(r);
    r.end();
    r.close();

    const fixture = loadFixture(path);
    expect(fixture.complete).toBe(true);
    expect(fixture.header).toEqual({
      type: "header",
      formatVersion: FORMAT_VERSION,
      recordedAt: 1000,
      model: "qwen-test",
      projectId: "p1",
      meta: { task: "t" },
    });
    expect(fixture.events).toEqual([
      { type: "user", at: 2000, content: "Run the tests." },
      { type: "model", at: 3000, content: "Running them.", toolCalls: [{ id: "c1", name: "shell", args: { command: "pnpm test" } }], tokens: 5 },
      { type: "tool_result", at: 4000, toolCallId: "c1", command: "pnpm test", exitCode: 0, durationMs: 1200, outputExcerpt: "3 passed\n" },
      { type: "model", at: 5000, content: "All 3 tests pass.", toolCalls: [] },
      { type: "end", at: 6000, status: "done" },
    ]);
  });

  it("writes byte-identical output for the same session", () => {
    const write = (name: string) => {
      const path = tmp.file(name);
      const r = createRecorder({ path, header: { model: "m" }, now: stepClock() });
      recordSample(r);
      r.end();
      r.close();
      return readFileSync(path, "utf8");
    };
    expect(write("a.jsonl")).toBe(write("b.jsonl"));
  });

  it("leaves a valid prefix when the session is never closed", () => {
    const path = tmp.file("crash.jsonl");
    const r = createRecorder({ path, header: { model: "m" }, now: stepClock() });
    r.user("Fix the build.");
    r.model({ content: "Checking.", toolCalls: [{ id: "c1", name: "shell", args: { command: "pnpm build" } }] });
    // No toolResult, end or close: the process "crashed" here.

    const fixture = loadFixture(path);
    expect(fixture.complete).toBe(false);
    expect(fixture.events.map((e) => e.type)).toEqual(["user", "model"]);
  });

  it("drops a torn final line left by a crash mid-write", () => {
    const path = tmp.file("torn.jsonl");
    const r = createRecorder({ path, header: { model: "m" }, now: stepClock() });
    r.user("hello");
    appendFileSync(path, '{"type":"model","at":3000,"cont');

    const fixture = loadFixture(path);
    expect(fixture.complete).toBe(false);
    expect(fixture.events).toHaveLength(1);
  });

  it("redacts every string it writes", () => {
    const path = tmp.file("secret.jsonl");
    const r = createRecorder({ path, header: { model: "m", meta: { remote: `https://u:${FAKE.password}@git.local/r` } }, now: stepClock() });
    r.user(`My key is ${FAKE.stripeLive}`);
    r.model({ content: "Setting it.", toolCalls: [{ id: "c1", name: "write_file", args: { path: ".env", body: `STRIPE_SECRET=${FAKE.password}` } }] });
    r.toolResult({ toolCallId: "c1", command: `echo ${FAKE.githubClassic}`, exitCode: 0, output: `${FAKE.privateKey}\n${FAKE.aws}` });
    r.end();
    r.close();

    const raw = readFileSync(path, "utf8");
    for (const secret of [FAKE.password, FAKE.stripeLive, FAKE.githubClassic, FAKE.aws, "PRIVATE KEY"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[REDACTED:stripe_key]");
    expect(raw).toContain("[REDACTED:private_key]");
  });

  it("caps output at the 8 KB excerpt, redacting before the cut", () => {
    const path = tmp.file("long.jsonl");
    const r = createRecorder({ path, header: { model: "m" }, now: stepClock() });
    r.model({ content: "", toolCalls: [{ id: "c1", name: "shell" }] });
    // The token straddles the 8 KB boundary.
    const output = "x".repeat(OUTPUT_EXCERPT_MAX - 10) + FAKE.githubClassic + "y".repeat(5000);
    r.toolResult({ toolCallId: "c1", output });
    r.close();

    const result = loadFixture(path).events[1];
    expect(result?.type).toBe("tool_result");
    if (result?.type !== "tool_result") return;
    expect(result.outputExcerpt.length).toBeLessThanOrEqual(OUTPUT_EXCERPT_MAX);
    expect(result.outputTruncated).toBe(true);
    expect(result.outputExcerpt).not.toContain("ghp_");
    expect(result.outputExcerpt.endsWith("[REDACTED:github_token]".slice(0, 10))).toBe(true);
  });

  it("rejects out-of-order events without writing them", () => {
    const path = tmp.file("order.jsonl");
    const r = createRecorder({ path, header: { model: "m" }, now: stepClock() });
    expect(() => r.toolResult({ toolCallId: "nope", output: "" })).toThrow(/did not request/);
    r.end();
    expect(() => r.user("late")).toThrow(/after end/);
    expect(() => r.end()).toThrow(/already/);
    r.close();
    r.close();
    expect(() => r.user("closed")).toThrow(/closed/);
    expect(loadFixture(path).events.map((e) => e.type)).toEqual(["end"]);
  });

  it("validates the header before creating the file", () => {
    const path = tmp.file("bad.jsonl");
    expect(() => createRecorder({ path, header: { model: "" } })).toThrow(/invalid header: model/);
    expect(existsSync(path)).toBe(false);
  });
});
