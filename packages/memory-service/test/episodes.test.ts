import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  cleanLesson,
  createHistoryStore,
  createMemoryStore,
  type Db,
  detectFixes,
  errorSignatureOf,
  type HistoryStore,
  type MemoryStore,
  migrate,
  openDatabase,
  parseChecksOutput,
  type RecordedCall,
  type Summarizer,
} from "../src/index.js";
import { fakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
let db: Db;
let h: HistoryStore;
let t: number;
let n: number;
const ids = (p: string) => `${p}_${String(++n).padStart(6, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-ep-"));
  db = openDatabase(":memory:");
  migrate(db);
  t = 1_000;
  n = 0;
  h = createHistoryStore(db, { blobs: new BlobStore(dir), now: () => ++t, newId: ids });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string, deps: Record<string, string> = { "react-native": "0.77.1" }) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, dependencies: deps }));
  return h.ensureProject({ path: root, name });
}

const TS_ERROR = (file: string, line: number) =>
  `> app@1.0.0 typecheck\n> tsc --noEmit\n\n${file}(${line},5): error TS2532: Object is possibly 'undefined'.\n\nFound 1 error in ${file}:${line}\n`;

/** Record a session the way the agent loop does: tool calls with exit codes and output. */
function session(projectId: string | undefined, steps: [name: string, args: Record<string, unknown>, exit: number, output: string][]) {
  const s = h.createSession({ ...(projectId ? { projectId } : {}), title: "Fix the list screen" });
  for (const [name, args, exit, output] of steps) {
    const m = h.appendMessage(s.id, { role: "assistant", content: "", toolCalls: [{ name, args, ...(args.command ? { command: String(args.command) } : {}) }] });
    h.completeToolCall(m.toolCalls[0]!.id, { exitCode: exit, output });
  }
  return s.id;
}

const fixedSession = (projectId: string | undefined, file = "src/list.tsx", line = 12) =>
  session(projectId, [
    ["run_command", { command: "npm run typecheck" }, 2, TS_ERROR(`/Users/me/${file}`, line)],
    ["edit_file", { path: file, edits: [{ old: "items.map(", new: "(items ?? []).map(" }] }, 0, "Edited"],
    ["run_command", { command: "npm run typecheck" }, 0, "ok"],
  ]);

const summarizer: Summarizer = async (fix) => ({
  problem: `Typecheck failed: ${fix.errorSignature}`,
  fixSummary: `Defaulted the optional array in ${fix.files[0]} before mapping.`,
  lesson: "Default an optional array to [] before calling .map() on it.",
});

function store(extra: Parameters<typeof createMemoryStore>[1] = {}): MemoryStore {
  const mem = createMemoryStore(db, { now: () => ++t, newId: ids, summarizer: () => summarizer, ...extra });
  mem.jobs.start();
  return mem;
}

describe("fail-to-pass detection", () => {
  it("finds a check that failed, was edited and then passed, with the first error as signature", () => {
    const calls: RecordedCall[] = [
      { id: "1", name: "run_command", command: "npm run typecheck", exitCode: 2, output: TS_ERROR("/Users/a/src/list.tsx", 12) },
      { id: "2", name: "edit_file", args: { path: "src/list.tsx", edits: [{ old: "a", new: "b" }] }, exitCode: 0 },
      { id: "3", name: "run_command", command: "npm run typecheck", exitCode: 2, output: TS_ERROR("/Users/a/src/list.tsx", 14) },
      { id: "4", name: "edit_file", args: { path: "src/types.ts", edits: [{ old: "c", new: "d" }] }, exitCode: 0 },
      { id: "5", name: "run_command", command: "npm  run typecheck", exitCode: 0, output: "" },
    ];
    const [fix] = detectFixes(calls);
    expect(fix).toMatchObject({
      command: "npm run typecheck",
      verifiedBy: "typecheck",
      errorSignature: "<path>: error TS2532: Object is possibly 'undefined'.",
      files: ["src/list.tsx", "src/types.ts"],
      failCallId: "1",
      passCallId: "5",
    });
    expect(fix!.attempts.map((a) => a.outcome)).toEqual(["failed", "passed"]);
  });

  it("ignores passes without an edit, declined runs, and failures that never pass", () => {
    expect(
      detectFixes([
        { id: "1", name: "run_command", command: "npm test", exitCode: 1, output: "FAIL flaky" },
        { id: "2", name: "run_command", command: "npm test", exitCode: 0, output: "" },
        { id: "3", name: "run_command", command: "npm run lint", exitCode: 1, output: "error x" },
        { id: "4", name: "edit_file", args: { path: "a.ts" }, exitCode: 0 },
        { id: "5", name: "run_command", command: "npm run build", exitCode: -1, output: "declined" },
      ]),
    ).toEqual([]);
  });

  it("reads the agent's run_checks output per check", () => {
    const out = "typecheck: `pnpm typecheck` passed\n\ntest: `pnpm test` FAILED (exit 1)\nFAIL src/cart.test.ts\n  ✕ totals\n\nlint: `pnpm lint` not run (declined)";
    expect(parseChecksOutput(out)).toEqual([
      { kind: "typecheck", command: "pnpm typecheck", exitCode: 0, output: "" },
      { kind: "test", command: "pnpm test", exitCode: 1, output: "FAIL src/cart.test.ts\n  ✕ totals" },
      { kind: "lint", command: "pnpm lint", exitCode: -1, output: "" },
    ]);
    const fixes = detectFixes([
      { id: "1", name: "run_checks", exitCode: 1, output: out },
      { id: "2", name: "edit_file", args: { path: "src/cart.ts" }, exitCode: 0 },
      { id: "3", name: "check", command: "pnpm test", exitCode: 0, output: "" },
    ]);
    expect(fixes.map((f) => [f.command, f.verifiedBy, f.errorSignature])).toEqual([["pnpm test", "test", "FAIL <path>"]]); // the runner's marker line
  });

  it("normalizes the same error across machines and ignores banners", () => {
    expect(errorSignatureOf(TS_ERROR("/Users/a/src/x.tsx", 3))).toBe(errorSignatureOf(TS_ERROR("/home/b/app/src/y.tsx", 99)));
    expect(errorSignatureOf("\u001b[31mnpm ERR! code 1\u001b[0m\nTypeError: Cannot read properties of undefined (reading 'map')")).toBe(
      "TypeError: Cannot read properties of undefined (reading 'map')",
    );
  });

  it("keeps lessons project-neutral", () => {
    const fix = detectFixes([
      { id: "1", name: "run_command", command: "npm test", exitCode: 1, output: "Error: boom" },
      { id: "2", name: "edit_file", args: { path: "src/cart/total.ts" }, exitCode: 0 },
      { id: "3", name: "run_command", command: "npm test", exitCode: 0, output: "" },
    ])[0]!;
    expect(cleanLesson("Round money with integer cents, not floats.", fix)).toBe("Round money with integer cents, not floats.");
    expect(cleanLesson("Fix total.ts to use cents.", fix)).toBeUndefined();
    expect(cleanLesson("Edit src/cart/total.ts", fix)).toBeUndefined();
    expect(cleanLesson("Use the key sk-live-7f3a9c2e1b8d4f60a5e7b2c4 here", fix)).toBeUndefined();
  });
});

describe("episodes", () => {
  it("records a verified fix after a run, summarized in the background", async () => {
    const mem = store();
    const shop = project("shop");
    const sid = fixedSession(shop);
    expect(mem.learnFromSession(sid)).toBe(1);
    expect(mem.learnFromSession(sid)).toBe(0); // already queued
    await mem.jobs.idle();
    expect(mem.learnFromSession(sid)).toBe(0); // already recorded
    const page = await mem.listEpisodes({ projectId: shop });
    expect(page.items).toHaveLength(1);
    const ep = page.items[0]!;
    expect(ep).toMatchObject({
      projectId: shop,
      sessionId: sid,
      verifiedBy: "typecheck",
      errorSignature: "<path>: error TS2532: Object is possibly 'undefined'.",
      fixSummary: "Defaulted the optional array in src/list.tsx before mapping.",
      lesson: "Default an optional array to [] before calling .map() on it.",
      files: ["src/list.tsx"],
      env: { "react-native": "0.77.1" },
      status: "active",
    });
    expect(await mem.getEpisode(ep.id)).toEqual(ep);
    expect((await mem.listEpisodes({ query: "optional array" })).items).toHaveLength(1);
  });

  it("writes a plain summary and no lesson without a model", async () => {
    const mem = store({ summarizer: () => undefined });
    const shop = project("shop");
    mem.learnFromSession(fixedSession(shop));
    await mem.jobs.idle();
    const [ep] = (await mem.listEpisodes({})).items;
    expect(ep!.problem).toMatch(/^`npm run typecheck` failed: /);
    expect(ep!.lesson).toBeUndefined();
  });

  it("learns nothing from read-only or off projects, or from errors that contain secrets", async () => {
    const mem = store();
    const client = project("client");
    await mem.updateSettings({ projectModes: { [client]: "read_only" } });
    expect(mem.learnFromSession(fixedSession(client))).toBe(0);
    const shop = project("shop");
    const leaky = session(shop, [
      ["run_command", { command: "npm test" }, 1, "Error: auth failed for ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["edit_file", { path: "src/api.ts" }, 0, "Edited"],
      ["run_command", { command: "npm test" }, 0, "ok"],
    ]);
    expect(mem.learnFromSession(leaky)).toBe(0);
    await mem.jobs.idle();
    expect((await mem.listEpisodes({})).items).toEqual([]);
  });

  it("deletes an episode everywhere: list, retrieval and vectors", async () => {
    const mem = store({ embedder: fakeEmbedder() });
    await mem.reindex();
    const shop = project("shop");
    mem.learnFromSession(fixedSession(shop));
    await mem.jobs.idle();
    const [ep] = (await mem.listEpisodes({})).items;
    expect(db.prepare("SELECT count(*) AS n FROM memory_vec WHERE ref_key = ?").get(`episode:${ep!.id}`)).toEqual({ n: 1 });
    await mem.deleteEpisode(ep!.id);
    expect((await mem.listEpisodes({})).items).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM memory_vec WHERE ref_key = ?").get(`episode:${ep!.id}`)).toEqual({ n: 0 });
    expect((await mem.retrieve({ projectId: shop, text: "optional array map", errorOutput: TS_ERROR("/x/src/list.tsx", 1) })).items).toEqual([]);
    await expect(mem.getEpisode(ep!.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-embeds episodes with memories after a model change", async () => {
    const mem = store({ embedder: fakeEmbedder({ model: "a", dims: 32 }) });
    await mem.reindex();
    mem.learnFromSession(fixedSession(project("shop")));
    await mem.jobs.idle();
    mem.setEmbedder(fakeEmbedder({ model: "b", dims: 48 }));
    expect((await mem.reindex()).embedded).toBe(1);
  });
});

describe("T4: experience recall", () => {
  it("a fix from project A comes back in project B for the same error, as a lesson only, at the top", async () => {
    const mem = store({ embedder: fakeEmbedder() });
    await mem.reindex();
    const a = project("app-a");
    const b = project("app-b");
    // Noise: unrelated lessons that share words with the task.
    for (let i = 0; i < 8; i++) {
      await mem.createMemory({ kind: "lesson", scope: "global", key: `list.tip${i}`, body: `Lists render faster with keys and memo, tip ${i}` });
    }
    mem.learnFromSession(fixedSession(a, "src/screens/orders-list.tsx", 41));
    await mem.jobs.idle();

    // Project B hits the same error in a different file on another machine.
    const errorB = TS_ERROR("/home/ci/b/src/product-list.tsx", 7);
    const r = await mem.retrieve({ projectId: b, text: "the product list screen fails to typecheck", errorOutput: errorB });
    const top3 = r.items.slice(0, 3);
    const hit = top3.find((i) => i.ref.type === "episode");
    expect(hit).toBeDefined();
    expect(hit!.text).toBe("Default an optional array to [] before calling .map() on it.");
    expect(hit!.reasons).toEqual(expect.arrayContaining(["error_signature_match", "cross_project_lesson"]));
    // Nothing from project A's code or paths crosses over.
    expect(JSON.stringify(r.items)).not.toMatch(/orders-list|src\/screens/);

    // The agent-side recall finds it from the error alone.
    const recall = await mem.errorRecall({ projectId: b, errorOutput: errorB });
    expect(recall.map((i) => i.text)).toEqual(["Default an optional array to [] before calling .map() on it."]);
    // In project A itself, the full fix is shown.
    const own = await mem.errorRecall({ projectId: a, errorOutput: TS_ERROR("/Users/me/src/screens/orders-list.tsx", 41) });
    expect(own[0]!.text).toMatch(/Defaulted the optional array in src\/screens\/orders-list\.tsx/);
  });
});

describe("other projects' fixes in plain tasks", () => {
  it("need keywords and meaning to agree when the task has no error; an error or the same project is enough", async () => {
    const a = project("app-a");
    const b = project("app-b");
    // Keywords only: the lesson shares words with B's task, but B's task isn't a failure.
    const mem = store();
    mem.learnFromSession(fixedSession(a, "src/screens/orders-list.tsx", 41));
    await mem.jobs.idle();
    const plain = { projectId: b, text: "Add a sort option to the array of items before we map them into rows" };
    expect((await mem.retrieve(plain)).items.filter((i) => i.ref.type === "episode")).toEqual([]);
    // With the failing output, the lesson comes back (signature match).
    const withError = await mem.retrieve({ ...plain, errorOutput: TS_ERROR("/ci/b/src/rows.tsx", 3) });
    expect(withError.items[0]).toMatchObject({ ref: { type: "episode" }, reasons: expect.arrayContaining(["cross_project_lesson"]) });
    // In its own project, the fix is found from the words alone.
    expect((await mem.retrieve({ ...plain, projectId: a })).items.some((i) => i.ref.type === "episode")).toBe(true);
  });

  it("come back for a plain task when keywords and meaning agree on them", async () => {
    const a = project("app-a");
    const b = project("app-b");
    const mem = store({ embedder: fakeEmbedder() });
    await mem.reindex();
    mem.learnFromSession(fixedSession(a));
    await mem.jobs.idle();
    await mem.reindex();
    const r = await mem.retrieve({ projectId: b, text: "default an optional array before calling map on it" });
    expect(r.items.find((i) => i.ref.type === "episode")?.text).toBe("Default an optional array to [] before calling .map() on it.");
  });
});

describe("error signatures from real runners", () => {
  const TAP = [
    "TAP version 13",
    "# Subtest: ok one",
    "ok 1 - ok one",
    "# Subtest: 17% VAT on 200 is 234",
    "not ok 2 - 17% VAT on 200 is 234",
    "  ---",
    "  location: '/Users/me/shop/test/a.test.mjs:4:1'",
    "  failureType: 'testCodeFailure'",
    "  error: |-",
    "    Expected values to be strictly equal:",
    "    ",
    "    217 !== 234",
    "  code: 'ERR_ASSERTION'",
    "  name: 'AssertionError'",
    "  ...",
    "1..2",
    "# tests 2",
    "# pass 1",
    "# fail 1",
  ].join("\n");

  it("reads node:test / TAP error blocks instead of the summary", () => {
    expect(errorSignatureOf(TAP)).toBe("AssertionError: Expected values to be strictly equal:");
    expect(errorSignatureOf("# tests 3\n# fail 1\n")).toBe("# tests 3");
  });

  it("prefers a named error over summaries for Jest and Vitest output", () => {
    const jest = "FAIL src/cart.test.ts\n  ● totals › rounds\n    TypeError: Cannot read properties of undefined (reading 'map')\nTests: 1 failed, 4 passed\n";
    expect(errorSignatureOf(jest)).toBe("TypeError: Cannot read properties of undefined (reading 'map')");
    const vitest = " ❯ src/a.test.ts (2)\n × adds\nAssertionError: expected 3 to be 4\n Test Files  1 failed (1)\n";
    expect(errorSignatureOf(vitest)).toBe("AssertionError: expected 3 to be 4");
    expect(errorSignatureOf(" ❯ src/a.test.ts (2)\n × adds\n Test Files  1 failed (1)\n")).toBe("× adds");
  });
});
