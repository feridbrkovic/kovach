import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  buildTranscript,
  claimSupport,
  createHistoryStore,
  createMemoryStore,
  type Db,
  type Extractor,
  gate,
  type HistoryStore,
  type MemoryStore,
  migrate,
  openDatabase,
  parseExtraction,
  redactSecrets,
} from "../src/index.js";
import { fakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
let db: Db;
let h: HistoryStore;
let t: number;
let n: number;
const ids = (p: string) => `${p}_${String(++n).padStart(6, "0")}`;
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-ex-"));
  db = openDatabase(":memory:");
  migrate(db);
  t = 1_000_000;
  n = 0;
  h = createHistoryStore(db, { blobs: new BlobStore(dir), now: () => ++t, newId: ids, redactOutput: redactSecrets });
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

type Step = ["user" | "assistant", string] | ["tool", string, Record<string, unknown>, number, string];
function session(projectId: string | undefined, steps: Step[]) {
  const s = h.createSession({ ...(projectId ? { projectId } : {}), title: "t" });
  for (const st of steps) {
    if (st[0] === "tool") {
      const [, name, args, exit, output] = st;
      const m = h.appendMessage(s.id, { role: "assistant", content: "", toolCalls: [{ name, args, ...(args.command ? { command: String(args.command) } : {}) }] });
      h.completeToolCall(m.toolCalls[0]!.id, { exitCode: exit, output });
    } else h.appendMessage(s.id, { role: st[0], content: st[1] });
  }
  return s.id;
}

/** An extractor that answers with whatever JSON the test gives it, and records the prompts. */
function scripted(...answers: unknown[]): Extractor & { prompts: string[] } {
  const prompts: string[] = [];
  const fn = (async (prompt: string) => {
    prompts.push(prompt);
    const a = answers.shift();
    return typeof a === "string" ? a : JSON.stringify(a ?? { candidates: [] });
  }) as Extractor & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

function store(extractor: Extractor | undefined, extra: Parameters<typeof createMemoryStore>[1] = {}): MemoryStore {
  const mem = createMemoryStore(db, { now: () => ++t, newId: ids, extractor: () => extractor, ...extra });
  mem.jobs.start();
  return mem;
}

async function extract(mem: MemoryStore, sessionId: string) {
  mem.queueExtraction(sessionId);
  await mem.jobs.idle();
  return mem.listCandidates();
}

describe("transcript and parsing", () => {
  it("builds a compact, redacted transcript with short ids the model can cite", () => {
    const p = project("shop");
    const sid = session(p, [
      ["user", "Always use pnpm here. My token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["assistant", "I'll switch the scripts to pnpm."],
      ["tool", "run_command", { command: "pnpm test" }, 1, "FAIL src/a.test.ts\nTypeError: x is undefined"],
      ["tool", "fetch_page", { url: "https://reactnative.dev/docs/flatlist" }, 0, "FlatList – React Native\nA performant interface for rendering lists."],
    ]);
    const tr = buildTranscript(db, sid, 0);
    expect(tr.text).toContain("[m1] USER: Always use pnpm here. My token is [redacted GitHub token]");
    expect(tr.text).toContain("[m2] ASSISTANT: I'll switch the scripts to pnpm.");
    expect(tr.text).toContain("[t1] TOOL run_command pnpm test → exit 1: FAIL src/a.test.ts");
    expect(tr.text).toContain("[t2] TOOL fetch_page https://reactnative.dev/docs/flatlist: FlatList – React Native");
    expect(tr.text).not.toMatch(/ghp_/);
    expect(tr.refs.get("m1")).toMatchObject({ type: "user" });
    expect(tr.refs.get("t2")).toMatchObject({ type: "tool", tool: "fetch_page", url: "https://reactnative.dev/docs/flatlist" });
  });

  it("parses strict JSON with text around it, drops off-shape items and keeps at most 5", () => {
    const one = { kind: "preference", scope: "global", key: "pm", body: "Use pnpm.", evidence: ["m1"] };
    expect(parseExtraction(`Sure!\n${JSON.stringify({ candidates: [one] })}\nDone`)).toHaveLength(1);
    expect(parseExtraction(JSON.stringify({ candidates: [one, { ...one, kind: "secret" }, { ...one, evidence: "m1" }] }))).toHaveLength(1);
    expect(parseExtraction(JSON.stringify({ candidates: Array(8).fill(one) }))).toHaveLength(5);
    expect(parseExtraction("not json")).toEqual([]);
  });

  it("gates by secrets, evidence and scope", () => {
    const refs = new Map([
      ["m1", { id: "u1", type: "user" as const, text: "I always use pnpm." }],
      ["m2", { id: "a1", type: "assistant" as const }],
      ["t1", { id: "c1", type: "tool" as const, tool: "fetch_page", url: "https://x.dev/a" }],
      ["m3", { id: "u3", type: "user" as const, text: "The discount test fails. Run the tests and fix it." }],
      ["m4", { id: "u4", type: "user" as const, text: "Ubuduće uvijek koristi pnpm." }],
    ]);
    const base = { kind: "preference" as const, scope: "global" as const, key: "pm", body: "Use pnpm.", evidence: ["m1"] };
    expect(gate(base, refs, true)).toMatchObject({ ok: true, evidence: [{ type: "message", id: "u1" }] });
    expect(gate({ ...base, evidence: ["m2"] }, refs, true)).toEqual({ ok: false, reason: "evidence" }); // assistant only
    expect(gate({ ...base, body: "Deploy key AKIAABCDEFGHIJKLMNOP" }, refs, true)).toEqual({ ok: false, reason: "secret" });
    expect(gate({ ...base, kind: "research", evidence: ["m1"] }, refs, true)).toEqual({ ok: false, reason: "evidence" });
    expect(gate({ ...base, kind: "research", evidence: ["t1"] }, refs, true)).toMatchObject({ ok: true, sources: [{ url: "https://x.dev/a" }] });
    expect(gate({ ...base, kind: "decision", scope: "project", evidence: ["m1"] }, refs, false)).toEqual({ ok: false, reason: "scope" });
    expect(gate({ ...base, kind: "decision", scope: "global", evidence: ["m1"] }, refs, true)).toMatchObject({ ok: true, candidate: { scope: "project" } });
    // A task instruction is not a preference for every project; for this project it can still be proposed.
    const runFirst = { ...base, key: "workflow.run_checks_first", body: "Always run the tests before editing.", evidence: ["m3"] };
    expect(gate(runFirst, refs, true)).toMatchObject({ ok: true, candidate: { scope: "project" } });
    expect(gate(runFirst, refs, false)).toEqual({ ok: false, reason: "scope" });
    expect(gate({ ...base, evidence: ["m4"] }, refs, true)).toMatchObject({ ok: true }); // said in Bosnian
  });

  it("measures how much of a claim its page still supports", () => {
    expect(claimSupport("FlatList initialNumToRender defaults to 10", "The initialNumToRender prop of FlatList defaults to 10 items.")).toBe(1);
    expect(claimSupport("FlatList initialNumToRender defaults to 10", "This page has moved.")).toBeLessThan(0.5);
  });
});

describe("extraction job", () => {
  const pref = (o: Record<string, unknown> = {}) => ({ kind: "preference", scope: "global", key: "tooling.package-manager", body: "Use pnpm, not npm.", evidence: ["m1"], ...o });

  it("proposes what the user said, for review, and reads each part of a session once", async () => {
    const ex = scripted({ candidates: [pref(), { kind: "decision", scope: "project", key: "state.library", body: "Zustand for client state.", evidence: ["m2"] }] }, { candidates: [] });
    const mem = store(ex);
    const p = project("shop");
    const sid = session(p, [
      ["user", "Use pnpm, never npm."],
      ["user", "We'll go with Zustand for state."],
      ["assistant", "Done."],
    ]);
    const cands = await extract(mem, sid);
    expect(cands.map((c) => [c.kind, c.scope, c.key, c.body])).toEqual(
      expect.arrayContaining([
        ["preference", "global", "tooling.package-manager", "Use pnpm, not npm."],
        ["decision", "project", "state.library", "Zustand for client state."],
      ]),
    );
    expect(cands.find((c) => c.kind === "decision")).toMatchObject({ projectId: p, seenInSessions: 1 });
    expect(cands.every((c) => c.evidence.every((e) => e.type === "message"))).toBe(true);
    // The session continues: only new messages are read next time.
    h.appendMessage(sid, { role: "user", content: "Also add a README." });
    await extract(mem, sid);
    expect(ex.prompts[1]).toContain("Also add a README.");
    expect(ex.prompts[1]).not.toContain("Use pnpm, never npm.");
  });

  it("drops secrets, assistant-only claims and duplicates of what is remembered", async () => {
    const mem = store(
      scripted({
        candidates: [
          pref({ key: "deploy.key", body: "The deploy key is AKIAABCDEFGHIJKLMNOP" }),
          pref({ key: "style.tabs", body: "Use tabs.", evidence: ["m2"] }),
          pref({ key: "style.quotes", body: "Use single quotes." }),
        ],
      }),
    );
    await mem.createMemory({ kind: "preference", scope: "global", key: "style.quotes", body: "Use single quotes" });
    const sid = session(project("shop"), [
      ["user", "Single quotes please."],
      ["assistant", "I prefer tabs."],
    ]);
    expect(await extract(mem, sid)).toEqual([]);
  });

  it("doesn't propose again what the user saved from the same message, but keeps another fact from it", async () => {
    const mem = store(
      scripted({
        candidates: [
          { kind: "preference", scope: "project", key: "pricing.integer_cents", body: "Prices must be kept as integer cents, never floats.", evidence: ["m1"] },
          { kind: "convention", scope: "project", key: "shop.currency", body: "Show prices in euros with a comma decimal separator.", evidence: ["m1"] },
        ],
      }),
    );
    const p = project("shop");
    const sid = session(p, [
      ["user", "Remember for this project: prices are stored as integer cents, never as floats. Also, always remember to show prices in euros with a comma decimal separator."],
      ["assistant", "Saved."],
    ]);
    const asked = (await h.getSession(sid)).messages.items[0]!;
    await mem.remember(
      { kind: "convention", scope: "project", projectId: p, key: "shop.pricing", body: "Product prices in the shop are stored as integer cents, never as floats." },
      { sessionId: sid, messageId: asked.id, contextProjectId: p },
    );
    expect((await extract(mem, sid)).map((c) => c.key)).toEqual(["shop.currency"]);
  });

  it("resolves a proposal's evidence to what was said or run, and where; deleted evidence is marked", async () => {
    const mem = store(
      scripted({ candidates: [{ kind: "convention", scope: "project", key: "checks.command", body: "Run pnpm test before finishing.", evidence: ["m1", "t1"] }] }),
    );
    const p = project("shop");
    const sid = session(p, [
      ["user", "From now on, always run pnpm test before you finish."],
      ["tool", "run_command", { command: "pnpm test" }, 0, "3 passed"],
    ]);
    const [c] = await extract(mem, sid);
    const items = await mem.getEvidence(c!.id);
    const asked = (await h.getSession(sid)).messages.items[0]!;
    expect(items).toEqual([
      { type: "message", id: asked.id, excerpt: "From now on, always run pnpm test before you finish.", sessionId: sid, messageId: asked.id, role: "user" },
      expect.objectContaining({ type: "tool_call", excerpt: "pnpm test\n3 passed", sessionId: sid, role: "assistant" }),
    ]);
    await h.deleteSession(sid);
    expect((await mem.getEvidence(c!.id)).map((e) => e.missing)).toEqual([true, true]);
  });

  it("asks when a new value conflicts with what the user said before, and accepting replaces it", async () => {
    const mem = store(scripted({ candidates: [pref({ body: "Use bun for new projects." })] }));
    const old = await mem.createMemory({ kind: "preference", scope: "global", key: "tooling.package-manager", body: "Use pnpm, not npm." });
    const [c] = await extract(mem, session(project("shop"), [["user", "From now on use bun for new projects."]]));
    expect(c).toMatchObject({ conflictsWith: old.id, body: "Use bun for new projects." });
    expect((await mem.getMemory(old.id)).memory.status).toBe("active"); // nothing changes until the user answers
    await mem.resolveCandidate(c!.id, "accept");
    expect((await mem.getMemory(old.id)).memory.status).toBe("superseded");
  });

  it("auto-accepts a proposal that recurs in two separate sessions, only when allowed", async () => {
    const ex = scripted({ candidates: [pref()] }, { candidates: [pref()] }, { candidates: [pref()] });
    const mem = store(ex);
    const p = project("shop");
    await extract(mem, session(p, [["user", "Use pnpm, never npm."]]));
    const [c] = await extract(mem, session(p, [["user", "Again: pnpm, not npm."]]));
    expect(c).toMatchObject({ seenInSessions: 2 }); // recurring, still waiting (auto-accept is off)
    await mem.updateSettings({ autoAcceptRecurring: true });
    await extract(mem, session(p, [["user", "pnpm only."]]));
    expect(await mem.listCandidates()).toEqual([]);
    expect((await mem.listMemories({})).items.map((m) => [m.key, m.trust])).toEqual([["tooling.package-manager", "user"]]);
  });

  it("keeps two different proposals from one run that share a key, and drops an exact repeat", async () => {
    const p = project("shop");
    const mem = store(
      scripted({
        candidates: [
          pref({ key: "style.answers", body: "Short, to-the-point answers." }),
          pref({ key: "style.answers", body: "Code comments in English." }),
          pref({ key: "Style.Answers", body: "Short, to-the-point answers" }),
        ],
      }),
    );
    const got = await extract(mem, session(p, [["user", "I always want short answers and code comments in English."]]));
    expect(got.map((c) => [c.key, c.body]).sort()).toEqual([
      ["style.answers", "Short, to-the-point answers."],
      ["style.answers-2", "Code comments in English."],
    ]);
  });

  it("counts review decisions for the precision shown in the app: by origin, edits apart, auto-accepts left out", async () => {
    const p = project("shop");
    writeFileSync(join(dir, "shop", "AGENTS.md"), "## Conventions\n\n- Name files in kebab-case everywhere\n- Keep components under 200 lines each\n");
    const mem = store(
      scripted(
        { candidates: [pref({ key: "style.semicolons", body: "No semicolons." }), pref({ key: "style.quotes", body: "Single quotes." })] },
        { candidates: [pref({ key: "tooling.package-manager" })] },
        { candidates: [pref({ key: "tooling.package-manager" })] },
      ),
    );
    expect(await mem.reviewStats()).toMatchObject({ fromSessions: { accepted: 0, edited: 0, rejected: 0 }, fromFiles: { accepted: 0, edited: 0, rejected: 0 } });
    const [a, b] = await extract(mem, session(p, [["user", "I never want semicolons, and I always use single quotes."]]));
    await mem.resolveCandidate(a!.id, "accept");
    await mem.resolveCandidate(b!.id, { edit: { body: "Single quotes in JS and TS." } });
    await mem.seedProject(p);
    const seeded = (await mem.listCandidates()).filter((c) => c.evidence.every((e) => e.type === "source"));
    expect(seeded).toHaveLength(2);
    await mem.resolveCandidate(seeded[0]!.id, "reject");
    await mem.resolveCandidate(seeded[1]!.id, { edit: { body: seeded[1]!.body } }); // the edit form, saved unchanged
    // A recurring proposal auto-accepted on its second session is not the user's decision.
    await mem.updateSettings({ autoAcceptRecurring: true });
    await extract(mem, session(p, [["user", "Use pnpm, never npm."]]));
    await extract(mem, session(p, [["user", "pnpm only, always."]]));
    expect((await mem.listMemories({ query: "pnpm" })).items).toHaveLength(1);
    const stats = await mem.reviewStats();
    expect(stats.fromSessions).toEqual({ accepted: 2, edited: 1, rejected: 0 });
    expect(stats.fromFiles).toEqual({ accepted: 1, edited: 0, rejected: 1 });
    expect(stats.since).toBeLessThan(t);
  });

  it("drops near-duplicates by meaning when vectors are available", async () => {
    const mem = store(scripted({ candidates: [pref({ key: "tooling.package-manager.choice", body: "Use pnpm, not npm" })] }), { embedder: fakeEmbedder() });
    await mem.createMemory({ kind: "preference", scope: "global", key: "tooling.package-manager", body: "Use pnpm, not npm." });
    await mem.reindex();
    expect(await extract(mem, session(project("shop"), [["user", "pnpm not npm"]]))).toEqual([]);
  });

  it("doesn't run when the user turned it off, without a model, or for read-only and off projects", async () => {
    const mem = store(scripted({ candidates: [pref()] }));
    const p = project("shop");
    await mem.updateSettings({ autoExtract: false });
    expect(mem.queueExtraction(session(p, [["user", "Use pnpm, never npm."]]))).toBe(false);
    await mem.updateSettings({ autoExtract: true, projectModes: { [p]: "read_only" } });
    expect(mem.queueExtraction(session(p, [["user", "Use pnpm, never npm."]]))).toBe(false);
    expect(store(undefined).queueExtraction(session(undefined, [["user", "Use pnpm."]]))).toBe(false);
  });
});

describe("research memory", () => {
  const research = { kind: "research", scope: "project", key: "flatlist.initial-render", body: "FlatList initialNumToRender defaults to 10 items.", evidence: ["t1"], appliesTo: { "react-native": "0.77" } };
  const page = "The initialNumToRender prop of FlatList defaults to 10 items rendered in the first batch.";

  async function accepted(mem: MemoryStore, p: string) {
    const sid = session(p, [
      ["user", "How many rows does FlatList render first?"],
      ["tool", "fetch_page", { url: "https://reactnative.dev/docs/flatlist" }, 0, `FlatList\n${page}`],
    ]);
    const [c] = await extract(mem, sid);
    expect(c!.evidence.map((e) => e.type)).toEqual(["tool_call", "source"]);
    await mem.resolveCandidate(c!.id, "accept");
    return (await mem.listMemories({ kind: "research" })).items[0]!;
  }

  it("keeps a finding while its page still supports it, and marks it stale when not", async () => {
    let clock = 0;
    const mem = createMemoryStore(db, { now: () => ++t + clock, newId: ids, extractor: () => scripted({ candidates: [research] }) });
    mem.jobs.start();
    const p = project("shop");
    const m = await accepted(mem, p);
    expect(m.trust).toBe("user");
    // Nothing is due yet.
    expect(await mem.revalidateResearch(async () => page)).toEqual({ checked: 0, renewed: 0, stale: 0 });
    clock = 91 * DAY;
    expect(await mem.revalidateResearch(async () => page)).toEqual({ checked: 1, renewed: 1, stale: 0 });
    clock = 182 * DAY;
    expect(await mem.revalidateResearch(async () => "This page has moved.")).toEqual({ checked: 1, renewed: 0, stale: 1 });
    expect((await mem.getMemory(m.id)).memory.status).toBe("stale");
    expect((await mem.retrieve({ projectId: p, text: "FlatList initialNumToRender" })).items.filter((i) => i.ref.type === "memory")).toEqual([]);
    // "Still true": re-confirming makes it active again.
    const again = await mem.updateMemory(m.id, { body: m.body });
    expect(again.status).toBe("active");
    clock = 183 * DAY;
    expect(await mem.revalidateResearch(async () => { throw new Error("offline"); })).toMatchObject({ checked: 0 });
  });
});

describe("T5: research freshness", () => {
  it("labels a finding for an older version possibly outdated when the project uses a newer one", async () => {
    const mem = store(undefined);
    const p = project("shop", { "react-native": "0.77.1" });
    await mem.createMemory({ kind: "research", scope: "project", projectId: p, key: "flatlist.window", body: "FlatList windowSize defaults to 21.", appliesTo: { "react-native": "0.74" } });
    const r = await mem.retrieve({ projectId: p, text: "FlatList windowSize default" });
    expect(r.items[0]).toMatchObject({ possiblyOutdated: true });
    expect(r.items[0]!.reasons).toContain("version_mismatch");
    const task = await mem.taskContext({ projectId: p, text: "FlatList windowSize default" });
    expect(task.text).toMatch(/\(research, user, possibly outdated\) flatlist\.window/);
  });
});

describe("T8: privacy", () => {
  it("secrets from chat, tool output and .env files never reach memories, episodes, docs or retrieval; off projects give and get nothing", async () => {
    const leaky = scripted({
      candidates: [
        { kind: "preference", scope: "global", key: "github.token", body: "The user's GitHub token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", evidence: ["m1"] },
        { kind: "convention", scope: "project", key: "env.db", body: "DATABASE_PASSWORD=hN3$kq9Lz!pW2rT7 is used locally", evidence: ["m1"] },
        { kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons.", evidence: ["m1"] },
      ],
    });
    const mem = store(leaky, {
      summarizer: () => async (fix) => ({ problem: `Auth failed`, fixSummary: `Changed ${fix.files[0]}`, lesson: "Read credentials from the environment, never from code." }),
    });
    const p = project("shop");
    const sid = session(p, [
      ["user", "No semicolons. My token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, use it."],
      ["tool", "read_file", { path: ".env" }, 0, "DATABASE_PASSWORD=hN3$kq9Lz!pW2rT7\nAWS_KEY=AKIAABCDEFGHIJKLMNOP"],
      ["tool", "run_command", { command: "npm test" }, 1, "Error: auth failed with key AKIAABCDEFGHIJKLMNOP"],
      ["tool", "edit_file", { path: "src/api.ts" }, 0, "Edited"],
      ["tool", "run_command", { command: "npm test" }, 0, "ok"],
    ]);
    mem.queueExtraction(sid);
    mem.learnFromSession(sid);
    await mem.jobs.idle();

    // The model never saw a secret.
    expect(leaky.prompts[0]).not.toMatch(/ghp_a|hN3\$kq9|AKIAABCDEFGHIJKLMNOP/);
    // Tool output was stored redacted.
    const stored = db.prepare("SELECT output_excerpt FROM tool_calls").all() as { output_excerpt: string | null }[];
    expect(JSON.stringify(stored)).not.toMatch(/hN3\$kq9|AKIAABCDEFGHIJKLMNOP/);
    // Only the clean proposal survived; no episode came from an error with a key in it.
    expect((await mem.listCandidates()).map((c) => c.key)).toEqual(["style.semicolons"]);
    const all = JSON.stringify([await mem.listCandidates(), await mem.listMemories({}), await mem.listEpisodes({})]);
    expect(all).not.toMatch(/ghp_a|hN3\$kq9|AKIA/);
    const r = await mem.retrieve({ projectId: p, text: "token password key auth semicolons", errorOutput: "Error: auth failed with key" });
    expect(JSON.stringify(r)).not.toMatch(/ghp_a|hN3\$kq9|AKIA/);

    // An off project contributes nothing and receives nothing.
    const off = project("client");
    await mem.createMemory({ kind: "preference", scope: "global", key: "style.tabs", body: "Use tabs" });
    await mem.updateSettings({ projectModes: { [off]: "off" } });
    const offSid = session(off, [["user", "Use 4-space indents in this repo."]]);
    expect(mem.queueExtraction(offSid)).toBe(false);
    expect(mem.learnFromSession(offSid)).toBe(0);
    expect((await mem.alwaysOn(off)).text).toBe("");
    expect((await mem.retrieve({ projectId: off, text: "tabs indent semicolons" })).items).toEqual([]);
    expect(await mem.searchDocs({ projectId: off, query: "anything" })).toEqual([]);
  });
});
