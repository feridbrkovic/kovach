import { describe, expect, it, vi } from "vitest";
import {
  Candidate,
  DocSuggestion,
  Memory,
  type MemoryApi,
  MemoryApiError,
  type MemoryChangeEvent,
  MemoryEvent,
  MemorySettings,
  MessageHit,
  RETRIEVAL_BUDGET,
  RetrieveResult,
  SessionDetail,
  SessionSummary,
} from "../src/index.js";
import { createMockMemoryApi, demoSeed } from "../src/mock.js";

const APP = "proj_shop_app";
const API = "proj_billing_api";

function clock(start = 1_000) {
  let t = start;
  return () => ++t;
}

function demo(extra: Parameters<typeof createMockMemoryApi>[0] = {}): MemoryApi {
  return createMockMemoryApi({ seed: demoSeed(), now: clock(Date.UTC(2026, 10, 9)), ...extra });
}

function changes(api: MemoryApi) {
  const seen: MemoryChangeEvent[] = [];
  api.onChange((e) => seen.push(e));
  return seen;
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(MemoryApiError);
  await expect(p).rejects.toMatchObject({ code });
}

describe("demo seed", () => {
  it("passes the contract schemas for every list the UI reads", async () => {
    const api = demo();
    const sessions = await api.listSessions({});
    expect(sessions.items.length).toBe(3);
    for (const s of sessions.items) SessionSummary.parse(s);
    SessionDetail.parse(await api.getSession(sessions.items[0]!.id));
    for (const m of (await api.listMemories({})).items) Memory.parse(m);
    for (const c of await api.listCandidates()) Candidate.parse(c);
    MemorySettings.parse(await api.getSettings());
    expect((await api.listDocPacks(APP)).map((p) => p.status)).toContain("stale");
    expect(await api.getUsedMemories("ses_d001_m1")).toHaveLength(1);
  });
});

describe("history", () => {
  it("lists newest first and filters by project and query", async () => {
    const api = demo();
    const all = await api.listSessions({});
    expect(all.items.map((s) => s.id)).toEqual(["ses_d003", "ses_d002", "ses_d001"]);
    expect((await api.listSessions({ projectId: API })).items.map((s) => s.id)).toEqual(["ses_d003"]);
    expect((await api.listSessions({ query: "cart" })).items.map((s) => s.id)).toEqual(["ses_d002"]);
  });

  it("pages with an opaque cursor", async () => {
    const api = demo({ pageSize: 2 });
    const p1 = await api.listSessions({});
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await api.listSessions({ cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    await rejectsWith(api.listSessions({ cursor: "nope" }), "invalid");
  });

  it("pages a session's messages newest first with latest", async () => {
    const api = demo({ pageSize: 1 });
    const p1 = await api.getSession("ses_d002", { latest: true });
    expect(p1.messages.items.map((m) => m.role)).toEqual(["assistant"]);
    const p2 = await api.getSession("ses_d002", { latest: true, cursor: p1.messages.nextCursor! });
    expect(p2.messages.items.map((m) => m.role)).toEqual(["user"]);
    expect(p2.messages.nextCursor).toBeUndefined();
    await rejectsWith(api.getSession("ses_d002", { latest: true, cursor: "nope" }), "invalid");
  });

  it("resolves a proposal's evidence to the message and its session", async () => {
    const api = demo();
    expect(await api.getEvidence("cand_d001")).toEqual([
      { type: "message", id: "ses_d003_m0", excerpt: "Invoices show yesterday's date for customers in UTC+1.", sessionId: "ses_d003", messageId: "ses_d003_m0", role: "user" },
    ]);
    await api.deleteSession("ses_d003");
    expect(await api.getEvidence("cand_d001")).toEqual([{ type: "message", id: "ses_d003_m0", excerpt: "", missing: true }]);
    await rejectsWith(api.getEvidence("nope"), "not_found");
  });

  it("renames and deletes sessions, emitting changes", async () => {
    const api = demo();
    const seen = changes(api);
    await api.renameSession("ses_d001", "  Reanimated crash  ");
    expect((await api.getSession("ses_d001")).session.title).toBe("Reanimated crash");
    await rejectsWith(api.renameSession("ses_d001", "   "), "invalid");
    await api.deleteSession("ses_d001");
    await rejectsWith(api.getSession("ses_d001"), "not_found");
    expect(await api.getUsedMemories("ses_d001_m1")).toEqual([]);
    expect(seen).toEqual([
      { type: "session", action: "updated", id: "ses_d001" },
      { type: "session", action: "deleted", id: "ses_d001" },
    ]);
  });

  it("searches message text with snippets", async () => {
    const api = demo();
    const hits = await api.searchMessages({ query: "METRO" });
    expect(hits.items).toHaveLength(1);
    const hit = MessageHit.parse(hits.items[0]);
    expect(hit.messageId).toBe("ses_d001_m1");
    expect(hit.snippet.toLowerCase()).toContain("metro");
    expect((await api.searchMessages({ query: "metro", projectId: API })).items).toEqual([]);
  });

  it("clears history for one project or all", async () => {
    const api = demo();
    await api.clearHistory({ projectId: APP });
    expect((await api.listSessions({})).items.map((s) => s.id)).toEqual(["ses_d003"]);
    await api.clearHistory({});
    expect((await api.listSessions({})).items).toEqual([]);
  });
});

describe("memories", () => {
  it("creates user-trusted active memories and validates input", async () => {
    const api = createMockMemoryApi({ now: clock() });
    const m = await api.createMemory({ kind: "preference", scope: "global", key: "style.quotes", body: "Double quotes." });
    expect(m).toMatchObject({ trust: "user", status: "active", pinned: false, useCount: 0, evidence: [] });
    await rejectsWith(api.createMemory({ kind: "decision", scope: "project", key: "k", body: "b" } as never), "invalid");
  });

  it("supersedes an active memory with the same subject on create", async () => {
    const api = createMockMemoryApi({ now: clock() });
    const a = await api.createMemory({ kind: "preference", scope: "global", key: "k", body: "one" });
    const b = await api.createMemory({ kind: "preference", scope: "global", key: "k", body: "two" });
    expect(b.supersedesId).toBe(a.id);
    expect((await api.getMemory(a.id)).memory.status).toBe("superseded");
    // A different scope is a different subject.
    const c = await api.createMemory({ kind: "preference", scope: "project", projectId: "p1", key: "k", body: "p" });
    expect(c.supersedesId).toBeUndefined();
  });

  it("edits as a new version; only the new value is retrievable (T6 shape)", async () => {
    const api = demo();
    const seen = changes(api);
    const next = await api.updateMemory("mem_d003", { body: "Use Jotai for client state; no Redux." });
    expect(next.id).not.toBe("mem_d003");
    expect(next.supersedesId).toBe("mem_d003");
    const detail = await api.getMemory(next.id);
    expect(detail.history.map((m) => m.id)).toEqual(["mem_d003"]);
    expect(detail.history[0]!.status).toBe("superseded");
    expect(detail.events.map((e) => e.action)).toEqual(["edited", "superseded"]);
    for (const e of detail.events) MemoryEvent.parse(e);
    expect(seen.map((e) => e.type === "memory" && e.action)).toEqual(["edited", "superseded"]);

    const r = await api.retrieve({ projectId: APP, text: "which client state library" });
    const texts = r.items.map((i) => i.text);
    expect(texts).toContain("Use Jotai for client state; no Redux.");
    expect(texts).not.toContain("Use Zustand for client state; no Redux.");

    await rejectsWith(api.updateMemory("mem_d003", { body: "again" }), "conflict");
    await rejectsWith(api.updateMemory(next.id, {} as never), "invalid");
  });

  it("removes appliesTo when patched with null", async () => {
    const api = demo();
    const next = await api.updateMemory("mem_d003", { appliesTo: null });
    expect(next.appliesTo).toBeUndefined();
  });

  it("hard-deletes a memory with its old versions (T7 shape)", async () => {
    const api = demo();
    await api.deleteMemory("mem_d009");
    await rejectsWith(api.getMemory("mem_d009"), "not_found");
    await rejectsWith(api.getMemory("mem_d008"), "not_found");
    const r = await api.retrieve({ text: "pnpm package manager projects" });
    expect(r.items.find((i) => i.ref.id === "mem_d009")).toBeUndefined();

    await api.deleteMemory("mem_d003");
    expect(await api.getUsedMemories("ses_d001_m1")).toEqual([]);
  });

  it("lists current memories by default, project plus global, pinned first", async () => {
    const api = demo();
    const all = (await api.listMemories({})).items;
    expect(all.map((m) => m.id)).not.toContain("mem_d008");
    expect(all[0]!.pinned).toBe(true);

    const app = (await api.listMemories({ projectId: APP })).items;
    expect(app.every((m) => m.scope === "global" || m.projectId === APP)).toBe(true);
    expect(app.map((m) => m.id)).not.toContain("mem_d005");

    expect((await api.listMemories({ status: "superseded" })).items.map((m) => m.id)).toEqual(["mem_d008"]);
    expect((await api.listMemories({ kind: "open_issue" })).items.map((m) => m.id)).toEqual(["mem_d006"]);
    expect((await api.listMemories({ query: "zustand" })).items.map((m) => m.id)).toEqual(["mem_d003"]);
  });

  it("pins in place without a new version", async () => {
    const api = demo();
    await api.setPinned("mem_d004", true);
    const { memory, history } = await api.getMemory("mem_d004");
    expect(memory.pinned).toBe(true);
    expect(history).toEqual([]);
    await rejectsWith(api.setPinned("missing", true), "not_found");
  });

  it("refuses writes to read_only projects", async () => {
    const api = demo();
    await rejectsWith(
      api.createMemory({ kind: "decision", scope: "project", projectId: API, key: "k", body: "b" }),
      "project_mode",
    );
  });

  it("returns copies, so callers cannot change the store", async () => {
    const api = demo();
    const m = (await api.getMemory("mem_d004")).memory;
    m.body = "mutated";
    expect((await api.getMemory("mem_d004")).memory.body).not.toBe("mutated");
  });
});

describe("review inbox", () => {
  it("accepts a candidate as a user-trusted memory with its evidence", async () => {
    const api = demo({ seed: { ...demoSeed(), settings: { ...demoSeed().settings!, projectModes: {} } } });
    const seen = changes(api);
    await api.resolveCandidate("cand_d001", "accept");
    expect((await api.listCandidates()).map((c) => c.id)).toEqual(["cand_d002"]);
    const created = (await api.listMemories({ query: "customer's timezone" })).items[0]!;
    expect(created).toMatchObject({ trust: "user", status: "active", projectId: API });
    expect(created.evidence).toEqual([{ type: "message", id: "ses_d003_m0" }]);
    expect(seen.at(-1)).toEqual({ type: "candidate", action: "resolved", id: "cand_d001" });
  });

  it("accepting a conflict supersedes the conflicting memory", async () => {
    const api = demo();
    await api.resolveCandidate("cand_d002", "accept");
    expect((await api.getMemory("mem_d009")).memory.status).toBe("superseded");
  });

  it("applies an edit before accepting, and rejects without creating anything", async () => {
    const api = demo();
    await api.resolveCandidate("cand_d002", { edit: { body: "Use bun only for scripts." } });
    expect((await api.listMemories({ query: "bun only" })).items).toHaveLength(1);

    const api2 = demo();
    const before = (await api2.listMemories({})).items.length;
    await api2.resolveCandidate("cand_d002", "reject");
    expect((await api2.listMemories({})).items.length).toBe(before);
    await rejectsWith(api2.resolveCandidate("cand_d002", "accept"), "not_found");
    await rejectsWith(api2.resolveCandidate("cand_d001", "maybe" as never), "invalid");
  });

  it("counts review decisions by origin, edits apart, refused writes not at all (1.3)", async () => {
    const readOnly = demo();
    await rejectsWith(readOnly.resolveCandidate("cand_d001", "accept"), "project_mode");
    expect((await readOnly.reviewStats()).fromSessions).toEqual({ accepted: 0, edited: 0, rejected: 0 });
    const api = demo({ seed: { ...demoSeed(), settings: { ...demoSeed().settings!, projectModes: {} } } });
    expect(await api.reviewStats()).toMatchObject({ fromSessions: { accepted: 0, edited: 0, rejected: 0 }, fromFiles: { accepted: 0, edited: 0, rejected: 0 } });
    await api.resolveCandidate("cand_d001", "accept");
    await api.resolveCandidate("cand_d002", { edit: { body: "Use bun only for scripts." } });
    const s = await api.reviewStats();
    expect(s.fromSessions).toEqual({ accepted: 2, edited: 1, rejected: 0 });
    expect(s.fromFiles).toEqual({ accepted: 0, edited: 0, rejected: 0 });
    const api2 = demo();
    await api2.resolveCandidate("cand_d002", "reject");
    expect((await api2.reviewStats()).fromSessions).toEqual({ accepted: 0, edited: 0, rejected: 1 });
  });

  it("drops expired candidates", async () => {
    const api = createMockMemoryApi({ seed: demoSeed(), now: () => Date.UTC(2027, 0, 1) });
    const seen = changes(api);
    expect(await api.listCandidates()).toEqual([]);
    expect(seen.filter((e) => e.type === "candidate" && e.action === "expired")).toHaveLength(2);
  });
});

describe("retrieval", () => {
  it("ranks an exact error signature first", async () => {
    const api = demo();
    const r = RetrieveResult.parse(
      await api.retrieve({
        projectId: APP,
        text: "app crashes on launch",
        errorOutput:
          "Error: ReanimatedError: [Reanimated] Mismatch between JavaScript part and native part of Reanimated",
      }),
    );
    expect(r.items[0]!.ref).toEqual({ type: "episode", id: "epi_d001" });
    expect(r.items[0]!.reasons[0]).toBe("error_signature_match");
    expect(r.items[0]!.text).toContain("Fix:");
  });

  it("shows other projects only the lesson of an episode", async () => {
    const api = demo();
    const r = await api.retrieve({
      projectId: API,
      text: "crash",
      errorOutput: "ReanimatedError: [Reanimated] Mismatch between JavaScript part and native part",
    });
    const ep = r.items.find((i) => i.ref.type === "episode")!;
    expect(ep.text).toBe("After upgrading Reanimated, clear the Metro cache before debugging native code.");
    expect(ep.reasons).toContain("cross_project_lesson");
  });

  it("never returns another project's memories or pinned memories", async () => {
    const api = demo();
    const r = await api.retrieve({ projectId: API, text: "client state zustand semicolons typescript" });
    const ids = r.items.map((i) => i.ref.id);
    expect(ids).not.toContain("mem_d003");
    expect(ids).not.toContain("mem_d001");
  });

  it("labels memories bound to another major version as possibly outdated", async () => {
    const api = demo();
    const r = await api.retrieve({ projectId: APP, text: "expo router typed routes" });
    const item = r.items.find((i) => i.ref.id === "mem_d007")!;
    expect(item.possiblyOutdated).toBe(true);
    expect(item.reasons).toContain("version_mismatch");
  });

  it("returns nothing for projects in off mode", async () => {
    const api = demo();
    await api.updateSettings({ projectModes: { [APP]: "off" } });
    expect(await api.retrieve({ projectId: APP, text: "client state zustand" })).toEqual({ items: [], tokens: 0 });
  });

  it("keeps to the task budget", async () => {
    const api = createMockMemoryApi({ now: clock() });
    for (let i = 0; i < 12; i++) {
      await api.createMemory({ kind: "lesson", scope: "global", key: `k${i}`, body: `metro cache note ${i} ${"x".repeat(900)}` });
    }
    const r = await api.retrieve({ text: "metro cache" });
    expect(r.items.length).toBeLessThanOrEqual(RETRIEVAL_BUDGET.maxTaskItems);
    expect(r.tokens).toBeLessThanOrEqual(RETRIEVAL_BUDGET.taskTokens);
    expect(r.tokens).toBe(r.items.reduce((n, i) => n + i.tokens, 0));
    await rejectsWith(api.retrieve({ text: "" }), "invalid");
  });
});

describe("docs packs, settings, data", () => {
  it("runs a docs pack job through its states and marks the old pack stale", async () => {
    const api = demo();
    const jobs: string[] = [];
    api.onChange((e) => e.type === "job" && jobs.push(e.job.status));
    const job = await api.buildDocPack(APP, "react-native", "0.77");
    expect(job).toMatchObject({ kind: "doc_pack", status: "queued" });
    await vi.waitFor(() => expect(jobs).toEqual(["queued", "running", "done"]));
    const packs = await api.listDocPacks(APP);
    expect(packs.find((p) => p.version === "0.76")!.status).toBe("stale");
    expect(packs.find((p) => p.version === "0.77")!.status).toBe("ready");
    expect((await api.listDocPacks(API)).some((p) => p.library === "react-native")).toBe(false);
    await rejectsWith(api.buildDocPack("", "react-native", "0.77"), "invalid");
  });

  it("suggests packs for the libraries a project uses, and seeding is safe to call (1.1)", async () => {
    const api = demo();
    const s = await api.suggestDocPacks(APP);
    for (const item of s) expect(() => DocSuggestion.parse(item)).not.toThrow();
    expect(s.some((x) => x.library === "react-native")).toBe(true);
    expect(await api.seedProject(APP)).toEqual({ created: 0, files: [] });
    await rejectsWith(api.seedProject(" "), "invalid");
  });

  it("lists, finds and deletes verified fixes (1.2)", async () => {
    const api = demo();
    const all = (await api.listEpisodes({})).items;
    expect(all.length).toBeGreaterThan(0);
    const ep = all[0]!;
    expect(await api.getEpisode(ep.id)).toEqual(ep);
    expect((await api.listEpisodes({ query: ep.problem.slice(0, 12) })).items.map((e) => e.id)).toContain(ep.id);
    const events: string[] = [];
    api.onChange((e) => e.type === "episode" && events.push(`${e.action}:${e.id}`));
    await api.deleteEpisode(ep.id);
    expect(events).toEqual([`deleted:${ep.id}`]);
    await rejectsWith(api.getEpisode(ep.id), "not_found");
  });

  it("merges and validates settings", async () => {
    const api = demo();
    const s = await api.updateSettings({ autoExtract: false });
    expect(s.autoExtract).toBe(false);
    expect(s.embeddingModel).toBe("embeddinggemma");
    await rejectsWith(api.updateSettings({ autoExtract: "yes" as never }), "invalid");
  });

  it("round-trips export and import, skipping rows that already exist", async () => {
    const api = demo();
    const { path } = await api.exportData();
    await api.deleteMemory("mem_d004");
    await api.deleteSession("ses_d002");
    const report = await api.importData(path);
    expect(report).toMatchObject({ memories: 1, sessions: 1, warnings: [] });
    expect(report.skipped).toBeGreaterThan(0);
    expect((await api.getSession("ses_d002")).messages.items).toHaveLength(2);
    expect((await api.importData("/nowhere.json")).warnings).toHaveLength(1);
  });

  it("stops notifying after unsubscribe and survives a throwing listener", async () => {
    const api = demo();
    api.onChange(() => {
      throw new Error("boom");
    });
    const seen: MemoryChangeEvent[] = [];
    const off = api.onChange((e) => seen.push(e));
    await api.setPinned("mem_d004", true);
    off();
    await api.setPinned("mem_d004", false);
    expect(seen).toHaveLength(1);
  });

  it("can simulate latency for loading states", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockMemoryApi({ latencyMs: 300 });
      let done = false;
      const p = api.getSettings().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
