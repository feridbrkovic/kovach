import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, createHistoryStore, type Db, type HistoryStore, migrate, openDatabase } from "@kovach-dev/memory-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isAnnouncement,
  isPlanEcho,
  isToolName,
  numberDiff,
  reviewMessages,
  unifiedDiff,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
  type ApprovalRequest,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  runAgentTask,
  type SessionRecorder,
  SYSTEM_PROMPT,
  Workspace,
} from "../src/index.js";

// A tiny project: "typecheck" fails while src/cart.js still returns a string.
const CART = "export function total(items) {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum.toFixed(2);\n}\n";
const CHECK = `import { readFileSync } from "node:fs";
const src = readFileSync("src/cart.js", "utf8");
if (src.includes("toFixed")) {
  console.error("src/cart.js(3,3): error TS2322: Type 'string' is not assignable to type 'number'.");
  process.exit(2);
}
console.log("ok");
`;

let dir: string;
let ws: Workspace;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-loop-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/cart.js"), CART);
  writeFileSync(join(dir, "check.mjs"), CHECK);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { typecheck: "node check.mjs" } }));
  writeFileSync(join(dir, ".env"), "STRIPE_KEY=sk_test_123");
  ws = new Workspace(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Step = ChatResponse | ((req: ChatRequest) => ChatResponse);

/** A model that replays scripted responses and remembers what it was asked. */
function scripted(steps: Step[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "scripted",
    requests,
    async complete(req) {
      requests.push(structuredClone({ ...req, signal: undefined, onProgress: undefined }));
      const step = steps.shift();
      if (!step) throw new Error("script ran out");
      return typeof step === "function" ? step(req) : step;
    },
  };
}

let n = 0;
const call = (name: string, args: unknown): ChatResponse => ({
  content: "",
  toolCalls: [{ id: `c${++n}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }],
});
const say = (content: string): ChatResponse => ({ content, toolCalls: [] });
const planJson = (steps: string[]) =>
  say(JSON.stringify({ summary: "Return a number from total()", steps: steps.map((title) => ({ title, files: ["src/cart.js"] })) }));

const FIX = { path: "src/cart.js", edits: [{ old: "  return sum.toFixed(2);", new: "  return Math.round(sum * 100) / 100;" }] };
const WRONG_FIX = { path: "src/cart.js", edits: [{ old: "toFixed(2)", new: "toFixed(3)" }] };

const approveAll = async () => true;

function run(model: ChatModel, extra: Partial<AgentOptions> = {}) {
  const events: AgentEvent[] = [];
  const promise = runAgentTask({
    model,
    workspace: ws,
    task: "pnpm typecheck fails in src/cart.js, please fix it.",
    approve: approveAll,
    plan: false,
    review: false,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { promise, events };
}

describe("agent loop", () => {
  let db: Db;
  let history: HistoryStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    history = createHistoryStore(db, { blobs: new BlobStore(dir) });
  });
  afterEach(() => db.close());

  it("plans, reads, edits, checks and finishes, recording every step in history", async () => {
    const model = scripted([
      planJson(["Change total() to return a number", "Run the typecheck"]),
      call("read_file", { path: "src/cart.js" }),
      call("edit_file", FIX),
      call("run_checks", {}),
      say("Fixed: total() in src/cart.js now returns a number; typecheck passes."),
    ]);
    const session = history.createSession({ title: "Fix cart" });
    const recorder: SessionRecorder = history; // the real store fits the recorder interface
    const { promise, events } = run(model, { plan: true, history: { recorder, sessionId: session.id } });
    const outcome = await promise;

    expect(outcome).toMatchObject({ status: "done", edited: true, turns: 4 });
    expect(outcome.plan?.steps).toHaveLength(2);
    expect(outcome.checks?.[0]).toMatchObject({ exitCode: 0, check: { kind: "typecheck", command: "npm run typecheck" } });
    expect(readFileSync(join(dir, "src/cart.js"), "utf8")).toContain("Math.round(sum * 100) / 100");

    // The plan was asked for with a JSON schema; work requests carried the tools.
    expect(model.requests[0]!.jsonSchema?.name).toBe("plan");
    expect(model.requests[1]!.tools?.map((t) => t.name)).toContain("edit_file");
    // read_file output reached the model with line numbers.
    expect(model.requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("    3|   return sum.toFixed(2);") });

    expect(events.map((e) => e.type)).toEqual([
      "plan",
      "thinking", "tool_start", "tool",
      "thinking", "tool_start", "tool",
      "thinking", "tool_start", "checks", "tool",
      "thinking", "assistant", "done",
    ]);

    const stored = (await history.getSession(session.id)).messages.items;
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "assistant", "assistant", "assistant"]);
    expect(stored[1]!.content).toMatch(/^Plan: /);
    const calls = stored.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => [c.name, c.exitCode])).toEqual([
      ["read_file", 0],
      ["edit_file", 0],
      ["run_checks", 0],
    ]);
    expect(stored.at(-1)!.model).toBe("scripted");
  });

  it("won't finish while checks are red: sends the failure back until the fix passes", async () => {
    const model = scripted([
      call("edit_file", WRONG_FIX),
      say("Done."), // still red → pushed back
      call("edit_file", { path: "src/cart.js", edits: [{ old: "  return sum.toFixed(3);", new: "  return Math.round(sum * 100) / 100;" }] }),
      say("Done, for real."),
    ]);
    const session = history.createSession();
    const { promise } = run(model, { history: { recorder: history, sessionId: session.id } });
    const outcome = await promise;

    expect(outcome.status).toBe("done");
    expect(outcome.message).toBe("Done, for real.");
    const nudge = model.requests[2]!.messages.at(-1)!;
    expect(nudge).toMatchObject({ role: "user" });
    expect(nudge.content).toMatch(/can't finish yet[\s\S]*FAILED \(exit 2\)[\s\S]*TS2322/);

    // Both check runs are in history, red then green: the data fail-to-pass detection needs.
    const checkCalls = (await history.getSession(session.id)).messages.items
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.toolCalls);
    expect(checkCalls.map((c) => [c.name, c.command, c.exitCode])).toEqual([
      ["check", "npm run typecheck", 2],
      ["check", "npm run typecheck", 0],
    ]);
  });

  it("gives up after the allowed check rounds, or finishes red only when the user allows it", async () => {
    const stubborn = () => scripted([call("edit_file", WRONG_FIX), say("Done."), say("Done."), say("Done.")]);
    const failed = await run(stubborn(), { maxCheckRounds: 1 }).promise;
    expect(failed.status).toBe("checks_failed");
    expect(failed.message).toMatch(/still fail after 1 attempts/);

    writeFileSync(join(dir, "src/cart.js"), CART);
    const allowed = await run(stubborn(), { allowFailingChecks: true }).promise;
    expect(allowed.status).toBe("done_with_failing_checks");
  });

  it("doesn't run checks when nothing was edited", async () => {
    const model = scripted([call("search", { pattern: "toFixed", glob: "src/**" }), say("total() uses toFixed on line 3.")]);
    const approvals: ApprovalRequest[] = [];
    const outcome = await run(model, { approve: async (r) => (approvals.push(r), true) }).promise;
    expect(outcome).toMatchObject({ status: "done", edited: false });
    expect(outcome.checks).toBeUndefined();
    expect(approvals).toEqual([]);
    expect(model.requests[1]!.messages.at(-1)!.content).toBe(
      "src/cart.js:3:   return sum.toFixed(2);\n\nThis is a text match. For toFixed as a symbol, find_symbol gives its definitions and find_references the uses of each one exactly.",
    );
  });

  it("asks once to carry out the plan when the model only writes it out again, or says nothing", async () => {
    const model = scripted([
      planJson(["Find total()", "Answer"]),
      say("Plan: Find total() and answer\n1. Find total() (src/cart.js)\n2. Answer"),
      call("search", { pattern: "function total" }),
      say("total() is defined in src/cart.js on line 1."),
    ]);
    const outcome = await run(model, { plan: true }).promise;
    expect(outcome).toMatchObject({ status: "done", message: "total() is defined in src/cart.js on line 1." });
    expect(model.requests[2]!.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/^That restates the plan/) });

    const empty = scripted([say(""), say("Nothing to change here.")]);
    expect(await run(empty).promise).toMatchObject({ status: "done", message: "Nothing to change here." });
    expect(empty.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "Your reply was empty. Use the tools to do the task, then give your answer." });

    // Only once: a second echo ends the run rather than looping.
    const stubborn = scripted([planJson(["A"]), say("Plan: A\n1. A"), say("Plan: A\n1. A")]);
    expect(await run(stubborn, { plan: true }).promise).toMatchObject({ status: "done", message: "Plan: A\n1. A" });
  });

  it("asks once to do the step the model only announced", async () => {
    const model = scripted([
      say("Let me check the existing money-related code to determine the convention for this project."),
      call("search", { pattern: "toFixed" }),
      say("Store it as integer cents, like the other prices."),
    ]);
    const outcome = await run(model).promise;
    expect(outcome).toMatchObject({ status: "done", message: "Store it as integer cents, like the other prices." });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "You said what you'd do next but stopped. Do it now with the tools, then give your answer." });
  });

  it("asks once for a real answer when the reply is only a tool's name; short real answers stand", async () => {
    const model = scripted([say("Search"), call("search", { pattern: "toFixed" }), say("Integer cents.")]);
    expect(await run(model).promise).toMatchObject({ status: "done", message: "Integer cents." });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "That isn't an answer yet. Use the tools if you need them, then answer in full." });
    expect(model.requests).toHaveLength(3);

    const chat = scripted([say("You're welcome!")]);
    expect(await run(chat).promise).toMatchObject({ status: "done", message: "You're welcome!" });
    expect(chat.requests).toHaveLength(1);
    const names = [{ name: "search" }, { name: "read_file" }, { name: "run_checks" }];
    expect(["Search", "read_file", "Read file.", "**Read**", "run"].map((w) => isToolName(w, names))).toEqual([true, true, true, true, true]);
    expect(["Yes.", "Search done.", "pnpm", ""].map((w) => isToolName(w, names))).toEqual([false, false, false, false]);
  });

  it("tells an announcement from an answer", () => {
    expect(isAnnouncement("Let me check the existing money-related code to determine the convention for this project.")).toBe(true);
    expect(isAnnouncement("Good. Now I'll run the tests to verify the fix.")).toBe(true);
    expect(isAnnouncement("I'm going to read src/cart.js first:")).toBe(true);
    expect(isAnnouncement("Sada ću pokrenuti testove.")).toBe(true);
    expect(isAnnouncement("Store it as integer cents. Let me know if you want a migration too.")).toBe(false);
    expect(isAnnouncement("Prices are integer cents in src/shop.js, so store the fee the same way.")).toBe(false);
    expect(isAnnouncement(`Here is the fix:\n\n\`\`\`js\nreturn a;\n\`\`\`\nLet me know.`)).toBe(false);
    expect(isAnnouncement("Done. The tagline is updated. Tests pass. I'll leave the rest as it is.")).toBe(false);
  });

  it("tells a plan echo from an answer that merely contains steps", () => {
    expect(isPlanEcho("Plan: Find it\n1. Search\n2. Answer")).toBe(true);
    expect(isPlanEcho("**Plan:** Find it\n\n1. Search")).toBe(true);
    expect(isPlanEcho("To fix it:\n1. Edit cart.js\n2. Run tests")).toBe(false);
    expect(isPlanEcho("Plan: done.\n1. Edited cart.js\n\nAll checks pass, total() now returns a number.")).toBe(false);
  });

  it("adds no symbol hint to a search for text that isn't a name", async () => {
    const model = scripted([call("search", { pattern: "toFixed\\(2\\)" }), say("Found it.")]);
    await run(model).promise;
    expect(model.requests[1]!.messages.at(-1)!.content).toBe("src/cart.js:3:   return sum.toFixed(2);");
  });

  it("sends invalid tool calls back as errors and stops after two retries", async () => {
    const model = scripted([
      call("delete_everything", {}),
      call("read_file", "{not json"),
      call("read_file", { path: 42 }),
      say("unreachable"),
    ]);
    const { promise, events } = run(model);
    const outcome = await promise;
    expect(outcome.status).toBe("error");
    expect(outcome.message).toMatch(/invalid tool calls 3 turns in a row/);
    expect(model.requests).toHaveLength(3); // the model is not asked a fourth time
    const errors = events.flatMap((e) => (e.type === "tool" ? [e.summary] : []));
    expect(errors[0]).toMatch(/Unknown tool "delete_everything"/);
    expect(errors[1]).toMatch(/not valid JSON/);
    expect(errors[2]).toMatch(/Invalid arguments for read_file: path:/);
    // The first two errors went back to the model.
    expect(model.requests[1]!.messages.at(-1)!.content).toBe(errors[0]);
  });

  it("a valid call resets the invalid-call count", async () => {
    const model = scripted([
      call("nope", {}),
      call("nope", {}),
      call("list_files", {}),
      call("nope", {}),
      say("Listed the files."),
    ]);
    expect((await run(model).promise).status).toBe("done");
  });

  it("lets a new section of up to 400 lines be added after an unchanged line, but not more", async () => {
    const section = (n: number) => Array.from({ length: n }, (_, i) => `// added ${i}`).join("\n");
    const anchor = "  return sum.toFixed(2);";
    const model = scripted([
      call("edit_file", { path: "src/cart.js", edits: [{ old: anchor, new: `${anchor}\n${section(300)}` }] }),
      call("edit_file", { path: "src/cart.js", edits: [{ old: "// added 299", new: `// added 299\n${section(500)}` }] }),
      say("Added the first part; the second is too big for one step."),
    ]);
    const outcome = await run(model).promise;
    expect(String(model.requests[1]!.messages.at(-1)!.content)).toBe("Edited src/cart.js (300 lines added).");
    expect(String(model.requests[2]!.messages.at(-1)!.content)).toMatch(/adds 500 new lines; the limit for new content per step is 400/);
    expect(readFileSync(join(dir, "src/cart.js"), "utf8").split("\n")).toHaveLength(CART.split("\n").length + 300);
    expect(outcome).toMatchObject({ edited: true });
  });

  it("rejects edits over the per-step line limit and leaves the file alone", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `// line ${i}`).join("\n");
    const model = scripted([
      call("edit_file", { path: "src/cart.js", edits: [{ old: "  return sum.toFixed(2);", new: big }] }),
      say("I'll split it."),
      say("The change is too large for one step; it needs to be split into smaller edits."),
    ]);
    const outcome = await run(model).promise;
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/limit per step is 150/);
    expect(readFileSync(join(dir, "src/cart.js"), "utf8")).toBe(CART);
    expect(outcome).toMatchObject({ status: "done", edited: false });
  });

  it("asks before every command and respects a no", async () => {
    const asked: ApprovalRequest[] = [];
    const model = scripted([call("run_command", { command: "rm -rf src" }), call("run_command", { command: "echo hello" }), say("ok")]);
    await run(model, {
      approve: async (r) => {
        asked.push(r);
        return r.command.startsWith("echo");
      },
    }).promise;
    expect(asked.map((a) => [a.kind, a.command])).toEqual([
      ["command", "rm -rf src"],
      ["command", "echo hello"],
    ]);
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/declined/);
    expect(model.requests[2]!.messages.at(-1)!.content).toMatch(/^exit 0\nhello/);
    expect(readFileSync(join(dir, "src/cart.js"), "utf8")).toBe(CART);
  });

  it("keeps secrets files out of reach", async () => {
    const model = scripted([call("read_file", { path: ".env" }), call("search", { pattern: "sk_test" }), say("Can't read it.")]);
    await run(model).promise;
    expect(model.requests[1]!.messages.at(-1)!.content).toMatch(/secrets file/);
    expect(model.requests[2]!.messages.at(-1)!.content).toMatch(/^No matches\./);
  });

  it("works without a plan when the model can't produce a valid one", async () => {
    const model = scripted([say("sure, here is my plan: step one…"), say('{"summary":"x","steps":[]}'), say("Nothing to change.")]);
    const outcome = await run(model, { plan: true }).promise;
    expect(outcome.plan).toBeUndefined();
    expect(outcome.status).toBe("done");
  });

  it("stops at the turn limit, on abort, and when the model server fails", async () => {
    const loop = scripted(Array.from({ length: 5 }, () => call("list_files", {})));
    expect((await run(loop, { maxTurns: 3 }).promise).status).toBe("max_turns");

    const controller = new AbortController();
    const aborting = scripted([
      () => {
        controller.abort();
        return call("list_files", {});
      },
    ]);
    expect((await run(aborting, { signal: controller.signal }).promise).status).toBe("aborted");

    const broken: ChatModel = {
      id: "broken",
      complete: async () => {
        throw new Error("model server unreachable at http://127.0.0.1:8000/v1");
      },
    };
    const outcome = await run(broken).promise;
    expect(outcome).toMatchObject({ status: "error", message: expect.stringContaining("unreachable") });
  });
});

describe("images in the loop", () => {
  const png = (tag: string) => ({ type: "image" as const, mediaType: "image/png" as const, data: tag });
  let shots = 0;
  const camera = {
    name: "snap",
    description: "takes a picture",
    schema: z.object({}),
    async run() {
      return { ok: true, content: "snapped", images: [png(`img${++shots}`)] };
    },
  } as unknown as AgentTool;
  beforeEach(() => {
    shots = 0;
  });
  const imagesIn = (msgs: ChatRequest["messages"]) =>
    msgs.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((p) => (p.type === "image" ? [p.data] : [])) : []));

  it("sends pasted images with the task and shows tool images to the model in a user turn", async () => {
    const model = scripted([call("snap", {}), { content: "Done.", toolCalls: [] }]);
    const out = await runAgentTask({
      model,
      workspace: ws,
      task: [{ type: "text", text: "What is on screen?" }, png("pasted")],
      approve: async () => true,
      plan: false,
      checks: [],
      tools: [camera],
    });
    expect(out.status).toBe("done");
    expect(model.requests[0]!.messages.at(-1)!.content).toEqual([{ type: "text", text: "What is on screen?" }, png("pasted")]);
    const second = model.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "tool", content: "snapped" });
    expect(second.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Image from snap:" }, png("img1")] });
  });

  it("keeps only the newest tool images, never the ones the user pasted", async () => {
    const model = scripted([call("snap", {}), call("snap", {}), call("snap", {}), { content: "Done.", toolCalls: [] }]);
    await runAgentTask({
      model,
      workspace: ws,
      task: [{ type: "text", text: "Watch" }, png("pasted")],
      approve: async () => true,
      plan: false,
      checks: [],
      tools: [camera],
      keepImages: 2,
    });
    const msgs = model.requests.at(-1)!.messages;
    expect(imagesIn(msgs)).toEqual(["pasted", "img2", "img3"]);
    expect(JSON.stringify(msgs)).toContain("[earlier image removed to save context]");
  });
});

describe("recall on failure", () => {
  it("adds fixes seen before to a failing command's result, and keeps history raw", async () => {
    const seen: string[] = [];
    const outputs: string[] = [];
    const recorder = {
      appendMessage: (_s: string, m: { toolCalls?: unknown[] }) => ({ toolCalls: (m.toolCalls ?? []).map((_c, i) => ({ id: `t${i}` })) }) as never,
      completeToolCall: (_id: string, r: { output?: string }) => (outputs.push(r.output ?? ""), {}) as never,
    } as unknown as SessionRecorder;
    const model = scripted([
      { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "node -e \"console.error('TypeError: x is undefined'); process.exit(3)\"" }) }] },
      { content: "", toolCalls: [{ id: "c2", name: "run_command", arguments: JSON.stringify({ command: "node -e \"process.exit(0)\"" }) }] },
      { content: "Done.", toolCalls: [] },
    ]);
    await runAgentTask({
      model,
      workspace: ws,
      task: "Fix it",
      approve: async () => true,
      plan: false,
      checks: [],
      history: { recorder, sessionId: "s1" },
      recall: async (err) => (seen.push(err), err.includes("TypeError") ? "- [e:abc123] (lesson, verified) Guard undefined values before use." : undefined),
    });
    const toolMsgs = model.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(String(toolMsgs.at(-1)!.content)).toMatch(/Seen this error before \(from memory; check it applies here\):\n- \[e:abc123\]/);
    expect(seen).toHaveLength(1); // only for the failure
    expect(outputs[0]).not.toMatch(/Seen this error before/);
    const passing = model.requests[2]!.messages.filter((m) => m.role === "tool").at(-1)!;
    expect(String(passing.content)).not.toMatch(/Seen this error/);
  });
});

describe("memory", () => {
  it("puts the always-on block in the system prompt and recalled notes in the model's copy of the task only", async () => {
    const model = scripted([{ content: "Done [m:abc123].", toolCalls: [] }]);
    const appended: string[] = [];
    const recorder = {
      appendMessage: (_s: string, m: { role: string; content: string }) => {
        appended.push(`${m.role}:${m.content}`);
        return { toolCalls: [] } as never;
      },
      completeToolCall: () => ({}) as never,
    } as unknown as SessionRecorder;
    await runAgentTask({
      model,
      workspace: ws,
      task: "Add a cart badge",
      approve: async () => true,
      plan: false,
      checks: [],
      memory: { system: "<memory>\n- [m:abc123] style: no semicolons\n</memory>", task: "<recalled>\n- [m:def456] state: zustand\n</recalled>" },
      history: { recorder, sessionId: "s1" },
    });
    const msgs = model.requests[0]!.messages;
    expect(msgs[0]!.content).toMatch(/<memory>\n- \[m:abc123\] style: no semicolons\n<\/memory>$/);
    expect(msgs.at(-1)!.content).toBe("Add a cart badge\n\n<recalled>\n- [m:def456] state: zustand\n</recalled>");
    expect(appended[0]).toBe("user:Add a cart badge"); // history keeps the user's words
  });

  it("adds recalled notes to the text part when the task has images", async () => {
    const model = scripted([{ content: "ok", toolCalls: [] }]);
    const img = { type: "image" as const, mediaType: "image/png" as const, data: "AA" };
    await runAgentTask({ model, workspace: ws, task: [{ type: "text", text: "Build this" }, img], approve: async () => true, plan: false, checks: [], memory: { task: "<recalled>x</recalled>" } });
    expect(model.requests[0]!.messages.at(-1)!.content).toEqual([{ type: "text", text: "Build this\n\n<recalled>x</recalled>" }, img]);
  });

  it("memory tools search, and save only after the user approves", async () => {
    const { memoryTools } = await import("../src/index.js");
    const saved: unknown[] = [];
    const tools = memoryTools({
      searchMemory: async (q) => (q === "tabs" ? "- [m:aaa111] style.indent: tabs" : ""),
      searchHistory: async () => "",
      remember: async (input) => {
        saved.push(input);
        return "Saved.";
      },
    });
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    const asked: ApprovalRequest[] = [];
    const ctx = (ok: boolean) => ({ workspace: ws, approve: async (r: ApprovalRequest) => (asked.push(r), ok) }) as never;
    expect((await byName("search_memory").run({ query: "tabs" }, ctx(true))).content).toContain("style.indent");
    expect((await byName("search_history").run({ query: "nothing" }, ctx(true))).content).toBe("No earlier conversation matches that.");
    const args = { kind: "preference", scope: "global", key: "style.quotes", body: "Single quotes" };
    expect(await byName("remember").run(args, ctx(false))).toMatchObject({ ok: false });
    expect(saved).toEqual([]);
    expect(await byName("remember").run(args, ctx(true))).toMatchObject({ ok: true, content: "Saved." });
    expect(saved).toEqual([args]);
    expect(asked[0]).toMatchObject({ kind: "memory", command: "Remember for all projects (preference) style.quotes: Single quotes" });
    expect(tools.map((t) => t.name)).not.toContain("search_docs"); // no docs backend, no tool
  });

  it("tells the model which OS it runs on and where it can write, so it doesn't guess paths", () => {
    const scratch = SYSTEM_PROMPT([], { scratch: true, platform: "darwin" });
    expect(scratch).toContain("The machine runs macOS.");
    expect(scratch).toMatch(/can't create or change files anywhere else \(not the Desktop/);
    expect(scratch).toMatch(/tell them to start a session with that folder as the project/);
    expect(scratch).toContain("never absolute, home (~) or Windows (C:\\) paths");
    const project = SYSTEM_PROMPT([], { platform: "linux" });
    expect(project).toContain("The machine runs Linux. Every path you use is relative to the project root");
  });

  it("tells the model to verify notes marked possibly outdated against current docs (T5)", async () => {
    const model = scripted([{ content: "ok", toolCalls: [] }]);
    await runAgentTask({
      model,
      workspace: ws,
      task: "Tune the list",
      approve: async () => true,
      plan: false,
      checks: [],
      promptExtras: { memory: true },
      memory: { task: "<recalled>\n- [m:abc123] (research, user, possibly outdated) flatlist.window: FlatList windowSize defaults to 21.\n</recalled>" },
    });
    const sys = String(model.requests[0]!.messages[0]!.content);
    expect(sys).toMatch(/possibly outdated" was written for another version of a library: check the current docs \(search_docs, or the web\)/);
    // A memory the code contradicts is raised with the user, not silently followed or dropped.
    expect(sys).toMatch(/disagrees with a memory, don't quietly follow either one: say so in your answer, cite the memory, and ask which is right/);
    expect(String(model.requests[0]!.messages.at(-1)!.content)).toContain("possibly outdated) flatlist.window");
  });

  it("searches the project's docs when the host provides them", async () => {
    const { memoryTools } = await import("../src/index.js");
    const calls: [string, string | undefined][] = [];
    const tools = memoryTools({
      searchMemory: async () => "",
      searchHistory: async () => "",
      remember: async () => "",
      searchDocs: async (q, lib) => (calls.push([q, lib]), q === "flatlist" ? "- [d:abc123] React Native 0.77 docs — FlatList" : ""),
    });
    const docs = tools.find((t) => t.name === "search_docs")!;
    const ctx = { workspace: ws, approve: async () => true } as never;
    expect((await docs.run({ query: "flatlist", library: "react-native" }, ctx)).content).toContain("[d:abc123]");
    expect((await docs.run({ query: "nothing here" }, ctx)).content).toMatch(/No docs match/);
    expect(calls).toEqual([["flatlist", "react-native"], ["nothing here", undefined]]);
  });
});

describe("what the reviewer reads", () => {
  it("numbers each diff line by its line in the new file, blank for removed lines", () => {
    const before = "-- setup\nselect 1;\nselect 2;\n";
    const after = "select 1;\nselect 2;\n--- note\n";
    const numbered = numberDiff(unifiedDiff("q.sql", before, after));
    expect(numbered).toBe(
      ["--- a/q.sql", "+++ b/q.sql", "@@ -1,3 +1,3 @@", "   | --- setup", " 1 |  select 1;", " 2 |  select 2;", " 3 | +--- note", ""].join("\n"),
    );
    // A new file is numbered from 1 to its last line.
    const created = numberDiff(unifiedDiff("a.txt", null, "x\ny\n")).split("\n");
    expect(created.filter(Boolean).slice(-2)).toEqual([" 1 | +x", " 2 | +y"]);
  });

  it("shows a large change in full, and says plainly when a huge one is clipped", () => {
    const page = Array.from({ length: 420 }, (_, i) => `<p class="row">line ${i + 1} of a long landing page</p>`).join("\n");
    const big = reviewMessages({ task: "t", diff: unifiedDiff("index.html", null, page), checks: "" })[1]!.content as string;
    expect(big).toContain("420 | +<p class=\"row\">line 420 of a long landing page</p>");
    expect(big).not.toContain("clipped");
    const huge = reviewMessages({ task: "t", diff: unifiedDiff("big.html", null, `${page}\n`.repeat(4)), checks: "" })[1]!.content as string;
    expect(huge).toMatch(/\[diff clipped: \d+ more characters of the change are not shown\]/);
  });
});

describe("self-review before finishing", () => {
  let db: Db;
  let history: HistoryStore;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    history = createHistoryStore(db, { blobs: new BlobStore(dir) });
  });
  afterEach(() => db.close());

  const issues = (list: unknown[]) => say(JSON.stringify({ issues: list }));
  const ROUND = { path: "src/cart.js", edits: [{ old: "  return Math.round(sum * 100) / 100;", new: "  return Math.round(sum * 100) / 100; // ok" }] };

  it("sends must-fix findings back once; the reviewer sees only the task, the diff and the checks", async () => {
    const reviewer = scripted([issues([{ file: "src/cart.js", line: 3, severity: "must_fix", problem: "Empty carts return NaN.", fix: "Default items to []." }])]);
    const model = scripted([
      call("read_file", { path: "src/cart.js" }),
      call("edit_file", FIX),
      call("run_checks", {}),
      say("Fixed total()."),
      call("edit_file", ROUND),
      call("run_checks", {}),
      say("Fixed total(); empty carts are handled."),
    ]);
    const session = history.createSession({ title: "Fix cart" });
    const { promise, events } = run(model, { review: true, reviewModel: reviewer, history: { recorder: history, sessionId: session.id } });
    const outcome = await promise;
    expect(outcome).toMatchObject({ status: "done", message: "Fixed total(); empty carts are handled." });

    // One review only, even though the agent edited again after it.
    expect(reviewer.requests).toHaveLength(1);
    const [sys, user] = reviewer.requests[0]!.messages;
    expect(sys).toMatchObject({ role: "system", content: expect.stringMatching(/^You review a code change someone else made/) });
    const seen = String(user!.content);
    expect(seen).toMatch(/^Task:\npnpm typecheck fails in src\/cart\.js, please fix it\.\n\nDiff:\n--- a\/src\/cart\.js\n\+\+\+ b\/src\/cart\.js\n@@ -1,4 \+1,4 @@/);
    expect(seen).toMatch(/ \| - {2}return sum\.toFixed\(2\);\n *3 \| \+ {2}return Math\.round\(sum \* 100\) \/ 100;/);
    expect(seen).toContain("Checks:\ntypecheck:");
    // Fresh context: none of the agent's own conversation.
    expect(seen).not.toMatch(/read_file|Fixed total\(\)/);
    expect(reviewer.requests[0]!.temperature).toBe(0);

    // The agent was told what to fix, as a note from the loop.
    const told = model.requests[4]!.messages.at(-1)!;
    expect(told).toMatchObject({ role: "user" });
    expect(String(told.content)).toBe(
      "A review of your change (by a reviewer who saw only the task, the diff and the checks) found:\n1. src/cart.js:3: Empty carts return NaN. Fix: Default items to [].\n\nFix each one, or, if a finding is wrong, say why in one sentence. Then finish with your summary.",
    );
    expect(events.find((e) => e.type === "review")).toEqual({ type: "review", issues: [expect.objectContaining({ severity: "must_fix" })] });

    // History shows the review as a step, and nothing the loop wrote is stored as the user's words.
    const detail = { messages: (await history.getSession(session.id)).messages.items };
    const review = detail.messages.find((m) => m.toolCalls.some((c) => c.name === "self_review"))!;
    expect(review).toMatchObject({ role: "tool", content: "Review before finishing" });
    expect(review.toolCalls[0]).toMatchObject({ exitCode: 1, args: { files: ["src/cart.js"] } });
    expect(detail.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["pnpm typecheck fails in src/cart.js, please fix it."]);
  });

  it("finishes right away when the review finds nothing, or only suggestions", async () => {
    for (const answer of [issues([]), issues([{ file: "src/cart.js", severity: "suggestion", problem: "Could name sum total." }])]) {
      const reviewer = scripted([answer]);
      const model = scripted([call("edit_file", FIX), call("run_checks", {}), say("Fixed.")]);
      const { promise, events } = run(model, { review: true, reviewModel: reviewer });
      expect(await promise).toMatchObject({ status: "done", message: "Fixed." });
      expect(model.requests).toHaveLength(3);
      expect(events.some((e) => e.type === "tool" && e.name === "self_review" && e.ok)).toBe(true);
      writeFileSync(join(dir, "src/cart.js"), CART);
    }
  });

  it("doesn't review runs that changed nothing, when turned off, or block on a failing reviewer", async () => {
    const reviewer = scripted([]);
    expect(await run(scripted([say("Nothing to change.")]), { review: true, reviewModel: reviewer }).promise).toMatchObject({ status: "done" });
    expect(await run(scripted([call("edit_file", FIX), call("run_checks", {}), say("Fixed.")]), { review: false, reviewModel: reviewer }).promise).toMatchObject({ status: "done" });
    expect(reviewer.requests).toHaveLength(0);
    writeFileSync(join(dir, "src/cart.js"), CART);
    // A reviewer that errors or answers off-schema doesn't hold the run up.
    for (const broken of [scripted([]), scripted([say("Looks good to me!")])]) {
      const { promise, events } = run(scripted([call("edit_file", FIX), call("run_checks", {}), say("Fixed.")]), { review: true, reviewModel: broken });
      expect(await promise).toMatchObject({ status: "done", message: "Fixed." });
      expect(events.find((e) => e.type === "tool" && e.name === "self_review")).toMatchObject({ ok: true, summary: "Review unavailable (the reviewer didn't answer in the expected format)." });
      writeFileSync(join(dir, "src/cart.js"), CART);
    }
  });
});

describe("unified diffs", () => {
  it("shows changed lines with context and new files from /dev/null", () => {
    expect(unifiedDiff("a.ts", "x\ny\nz\n", "x\nY\nz\nw\n")).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,4 @@\n x\n-y\n+Y\n z\n+w\n");
    expect(unifiedDiff("n.ts", null, "hi\n")).toBe("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+hi\n");
    expect(unifiedDiff("same.ts", "a\n", "a\n")).toBe("");
    // Far-apart changes become separate hunks.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 2", "LINE 2").replace("line 27", "LINE 27");
    expect(unifiedDiff("f", before, after).match(/^@@/gm)).toHaveLength(2);
  });
});
