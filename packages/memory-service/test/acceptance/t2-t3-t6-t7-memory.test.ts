/**
 * Phase 2 acceptance tests (MASTER_PLAN.md › Evaluation and acceptance tests).
 *
 * T2 Preference recall   — a stated preference is in the always-on block of a new session.
 * T3 Project recall      — a saved architecture decision is retrieved for a related task
 *                          after a restart, and not for another project.
 * T6 Memory correction   — after an edit only the new value is retrievable; the old one is superseded.
 * T7 Memory deletion     — a deleted memory returns zero hits from FTS, vector search and retrieve().
 *
 * Each test writes to a database file, closes it ("restart") and reopens it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BlobStore, createHistoryStore, createMemoryStore, type Db, migrate, openDatabase } from "../../src/index.js";
import { fakeEmbedder } from "../helpers/fake-embedder.js";

let dir: string;
let db: Db | undefined;
const embedder = fakeEmbedder({ synonyms: { zustand: "statelib", redux: "statelib", store: "statelib", state: "statelib" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-p2-"));
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  db?.close();
  db = openDatabase(join(dir, "kovach.db"));
  migrate(db);
  const history = createHistoryStore(db, { blobs: new BlobStore(dir) });
  const memory = createMemoryStore(db, { embedder });
  return { history, memory, db };
}

function project(name: string, deps: Record<string, string> = {}) {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "package.json"), JSON.stringify({ name, dependencies: deps }));
  return p;
}

it("T2: a stated preference is in the always-on block of a new session after a restart", async () => {
  let s = open();
  await s.memory.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "Never use semicolons in TypeScript." });
  await s.memory.reindex();

  s = open(); // restart
  const app = s.history.ensureProject({ path: project("shop"), name: "shop" });
  const session = s.history.createSession({ projectId: app, title: "new task" });
  const block = await s.memory.alwaysOn(session.projectId);
  expect(block.text).toContain("style.semicolons: Never use semicolons in TypeScript.");
  expect(block.text).toContain("The user's current message wins");
  expect(block.items).toHaveLength(1);
});

it("T3: a saved decision is retrieved for a related task after a restart, and not for another project", async () => {
  let s = open();
  const shop = s.history.ensureProject({ path: project("shop", { react: "19.0.0" }), name: "shop" });
  const blog = s.history.ensureProject({ path: project("blog", { react: "19.0.0" }), name: "blog" });
  await s.memory.createMemory({
    kind: "decision",
    scope: "project",
    projectId: shop,
    key: "arch.state",
    body: "Use Zustand for global state; no Redux.",
  });
  await s.memory.reindex();

  s = open(); // restart
  const related = await s.memory.retrieve({ projectId: shop, text: "Add a redux store for the cart" });
  expect(related.items.map((i) => i.text)).toEqual(["arch.state: Use Zustand for global state; no Redux."]);
  // Decisions are also always on for their own project...
  expect((await s.memory.alwaysOn(shop)).text).toContain("arch.state");
  // ...and invisible to another project, both ways.
  expect((await s.memory.retrieve({ projectId: blog, text: "Add a redux store for the cart" })).items).toEqual([]);
  expect((await s.memory.alwaysOn(blog)).text).not.toContain("arch.state");
});

it("T6: after an edit only the new value is retrievable; the old one is superseded", async () => {
  let s = open();
  const first = await s.memory.createMemory({ kind: "preference", scope: "global", key: "style.indent", body: "Indent with 2 spaces." });
  await s.memory.reindex();
  const second = await s.memory.updateMemory(first.id, { body: "Indent with tabs." });

  s = open(); // restart
  expect((await s.memory.getMemory(first.id)).memory.status).toBe("superseded");
  expect((await s.memory.getMemory(second.id)).memory).toMatchObject({ status: "active", supersedesId: first.id });
  for (const text of ["indent spaces", "indent tabs", "how should I indent"]) {
    const r = await s.memory.retrieve({ text });
    expect(r.items.map((i) => i.ref.id)).not.toContain(first.id);
  }
  expect((await s.memory.alwaysOn()).text).toContain("Indent with tabs.");
  expect((await s.memory.alwaysOn()).text).not.toContain("2 spaces");
  expect((await s.memory.listMemories({})).items.map((m) => m.body)).toEqual(["Indent with tabs."]);
});

it("T7: a deleted memory returns zero hits from FTS, vector search and retrieve()", async () => {
  let s = open();
  const keep = await s.memory.createMemory({ kind: "lesson", scope: "global", key: "metro.cache", body: "Clear the Metro cache after upgrading Reanimated." });
  const gone = await s.memory.createMemory({ kind: "lesson", scope: "global", key: "metro.reset", body: "Reset the Metro bundler cache with expo start -c." });
  const edited = await s.memory.updateMemory(gone.id, { body: "Reset the Metro cache with expo start --clear." });
  await s.memory.reindex();
  const sess = s.history.createSession({});
  const msg = s.history.appendMessage(sess.id, { role: "assistant", content: "x" });
  s.memory.recordUse(msg.id, (await s.memory.taskContext({ text: "metro cache" })).items, "x");
  expect((await s.memory.getUsedMemories(msg.id)).some((u) => u.ref.id === edited.id)).toBe(true);

  await s.memory.deleteMemory(edited.id); // the current version and its history

  s = open(); // restart
  const ids = [gone.id, edited.id];
  const fts = s.db.prepare("SELECT ref_id FROM memory_fts WHERE memory_fts MATCH 'metro'").all() as { ref_id: string }[];
  expect(fts.map((r) => r.ref_id)).toEqual([keep.id]);
  const vec = s.db.prepare("SELECT ref_key FROM memory_vec").all() as { ref_key: string }[];
  expect(vec.map((r) => r.ref_key)).toEqual([`memory:${keep.id}`]);
  const r = await s.memory.retrieve({ text: "reset metro bundler cache expo start clear" });
  expect(r.items.map((i) => i.ref.id)).toEqual([keep.id]);
  expect(await s.memory.getUsedMemories(msg.id)).toEqual(expect.not.arrayContaining([expect.objectContaining({ ref: { type: "memory", id: edited.id } })]));
  expect(s.db.prepare(`SELECT count(*) AS n FROM memories WHERE id IN (?, ?)`).get(...ids)).toEqual({ n: 0 });
  await expect(s.memory.getMemory(edited.id)).rejects.toMatchObject({ code: "not_found" });
});
