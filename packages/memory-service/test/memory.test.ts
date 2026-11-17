import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemoryChangeEvent, MemoryApiError } from "@kovach-dev/memory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  createHistoryStore,
  createMemoryStore,
  type Db,
  type HistoryStore,
  type MemoryStore,
  migrate,
  normalizeErrorSignature,
  openDatabase,
  scanProject,
  scanSecrets,
  withPrefix,
} from "../src/index.js";
import { fakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
let db: Db;
let h: HistoryStore;
let mem: MemoryStore;
let t: number;
let n: number;
let projectDir: string;
let projectId: string;

function memStore(extra: Parameters<typeof createMemoryStore>[1] = {}) {
  return createMemoryStore(db, { now: () => ++t, newId: (p) => `${p}_${String(++n).padStart(8, "0")}`, ...extra });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-mem-"));
  db = openDatabase(":memory:");
  migrate(db);
  t = 1_000;
  n = 0;
  h = createHistoryStore(db, { blobs: new BlobStore(dir), now: () => ++t, newId: (p) => `${p}_${String(++n).padStart(8, "0")}` });
  projectDir = join(dir, "shop");
  mkdirSync(projectDir);
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "shop", packageManager: "pnpm@10.0.0", scripts: { typecheck: "tsc", test: "vitest" }, dependencies: { "react-native": "0.76.3", expo: "~52.0.0", zustand: "^5.0.1" }, devDependencies: { typescript: "^5.6.2" } }),
  );
  projectId = h.ensureProject({ path: projectDir, name: "shop" });
  mem = memStore();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("explicit memories", () => {
  it("creates, lists, pins and normalizes subjects", async () => {
    const events: MemoryChangeEvent[] = [];
    mem.onChange((e) => events.push(e));
    const a = await mem.createMemory({ kind: "preference", scope: "global", key: " Style Semicolons ", body: " No semicolons in TypeScript. " });
    expect(a).toMatchObject({ key: "style.semicolons", body: "No semicolons in TypeScript.", trust: "user", status: "active", pinned: false });
    const b = await mem.createMemory({ kind: "decision", scope: "project", projectId, key: "state.library", body: "Zustand for global state" });
    await mem.setPinned(b.id, true);
    const page = await mem.listMemories({});
    expect(page.items.map((m) => m.key)).toEqual(["state.library", "style.semicolons"]); // pinned first
    expect((await mem.listMemories({ query: "zustand" })).items.map((m) => m.id)).toEqual([b.id]);
    expect((await mem.listMemories({ kind: "preference" })).items.map((m) => m.id)).toEqual([a.id]);
    expect(events.map((e) => `${e.type}:${"action" in e ? e.action : ""}`)).toEqual(["memory:created", "memory:created", "memory:edited"]);
  });

  it("refuses secrets, bad input, unknown projects and read-only or off projects", async () => {
    await expect(mem.createMemory({ kind: "preference", scope: "global", key: "deploy", body: "use token ghp_" + "a".repeat(36) })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringMatching(/GitHub token/),
    });
    await expect(mem.createMemory({ kind: "preference", scope: "global", key: "!!!", body: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(mem.createMemory({ kind: "decision", scope: "project", key: "k", body: "x" } as never)).rejects.toMatchObject({ code: "invalid" });
    await expect(mem.createMemory({ kind: "decision", scope: "project", projectId: "prj_nope", key: "k", body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await mem.updateSettings({ projectModes: { [projectId]: "read_only" } });
    await expect(mem.createMemory({ kind: "decision", scope: "project", projectId, key: "k", body: "x" })).rejects.toMatchObject({ code: "project_mode" });
    // Global memories are still fine.
    await expect(mem.createMemory({ kind: "preference", scope: "global", key: "k", body: "x" })).resolves.toBeTruthy();
  });

  it("refuses a second active memory on the same subject when editing a key into it", async () => {
    await mem.createMemory({ kind: "preference", scope: "global", key: "a", body: "one" });
    const b = await mem.createMemory({ kind: "preference", scope: "global", key: "b", body: "two" });
    await expect(mem.updateMemory(b.id, { key: "a" })).rejects.toBeInstanceOf(MemoryApiError);
    await expect(mem.updateMemory(b.id, { key: "a" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps a full audit trail", async () => {
    const a = await mem.createMemory({ kind: "preference", scope: "global", key: "tabs", body: "2 spaces" });
    const b = await mem.updateMemory(a.id, { body: "4 spaces" });
    await mem.setPinned(b.id, true);
    const { history, events } = await mem.getMemory(b.id);
    expect(history.map((m) => m.body)).toEqual(["2 spaces"]);
    expect(events.map((e) => `${e.action}/${e.actor}`)).toEqual(["created/user", "edited/user", "superseded/system", "edited/user"]);
  });
});

describe("candidates", () => {
  const propose = (key: string, body: string, extra: { conflicts?: string; expires?: number } = {}) => {
    const id = `mem_cand${++n}`;
    db.prepare(
      `INSERT INTO memories (id, kind, scope, key, body, trust, status, evidence_json, review_after, conflicts_with, created_at, updated_at)
       VALUES (?, 'preference', 'global', ?, ?, 'inferred', 'pending_review', '[{"type":"message","id":"msg_1"}]', ?, ?, ?, ?)`,
    ).run(id, key, body, extra.expires ?? t + 1_000_000, extra.conflicts ?? null, t, t);
    return id;
  };

  it("lists, accepts with an edit, rejects and expires proposals", async () => {
    const a = propose("editor", "Uses VS Code");
    const b = propose("shell", "zsh");
    propose("old", "gone", { expires: t - 1 });
    expect((await mem.listCandidates()).map((c) => c.key).sort()).toEqual(["editor", "shell"]);
    await mem.resolveCandidate(a, { edit: { body: "Uses Cursor" } });
    await mem.resolveCandidate(b, "reject");
    expect(await mem.listCandidates()).toEqual([]);
    const active = (await mem.listMemories({})).items;
    expect(active.map((m) => `${m.key}=${m.body}/${m.trust}`)).toEqual(["editor=Uses Cursor/user"]);
    await expect(mem.resolveCandidate(b, "accept")).rejects.toMatchObject({ code: "not_found" });
  });

  it("accepting a conflicting proposal supersedes the old answer", async () => {
    const old = await mem.createMemory({ kind: "preference", scope: "global", key: "quotes", body: "double quotes" });
    const c = propose("quotes.style", "single quotes", { conflicts: old.id });
    await mem.resolveCandidate(c, { edit: { key: "quotes" } });
    expect((await mem.getMemory(old.id)).memory.status).toBe("superseded");
    expect((await mem.listMemories({})).items.map((m) => m.body)).toEqual(["single quotes"]);
  });
});

describe("settings", () => {
  it("reports and changes project modes and memory options", async () => {
    expect(await mem.getSettings()).toEqual({ autoExtract: true, autoAcceptRecurring: false, projectModes: { [projectId]: "on" }, embeddingModel: "embeddinggemma" });
    const s = await mem.updateSettings({ projectModes: { [projectId]: "off" }, autoExtract: false, embeddingModel: "qwen3-embedding-0.6b" });
    expect(s).toMatchObject({ autoExtract: false, projectModes: { [projectId]: "off" }, embeddingModel: "qwen3-embedding-0.6b" });
    expect(mem.projectMode(projectId)).toBe("off");
    await expect(mem.updateSettings({ projectModes: { prj_missing: "on" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(mem.updateSettings({ embeddingModel: " " })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("project scanner", () => {
  it("builds a card from the manifests and caches it until they change", () => {
    const card = mem.projectCard(projectId)!;
    expect(card).toMatchObject({
      name: "shop",
      languages: ["JavaScript", "TypeScript"],
      packageManager: "pnpm",
      checks: ["typecheck", "test"],
      versions: { "react-native": "0.76.3", expo: "52.0.0", zustand: "5.0.1", typescript: "5.6.2" },
    });
    expect(card.stack).toEqual(["React Native 0.76.3", "Expo SDK 52.0.0", "TypeScript 5.6.2", "Zustand 5.0.1"]);
    expect(mem.projectCard(projectId)).toBe(card); // cached
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ dependencies: { "react-native": "0.77.0" } }));
    expect(mem.projectCard(projectId)!.versions["react-native"]).toBe("0.77.0");
  });

  it("reads PHP and Python projects too", () => {
    const php = join(dir, "api");
    mkdirSync(php);
    writeFileSync(join(php, "composer.json"), JSON.stringify({ require: { php: "^8.3", "laravel/framework": "^11.2" }, scripts: { test: "phpunit" } }));
    expect(scanProject(php, "api")).toMatchObject({ languages: ["PHP"], stack: ["Laravel 11.2", "PHP 8.3"], packageManager: "composer", checks: ["test"] });
    const py = join(dir, "svc");
    mkdirSync(py);
    writeFileSync(join(py, "requirements.txt"), "fastapi==0.115.2\nuvicorn>=0.30\n");
    expect(scanProject(py, "svc")).toMatchObject({ languages: ["Python"], stack: ["FastAPI 0.115.2"] });
  });
});

describe("retrieval", () => {
  it("finds memories by keywords, filters by project, and labels version mismatches", async () => {
    const other = h.ensureProject({ path: join(dir, "other"), name: "other" });
    await mem.createMemory({ kind: "open_issue", scope: "project", projectId, key: "checkout.bug", body: "Checkout total rounds wrong on Android" });
    await mem.createMemory({ kind: "open_issue", scope: "project", projectId: other, key: "checkout.other", body: "Checkout total in the other app" });
    await mem.createMemory({ kind: "lesson", scope: "global", key: "rn.animations", body: "Reanimated worklets need the babel plugin", appliesTo: { "react-native": "0.74" } });
    const r = await mem.retrieve({ projectId, text: "the checkout total is wrong" });
    expect(r.items.map((i) => i.text)).toEqual(["checkout.bug: Checkout total rounds wrong on Android"]);
    const anim = await mem.retrieve({ projectId, text: "reanimated worklets crash" });
    expect(anim.items[0]).toMatchObject({ possiblyOutdated: true, reasons: expect.arrayContaining(["version_mismatch"]) });
    expect(r.tokens).toBe(r.items.reduce((s, i) => s + i.tokens, 0));
  });

  it("finds by meaning with vectors, and falls back to keywords when the model is down", async () => {
    const emb = fakeEmbedder({ synonyms: { zustand: "statelib", redux: "statelib", store: "statelib" } });
    mem = memStore({ embedder: emb });
    expect(mem.vectorsReady()).toBe(false);
    await mem.createMemory({ kind: "decision", scope: "project", projectId, key: "arch.global", body: "Zustand everywhere" });
    expect(await mem.reindex()).toEqual({ embedded: 1 });
    expect(mem.vectorsReady()).toBe(true);
    // No shared keyword: only the vector path can find it.
    const hit = await mem.retrieve({ projectId, text: "which redux store should I use" });
    expect(hit.items.map((i) => i.text)).toEqual(["arch.global: Zustand everywhere"]);
    emb.fail = true;
    expect((await mem.retrieve({ projectId, text: "which redux store should I use" })).items).toEqual([]);
    expect((await mem.retrieve({ projectId, text: "zustand" })).items).toHaveLength(1);
  });

  it("re-embeds everything when the model changes, including new dimensions", async () => {
    mem = memStore({ embedder: fakeEmbedder({ model: "a", dims: 768 }) });
    await mem.createMemory({ kind: "preference", scope: "global", key: "x", body: "one" });
    await mem.createMemory({ kind: "preference", scope: "global", key: "y", body: "two" });
    expect((await mem.reindex()).embedded).toBe(2);
    expect(await mem.reindex()).toEqual({ embedded: 0 }); // nothing new
    mem.setEmbedder(fakeEmbedder({ model: "b", dims: 1024 }));
    expect(mem.vectorsReady()).toBe(false);
    expect((await mem.reindex()).embedded).toBe(2);
    expect(db.prepare("SELECT model, dims FROM embedding_meta").get()).toEqual({ model: "b", dims: 1024 });
    // New memories are embedded on write once the model is ready.
    await mem.createMemory({ kind: "preference", scope: "global", key: "z", body: "three" });
    expect((db.prepare("SELECT count(*) AS n FROM memory_vec").get() as { n: number }).n).toBe(3);
  });

  it("puts an exact error signature match first and shows other projects only the lesson", async () => {
    const other = h.ensureProject({ path: join(dir, "other"), name: "other" });
    const sig = normalizeErrorSignature("TypeError: Cannot read properties of undefined (reading 'map') at /Users/x/app/src/List.tsx:12:5");
    db.prepare(
      `INSERT INTO episodes (id, project_id, problem, error_signature, fix_summary, lesson, verified_by, created_at)
       VALUES ('ep_1', ?, 'List crashed on empty data', ?, 'Default items to []', 'Guard optional arrays before .map()', 'test', 1)`,
    ).run(other, sig);
    await mem.createMemory({ kind: "lesson", scope: "global", key: "lists.map", body: "map over lists in render" });
    const r = await mem.retrieve({
      projectId,
      text: "the screen crashes",
      errorOutput: "TypeError: Cannot read properties of undefined (reading 'map')\n    at /Users/y/shop/src/Feed.tsx:40:9",
    });
    expect(r.items[0]).toMatchObject({ ref: { type: "episode", id: "ep_1" }, text: "Guard optional arrays before .map()" });
    expect(r.items[0]!.reasons).toEqual(expect.arrayContaining(["error_signature_match", "cross_project_lesson"]));
  });

  it("returns nothing for a project whose memory is off", async () => {
    await mem.createMemory({ kind: "preference", scope: "global", key: "tabs", body: "Use tabs" });
    await mem.updateSettings({ projectModes: { [projectId]: "off" } });
    expect((await mem.retrieve({ projectId, text: "tabs" })).items).toEqual([]);
    expect((await mem.alwaysOn(projectId)).text).toBe("");
  });

  it("keeps to the item and token budget", async () => {
    for (let i = 0; i < 12; i++) await mem.createMemory({ kind: "lesson", scope: "global", key: `cache.rule${i}`, body: `Clear the metro cache when ${"x".repeat(300)} case ${i}` });
    const r = await mem.retrieve({ text: "metro cache" });
    expect(r.items.length).toBeLessThanOrEqual(6);
    expect(r.tokens).toBeLessThanOrEqual(1200);
  });
});

describe("always-on block and used memories", () => {
  it("holds the project card, pinned items, preferences and project decisions within budget", async () => {
    await mem.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons" });
    await mem.createMemory({ kind: "decision", scope: "project", projectId, key: "state.library", body: "Zustand" });
    await mem.createMemory({ kind: "open_issue", scope: "project", projectId, key: "bug.x", body: "Not always on" });
    const pinned = await mem.createMemory({ kind: "lesson", scope: "global", key: "always.check", body: "Run typecheck first", pinned: true });
    const block = await mem.alwaysOn(projectId);
    expect(block.text).toContain("Project shop; stack: React Native 0.76.3");
    expect(block.text).toContain("style.semicolons: No semicolons");
    expect(block.text).toContain("state.library: Zustand");
    expect(block.text).not.toContain("Not always on");
    expect(block.items[0]!.ref.id).toBe(pinned.id);
    expect(block.tokens).toBeLessThanOrEqual(400);
    // The task block leaves out what is already always on.
    const exclude = new Set(block.items.map((i) => `${i.ref.type}:${i.ref.id}`));
    const task = await mem.taskContext({ projectId, text: "state library semicolons x bug" }, exclude);
    expect(task.items.map((i) => i.text)).toEqual(["bug.x: Not always on"]);
    expect(task.text).toMatch(/^<recalled>\n.*\n- \[m:[a-z0-9]{6}\] \(open_issue, user\) bug\.x: Not always on\n<\/recalled>$/s);
  });

  it("records which items an answer cited; lists cited first, else what it was given", async () => {
    const a = await mem.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons" });
    const b = await mem.createMemory({ kind: "preference", scope: "global", key: "style.quotes", body: "Single quotes" });
    const block = await mem.alwaysOn();
    const s = h.createSession({ title: "t" });
    const m1 = h.appendMessage(s.id, { role: "assistant", content: "x" });
    const handleA = block.items.find((i) => i.ref.id === a.id)!.handle;
    mem.recordUse(m1.id, block.items, `Done, without semicolons [${handleA}].`, s.id);
    const used = await mem.getUsedMemories(m1.id);
    expect(used.map((u) => [u.ref.id, u.reasons[0]])).toEqual([[a.id, "cited"]]);
    expect((await mem.getMemory(a.id)).memory.useCount).toBe(1);
    expect((await mem.getMemory(b.id)).memory.useCount).toBe(0);
    const m2 = h.appendMessage(s.id, { role: "assistant", content: "y" });
    mem.recordUse(m2.id, block.items, "No citations here.", s.id);
    expect((await mem.getUsedMemories(m2.id)).map((u) => u.reasons[0])).toEqual(["provided", "provided"]);
    // With no citations, everything given counts as used.
    expect((await mem.getMemory(a.id)).memory.useCount).toBe(2);
    expect((await mem.getMemory(b.id)).memory.useCount).toBe(1);
    expect((await mem.getMemory(b.id)).events.map((e) => e.action)).toContain("injected");
  });
});

describe("helpers", () => {
  it("scans for secrets without flagging ordinary text", () => {
    expect(scanSecrets("Use pnpm and no semicolons")).toEqual([]);
    expect(scanSecrets("DATABASE_PASSWORD=hN3$kq9Lz!pW2rT7").map((f) => f.kind)).toEqual(["DATABASE_PASSWORD value"]);
    expect(scanSecrets("postgres://admin:hunter2pass@db.local/app").map((f) => f.kind)).toEqual(["connection string with a password"]);
    expect(scanSecrets("key AKIAABCDEFGHIJKLMNOP here")[0]).toMatchObject({ kind: "AWS access key", preview: "AKIA…OP" });
    expect(scanSecrets("THEME=solarized-dark-variant")).toEqual([]);
    // Lowercase names and plain language count too.
    expect(scanSecrets("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toHaveLength(1);
    expect(scanSecrets("prod db password: Xk9mP2vL8qZr4T")).toHaveLength(1);
    expect(scanSecrets("the api key is 7f3a9c2e1b8d4f60a5e7")).toHaveLength(1);
    // ...but not ordinary sentences about passwords.
    expect(scanSecrets("The password is stored in the keychain")).toEqual([]);
    expect(scanSecrets("token: required for every request")).toEqual([]);
    expect(scanSecrets("Passwords must be hashed with argon2id")).toEqual([]);
  });

  it("normalizes error signatures across machines", () => {
    const a = normalizeErrorSignature("Error: ENOENT /Users/a/x/app.js:10:3 0xdeadbeef");
    const b = normalizeErrorSignature("Error: ENOENT /home/b/y/app.js:99:1 0xfeedface");
    expect(a).toBe(b);
  });

  it("adds the task prefixes embedding models expect", () => {
    expect(withPrefix("mlx-community/embeddinggemma-300m-bf16", "q", "query")).toBe("task: search result | query: q");
    expect(withPrefix("embeddinggemma", "d", "document")).toBe("title: none | text: d");
    expect(withPrefix("other", "q", "query")).toBe("q");
  });
});

describe("privacy and consistency guards", () => {
  it("saves nothing, not even global memories, from inside a read-only or off project", async () => {
    await mem.updateSettings({ projectModes: { [projectId]: "read_only" } });
    const input = { kind: "preference" as const, scope: "global" as const, key: "client.api", body: "Acme uses billing.acme.local" };
    await expect(mem.remember(input, { contextProjectId: projectId })).rejects.toMatchObject({ code: "project_mode" });
    await mem.updateSettings({ projectModes: { [projectId]: "off" } });
    await expect(mem.remember(input, { contextProjectId: projectId })).rejects.toMatchObject({ code: "project_mode" });
    expect((await mem.listMemories({})).items).toEqual([]);
    // Without a project (a scratch session) global saves still work.
    await expect(mem.remember(input, {})).resolves.toMatchObject({ key: "client.api" });
  });

  it("won't pin or unpin in a read-only project", async () => {
    const m = await mem.createMemory({ kind: "decision", scope: "project", projectId, key: "db", body: "Postgres" });
    await mem.updateSettings({ projectModes: { [projectId]: "read_only" } });
    await expect(mem.setPinned(m.id, true)).rejects.toMatchObject({ code: "project_mode" });
    expect((await mem.getMemory(m.id)).memory.pinned).toBe(false);
  });

  it("refuses secrets in version bindings too", async () => {
    await expect(
      mem.createMemory({ kind: "convention", scope: "global", key: "gh", body: "pinned", appliesTo: { token: `ghp_${"a".repeat(36)}` } }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("doesn't record a memory as used after it was deleted mid-run", async () => {
    const a = await mem.createMemory({ kind: "preference", scope: "global", key: "tabs", body: "Use tabs" });
    const block = await mem.alwaysOn();
    await mem.deleteMemory(a.id);
    const s = h.createSession({ title: "t" });
    const m1 = h.appendMessage(s.id, { role: "assistant", content: "x" });
    mem.recordUse(m1.id, block.items, "Done.", s.id);
    expect(await mem.getUsedMemories(m1.id)).toEqual([]);
  });

  it("finds pinned memories that didn't fit the always-on budget", async () => {
    for (let i = 0; i < 8; i++) {
      await mem.createMemory({ kind: "lesson", scope: "global", key: `pinned.rule${i}`, body: `Rule ${i}: ${"detail ".repeat(40)}`, pinned: true });
    }
    const block = await mem.alwaysOn();
    expect(block.items.length).toBeLessThan(8);
    expect(block.tokens).toBeLessThanOrEqual(400);
    const exclude = new Set(block.items.map((i) => `${i.ref.type}:${i.ref.id}`));
    const left = await mem.taskContext({ text: "pinned rule detail" }, exclude);
    expect(left.items.length).toBeGreaterThan(0);
    expect(left.items.every((i) => !exclude.has(`${i.ref.type}:${i.ref.id}`))).toBe(true);
    expect(estimateTokensOf(left.text)).toBeLessThanOrEqual(1200);
  });

  it("an edit that moves a proposal to another subject leaves the conflicting memory alone, and can clear its version binding", async () => {
    const old = await mem.createMemory({ kind: "preference", scope: "global", key: "quotes", body: "double quotes" });
    const c = "mem_cand_q";
    db.prepare(
      `INSERT INTO memories (id, kind, scope, key, body, trust, status, evidence_json, review_after, conflicts_with, applies_to_json, created_at, updated_at)
       VALUES (?, 'preference', 'global', 'quotes.new', 'single quotes', 'inferred', 'pending_review', '[]', ?, ?, '{"react":"19.0"}', ?, ?)`,
    ).run(c, t + 1_000_000, old.id, t, t);
    await mem.resolveCandidate(c, { edit: { key: "quotes.jsx", appliesTo: null } });
    expect((await mem.getMemory(old.id)).memory.status).toBe("active");
    const moved = (await mem.listMemories({})).items.find((m) => m.key === "quotes.jsx")!;
    expect(moved.appliesTo).toBeUndefined();
  });

  it("never mixes two models' vectors when the model changes mid-reindex, and keeps vector search off until done", async () => {
    const slowA = fakeEmbedder({ model: "a", dims: 64 });
    const realEmbed = slowA.embed.bind(slowA);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let batches = 0;
    slowA.embed = async (texts: string[], kind: "query" | "document") => {
      if (++batches === 2) await gate; // pause on the second batch
      return realEmbed(texts, kind);
    };
    mem = memStore({ embedder: slowA });
    for (let i = 0; i < 70; i++) await mem.createMemory({ kind: "lesson", scope: "global", key: `k${i}`, body: `body ${i}` });
    const first = mem.reindex();
    await new Promise((r) => setTimeout(r, 20));
    expect(mem.vectorsReady()).toBe(false); // half-built: keywords only
    mem.setEmbedder(fakeEmbedder({ model: "b", dims: 32 }));
    const second = await mem.reindex();
    release();
    expect((await first).error).toMatch(/newer reindex/);
    expect(second.error).toBeUndefined();
    expect(db.prepare("SELECT model, dims FROM embedding_meta").get()).toEqual({ model: "b", dims: 32 });
    expect((db.prepare("SELECT count(*) AS n FROM memory_vec").get() as { n: number }).n).toBe(70);
    expect(mem.vectorsReady()).toBe(true);
  });
});

const estimateTokensOf = (s: string) => Math.ceil(s.length / 4);
