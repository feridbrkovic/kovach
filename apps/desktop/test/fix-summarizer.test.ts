import type { ChatModel, ChatRequest } from "@kovach-dev/agent";
import type { DetectedFix } from "@kovach-dev/memory-service";
import { describe, expect, it } from "vitest";
import { createFixSummarizer, createMemoryExtractor } from "../src/main/fix-summarizer";

const fix: DetectedFix = {
  key: "k",
  command: "npm test",
  verifiedBy: "test",
  errorSignature: "TypeError: Cannot read properties of undefined (reading 'map')",
  errorExcerpt: "TypeError: Cannot read properties of undefined (reading 'map')\n    at List (src/list.tsx:12:5)",
  files: ["src/list.tsx"],
  edits: [{ path: "src/list.tsx", change: "- items.map(\n+ (items ?? []).map(" }],
  attempts: [{ approach: "Changed src/list.tsx", outcome: "passed" }],
  failCallId: "a",
  passCallId: "b",
};

const model = (content: string, seen: ChatRequest[] = []): ChatModel => ({
  id: "qwen",
  async complete(req) {
    seen.push(req);
    return { content, toolCalls: [] };
  },
});

describe("fix summarizer", () => {
  it("asks the local model for strict JSON and returns problem, fix and lesson", async () => {
    const seen: ChatRequest[] = [];
    const s = createFixSummarizer(() =>
      model(JSON.stringify({ problem: "The list crashed on missing data.", fixSummary: "Defaulted items to [] in src/list.tsx.", lesson: "Default optional arrays before .map()." }), seen),
    );
    expect(await s(fix, { task: "Fix the list", stack: ["React Native 0.77"] })).toEqual({
      problem: "The list crashed on missing data.",
      fixSummary: "Defaulted items to [] in src/list.tsx.",
      lesson: "Default optional arrays before .map().",
    });
    expect(seen[0]!.jsonSchema?.name).toBe("fix_summary");
    const prompt = String(seen[0]!.messages.at(-1)!.content);
    expect(prompt).toContain("Command: npm test");
    expect(prompt).toContain("Stack: React Native 0.77");
    expect(prompt).toContain("(items ?? []).map(");
  });

  it("copes with text around the JSON, and fails clearly without a model or fields", async () => {
    const wrapped = createFixSummarizer(() => model('Here you go:\n{"problem":"p","fixSummary":"f","lesson":""}\nDone.'));
    expect(await wrapped(fix, { stack: [] })).toEqual({ problem: "p", fixSummary: "f" });
    await expect(createFixSummarizer(() => undefined)(fix, { stack: [] })).rejects.toThrow(/no model/);
    await expect(createFixSummarizer(() => model('{"problem":"p"}'))(fix, { stack: [] })).rejects.toThrow(/missing/);
  });
});

describe("memory extractor", () => {
  it("sends the service's prompt with its JSON schema and returns the raw answer for the service to gate", async () => {
    const seen: ChatRequest[] = [];
    const ex = createMemoryExtractor(() => model('{"candidates":[]}', seen));
    expect(await ex("Session:\n[m1] USER: hi")).toBe('{"candidates":[]}');
    expect(seen[0]!.jsonSchema?.name).toBe("memory_candidates");
    expect(seen[0]!.temperature).toBe(0); // the same session gives the same proposals
    expect(String(seen[0]!.messages.at(-1)!.content)).toContain("[m1] USER: hi");
    await expect(createMemoryExtractor(() => undefined)("x")).rejects.toThrow(/no model/);
  });
});
