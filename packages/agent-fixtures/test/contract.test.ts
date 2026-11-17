import { Message, SessionSummary } from "@kovach-dev/memory-contract";
import { describe, expect, it } from "vitest";
import { loadFixture, parseFixture, toContractSession } from "../src/index.js";
import { SAMPLE } from "./helpers.js";

describe("toContractSession", () => {
  it("produces a schema-valid session from the sample fixture", () => {
    const { session, messages } = toContractSession(loadFixture(SAMPLE), { sessionId: "s1" });

    expect(SessionSummary.parse(session)).toEqual(session);
    for (const m of messages) expect(Message.parse(m)).toEqual(m);

    expect(session).toEqual({
      id: "s1",
      projectId: "sample-cart",
      title: "Fix cart total type error",
      model: "qwen3.6-35b-a3b-4bit",
      status: "done",
      messageCount: 5,
      createdAt: 1767225600000,
      updatedAt: 1767225612100,
    });
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ["s1-m0", "user"],
      ["s1-m1", "assistant"],
      ["s1-m2", "assistant"],
      ["s1-m3", "assistant"],
      ["s1-m4", "assistant"],
    ]);
  });

  it("attaches tool results to the assistant message that requested them", () => {
    const { messages } = toContractSession(loadFixture(SAMPLE), { sessionId: "s1" });
    expect(messages[0]?.toolCalls).toEqual([]);
    expect(messages[1]?.toolCalls).toEqual([
      {
        id: "s1-t0",
        name: "shell",
        args: { command: "pnpm typecheck" },
        command: "pnpm typecheck",
        exitCode: 2,
        durationMs: 2870,
        outputExcerpt: "src/cart.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        createdAt: 1767225603000,
      },
    ]);
    expect(messages[2]?.toolCalls[0]).toMatchObject({ id: "s1-t1", name: "edit_file", durationMs: 12 });
    expect(messages[2]?.toolCalls[0]).not.toHaveProperty("exitCode");
    expect(messages[3]?.toolCalls[0]).toMatchObject({ id: "s1-t2", exitCode: 0, outputExcerpt: "" });
    expect(messages[1]).toMatchObject({ model: "qwen3.6-35b-a3b-4bit", tokens: 18, createdAt: 1767225603000 });
  });

  it("is deterministic", () => {
    const f = loadFixture(SAMPLE);
    expect(toContractSession(f, { sessionId: "x" })).toEqual(toContractSession(f, { sessionId: "x" }));
  });

  it("maps an incomplete recording to an open session", () => {
    const fixture = parseFixture(
      [
        { type: "header", formatVersion: 1, recordedAt: 10, model: "m" },
        { type: "user", at: 11, content: "build it" },
        { type: "model", at: 12, content: "Building.", toolCalls: [{ id: "c1", name: "shell", args: { command: "pnpm build" } }] },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const { session, messages } = toContractSession(fixture, { sessionId: "s2", title: "Build" });
    expect(session).toMatchObject({ status: "open", title: "Build", messageCount: 2, updatedAt: 12 });
    expect(session).not.toHaveProperty("projectId");
    expect(messages[1]?.toolCalls).toEqual([{ id: "s2-t0", name: "shell", args: { command: "pnpm build" }, createdAt: 12 }]);
  });
});
