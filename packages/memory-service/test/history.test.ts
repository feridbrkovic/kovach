import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemoryChangeEvent, MemoryApiError, SessionDetail } from "@kovach-dev/memory-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  createHistoryStore,
  type Db,
  EXCERPT_MAX_BYTES,
  ftsQuery,
  type HistoryStore,
  migrate,
  openDatabase,
  utf8Prefix,
} from "../src/index.js";

let dir: string;
let db: Db;
let blobs: BlobStore;
let h: HistoryStore;
let t: number;
let n: number;

function store(extra: Partial<Parameters<typeof createHistoryStore>[1]> = {}) {
  return createHistoryStore(db, { blobs, now: () => ++t, newId: (p) => `${p}${++n}`, ...extra });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-history-"));
  db = openDatabase(":memory:");
  migrate(db);
  blobs = new BlobStore(dir);
  t = 1_000;
  n = 0;
  h = store();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rejectsWith(p: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof p === "function" ? Promise.resolve().then(p) : p;
  await expect(run).rejects.toBeInstanceOf(MemoryApiError);
  await expect(run).rejects.toMatchObject({ code });
}

describe("utf8Prefix", () => {
  it("never splits a multi-byte character", () => {
    const s = "a" + "č".repeat(10); // č is 2 bytes
    expect(utf8Prefix(s, 4)).toBe("ač");
    expect(utf8Prefix(s, 5)).toBe("ačč");
    expect(utf8Prefix("short", 100)).toBe("short");
  });
});

describe("projects and sessions", () => {
  it("creates a project once per path; client work defaults to read_only", () => {
    const a = h.ensureProject({ path: "/p/shop", name: "shop" });
    expect(h.ensureProject({ path: "/p/shop", name: "renamed" })).toBe(a);
    const c = h.ensureProject({ path: "/p/client", name: "client", isClient: true });
    const mode = db.prepare("SELECT memory_mode FROM projects WHERE id = ?").get(c) as { memory_mode: string };
    expect(mode.memory_mode).toBe("read_only");
    expect(h.getProject(c)).toMatchObject({ path: "/p/client", name: "client", memoryMode: "read_only", isClient: true });
    expect(h.getProject("missing")).toBeUndefined();
    // Most recently used first: a session in "shop" moves it to the top.
    expect(h.listProjects().map((p) => p.name)).toEqual(["client", "shop"]);
    h.createSession({ projectId: a });
    expect(h.listProjects().map((p) => p.name)).toEqual(["shop", "client"]);
  });

  it("creates, renames and lists sessions newest first, filtered by project and query", async () => {
    const p = h.ensureProject({ path: "/p/shop", name: "shop" });
    const s1 = h.createSession({ projectId: p, title: "Cart badge", model: "qwen" });
    const s2 = h.createSession({ title: "Invoice timezone" });
    h.appendMessage(s1.id, { role: "user", content: "hi" });

    expect((await h.listSessions({})).items.map((s) => s.id)).toEqual([s1.id, s2.id]);
    expect((await h.listSessions({ projectId: p })).items.map((s) => s.id)).toEqual([s1.id]);
    expect((await h.listSessions({ query: "timezone" })).items.map((s) => s.id)).toEqual([s2.id]);
    expect((await h.listSessions({ query: "100%" })).items).toEqual([]);

    await h.renameSession(s2.id, "  Invoice dates  ");
    const top = (await h.listSessions({})).items[0]!;
    expect(top).toMatchObject({ id: s2.id, title: "Invoice dates", messageCount: 0 });
    await rejectsWith(h.renameSession(s2.id, " "), "invalid");
    await rejectsWith(h.renameSession("nope", "x"), "not_found");
    await rejectsWith(() => h.createSession({ projectId: "missing" }), "not_found");
  });

  it("pages sessions with a keyset cursor", async () => {
    h = store({ pageSize: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => h.createSession({ title: `s${i}` }).id).reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.listSessions(cursor === undefined ? {} : { cursor });
      seen.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    await rejectsWith(h.listSessions({ cursor: "garbage" }), "invalid");
  });
});

describe("messages and tool calls", () => {
  it("stores tool calls on the requesting message and completes them later", async () => {
    const s = h.createSession();
    h.appendMessage(s.id, { role: "user", content: "run the tests" });
    const m = h.appendMessage(s.id, {
      role: "assistant",
      content: "Running tests.",
      tokens: 4,
      toolCalls: [{ name: "shell", args: { command: "pnpm test" }, command: "pnpm test" }],
    });
    const call = m.toolCalls[0]!;
    expect(call).toMatchObject({ name: "shell", command: "pnpm test", args: { command: "pnpm test" } });
    expect(call.exitCode).toBeUndefined();

    const done = h.completeToolCall(call.id, { exitCode: 1, output: "1 failed", durationMs: 420 });
    expect(done).toMatchObject({ exitCode: 1, outputExcerpt: "1 failed", durationMs: 420 });
    expect(done.outputPath).toBeUndefined();
    await rejectsWith(() => h.completeToolCall(call.id, { exitCode: 0 }), "conflict");
    await rejectsWith(() => h.completeToolCall("nope", {}), "not_found");

    const detail = SessionDetail.parse(await h.getSession(s.id));
    expect(detail.session.messageCount).toBe(2);
    expect(detail.messages.items.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(detail.messages.items[1]!.toolCalls[0]!.exitCode).toBe(1);
  });

  it("keeps an 8 KB excerpt in the database and the full output in a blob", () => {
    const s = h.createSession();
    const m = h.appendMessage(s.id, { role: "assistant", content: "build", toolCalls: [{ name: "shell" }] });
    const long = "ž".repeat(6000); // 12,000 bytes
    const done = h.completeToolCall(m.toolCalls[0]!.id, { exitCode: 0, output: long });
    expect(Buffer.byteLength(done.outputExcerpt!, "utf8")).toBeLessThanOrEqual(EXCERPT_MAX_BYTES);
    expect(done.outputExcerpt).toBe("ž".repeat(4096));
    expect(done.outputPath).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(h.readToolOutput(m.toolCalls[0]!.id)).toBe(long);
  });

  it("redacts tool output before storing it", () => {
    h = store({ redactOutput: (s) => s.replace(/sk_live_\w+/g, "[REDACTED]") });
    const s = h.createSession();
    const m = h.appendMessage(s.id, { role: "assistant", content: "env", toolCalls: [{ name: "shell" }] });
    const done = h.completeToolCall(m.toolCalls[0]!.id, { output: "STRIPE=sk_live_abc123" });
    expect(done.outputExcerpt).toBe("STRIPE=[REDACTED]");
  });

  it("pages messages oldest first", async () => {
    h = store({ pageSize: 3 });
    const s = h.createSession();
    for (let i = 0; i < 7; i++) h.appendMessage(s.id, { role: "user", content: `m${i}` });
    const contents: string[] = [];
    let cursor: string | undefined;
    do {
      const d = await h.getSession(s.id, cursor === undefined ? undefined : { cursor });
      contents.push(...d.messages.items.map((m) => m.content));
      cursor = d.messages.nextCursor;
    } while (cursor);
    expect(contents).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("pages newest first with latest, each page in order, back to the first message", async () => {
    h = store({ pageSize: 3 });
    const s = h.createSession();
    for (let i = 0; i < 7; i++) h.appendMessage(s.id, { role: "user", content: `m${i}` });
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const d = await h.getSession(s.id, { latest: true, ...(cursor === undefined ? {} : { cursor }) });
      pages.push(d.messages.items.map((m) => m.content));
      cursor = d.messages.nextCursor;
    } while (cursor);
    expect(pages).toEqual([["m4", "m5", "m6"], ["m1", "m2", "m3"], ["m0"]]);
    // A session that fits in one page has no cursor.
    const small = h.createSession();
    h.appendMessage(small.id, { role: "user", content: "only" });
    expect((await h.getSession(small.id, { latest: true })).messages).toEqual({ items: [expect.objectContaining({ content: "only" })] });
  });

  it("resumes with the summary and the last N messages", () => {
    const s = h.createSession();
    for (let i = 0; i < 5; i++) h.appendMessage(s.id, { role: i % 2 ? "assistant" : "user", content: `m${i}` });
    h.setSummary(s.id, "Fixed the cart total.");
    const r = h.resume(s.id, { lastN: 2 });
    expect(r.summary).toBe("Fixed the cart total.");
    expect(r.messages.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(h.resume(s.id, { lastN: 0 }).messages).toEqual([]);
    expect(() => h.resume(s.id, { lastN: -1 })).toThrow(MemoryApiError);
  });
});

describe("search", () => {
  it("builds safe FTS queries from free text", () => {
    expect(ftsQuery('metro "cache" OR')).toBe('"metro" "cache" "OR"*');
    expect(() => ftsQuery("  ** ")).toThrow(MemoryApiError);
  });

  it("finds messages by words and prefixes, scoped by project", async () => {
    const p = h.ensureProject({ path: "/p/app", name: "app" });
    const a = h.createSession({ projectId: p });
    const b = h.createSession();
    h.appendMessage(a.id, { role: "user", content: "The Metro cache breaks after upgrading reanimated." });
    h.appendMessage(b.id, { role: "user", content: "Metro bundler is slow on CI." });
    h.appendMessage(b.id, { role: "user", content: "Unrelated: invoice dates." });

    const all = await h.searchMessages({ query: "metro" });
    expect(all.items).toHaveLength(2);
    const scoped = await h.searchMessages({ query: "metro reanim", projectId: p });
    expect(scoped.items.map((x) => x.sessionId)).toEqual([a.id]);
    expect(scoped.items[0]!.snippet.toLowerCase()).toContain("reanimated");
    expect(scoped.items[0]!.score).toBeGreaterThan(0);
    // Characters that are FTS5 syntax don't break the query.
    expect((await h.searchMessages({ query: 'cache" (*' })).items).toHaveLength(1);
    // Operator words are plain words: "OR" must appear in the text, it doesn't widen the search.
    expect((await h.searchMessages({ query: "cache OR invoice" })).items).toEqual([]);
  });

  it("pages search hits", async () => {
    h = store({ pageSize: 2 });
    const s = h.createSession();
    for (let i = 0; i < 5; i++) h.appendMessage(s.id, { role: "user", content: `deploy step ${i}` });
    const p1 = await h.searchMessages({ query: "deploy" });
    const p2 = await h.searchMessages({ query: "deploy", cursor: p1.nextCursor! });
    const p3 = await h.searchMessages({ query: "deploy", cursor: p2.nextCursor! });
    const ids = [...p1.items, ...p2.items, ...p3.items].map((x) => x.messageId);
    expect(new Set(ids).size).toBe(5);
    expect(p3.nextCursor).toBeUndefined();
  });
});

describe("deleting", () => {
  it("hard-deletes a session: messages, tool calls, search rows and unshared blobs", async () => {
    const s = h.createSession();
    const other = h.createSession();
    const big = "x".repeat(EXCERPT_MAX_BYTES + 10);
    const m = h.appendMessage(s.id, { role: "assistant", content: "secret plan", toolCalls: [{ name: "shell" }, { name: "shell" }] });
    h.completeToolCall(m.toolCalls[0]!.id, { output: big });
    h.completeToolCall(m.toolCalls[1]!.id, { output: `${big}unique` });
    // The other session shares the first blob (same output), so that file must survive.
    const o = h.appendMessage(other.id, { role: "assistant", content: "same output", toolCalls: [{ name: "shell" }] });
    h.completeToolCall(o.toolCalls[0]!.id, { output: big });
    const blobFiles = () => readdirSync(blobs.root, { recursive: true }).filter((f) => String(f).length > 3);
    expect(blobFiles()).toHaveLength(2);

    await h.deleteSession(s.id);
    await rejectsWith(h.getSession(s.id), "not_found");
    expect((await h.searchMessages({ query: "secret" })).items).toEqual([]);
    expect(db.prepare("SELECT count(*) AS c FROM tool_calls").get()).toEqual({ c: 1 });
    expect(blobFiles()).toHaveLength(1);
    expect(h.readToolOutput(o.toolCalls[0]!.id)).toBe(big);
    await rejectsWith(h.deleteSession(s.id), "not_found");
  });

  it("clears history for one project or everything, then vacuums", async () => {
    const p = h.ensureProject({ path: "/p/a", name: "a" });
    h.createSession({ projectId: p });
    h.createSession({ projectId: p });
    const keep = h.createSession();
    await h.clearHistory({ projectId: p });
    expect((await h.listSessions({})).items.map((s) => s.id)).toEqual([keep.id]);
    await h.clearHistory({});
    expect((await h.listSessions({})).items).toEqual([]);
    expect(() => h.vacuum()).not.toThrow();
  });
});

describe("change events", () => {
  it("emits created, updated and deleted, and survives a throwing listener", async () => {
    const seen: MemoryChangeEvent[] = [];
    h.onChange(() => {
      throw new Error("boom");
    });
    const off = h.onChange((e) => seen.push(e));
    const s = h.createSession();
    h.appendMessage(s.id, { role: "user", content: "x" });
    await h.deleteSession(s.id);
    off();
    h.createSession();
    expect(seen).toEqual([
      { type: "session", action: "created", id: s.id },
      { type: "session", action: "updated", id: s.id },
      { type: "session", action: "deleted", id: s.id },
    ]);
  });
});
