/**
 * In-memory implementation of `MemoryApi` for UI work and tests.
 *
 * Follows the contract's rules (validation, supersession, hard delete, review
 * inbox) closely enough that screens built against it behave the same once the
 * real service lands. Retrieval is a deterministic keyword score, not the
 * hybrid search of the real service.
 *
 * Import from "@kovach-dev/memory-contract/mock". Never ship it in the app.
 */
import type { z } from "zod";
import {
  Candidate,
  CandidateResolution,
  DocPack,
  Episode,
  ImportReport,
  type DocSuggestion,
  type EvidenceItem,
  type JobRef,
  Memory,
  MemoryApiError,
  type MemoryApi,
  type MemoryChangeEvent,
  type MemoryEvent,
  MemoryPatch,
  MemorySettings,
  Message,
  type MessageHit,
  NewMemory,
  type Page,
  RETRIEVAL_BUDGET,
  RetrieveRequest,
  type RetrieveResult,
  RetrievedItem,
  type ReviewStats,
  SessionSummary,
  type ToolCall,
  type Unsubscribe,
} from "./index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------


export interface MockSeed {
  sessions?: { session: SessionSummary; messages: Message[] }[];
  memories?: Memory[];
  episodes?: Episode[];
  candidates?: Candidate[];
  /** messageId → items shown as "used memories" under that answer. */
  usedMemories?: Record<string, RetrievedItem[]>;
  /** projectId → docs packs. */
  docPacks?: Record<string, DocPack[]>;
  /** projectId → library → major version the project uses, for "possibly outdated". */
  projectVersions?: Record<string, Record<string, string>>;
  settings?: MemorySettings;
}

export interface MockOptions {
  /** Initial data. Defaults to an empty store. Use `demoSeed()` for screens. */
  seed?: MockSeed;
  /** Clock, for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Artificial delay per call, to exercise loading states. Default 0. */
  latencyMs?: number;
  /** Items per page. Default 20. */
  pageSize?: number;
  /** Delay between docs pack job states. Default 0 (next tick). */
  jobStepMs?: number;
}

const DEFAULT_SETTINGS: MemorySettings = {
  autoExtract: true,
  autoAcceptRecurring: true,
  projectModes: {},
  embeddingModel: "embeddinggemma",
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Store {
  sessions: Map<string, SessionSummary>;
  messages: Map<string, Message[]>;
  memories: Map<string, Memory>;
  episodes: Map<string, Episode>;
  candidates: Map<string, Candidate>;
  usedMemories: Map<string, RetrievedItem[]>;
  docPacks: Map<string, DocPack[]>;
  projectVersions: Record<string, Record<string, string>>;
  events: MemoryEvent[];
  settings: MemorySettings;
}

function buildStore(seed: MockSeed): Store {
  const sessions = new Map<string, SessionSummary>();
  const messages = new Map<string, Message[]>();
  for (const s of seed.sessions ?? []) {
    const session = SessionSummary.parse(s.session);
    sessions.set(session.id, session);
    messages.set(
      session.id,
      s.messages.map((m) => Message.parse(m)).sort((a, b) => a.createdAt - b.createdAt),
    );
  }
  return {
    sessions,
    messages,
    memories: new Map((seed.memories ?? []).map((m) => [m.id, Memory.parse(m)])),
    episodes: new Map((seed.episodes ?? []).map((e) => [e.id, Episode.parse(e)])),
    candidates: new Map((seed.candidates ?? []).map((c) => [c.id, Candidate.parse(c)])),
    usedMemories: new Map(
      Object.entries(seed.usedMemories ?? {}).map(([k, v]) => [k, v.map((i) => RetrievedItem.parse(i))]),
    ),
    docPacks: new Map(Object.entries(seed.docPacks ?? {}).map(([k, v]) => [k, v.map((p) => DocPack.parse(p))])),
    projectVersions: structuredClone(seed.projectVersions ?? {}),
    events: [],
    settings: MemorySettings.parse(seed.settings ?? DEFAULT_SETTINGS),
  };
}

export function createMockMemoryApi(options: MockOptions = {}): MemoryApi {
  const now = options.now ?? Date.now;
  const latencyMs = options.latencyMs ?? 0;
  const pageSize = options.pageSize ?? 20;
  const jobStepMs = options.jobStepMs ?? 0;
  const store = buildStore(options.seed ?? {});
  /** Review decisions made through the mock, for reviewStats(). */
  const reviews: { at: number; fromSession: boolean; outcome: "accepted" | "edited" | "rejected" }[] = [];
  const listeners = new Set<(e: MemoryChangeEvent) => void>();
  let seq = 0;
  let eventSeq = 0;
  const exports = new Map<string, Store>();

  const newId = (prefix: string) => `${prefix}_mock${(++seq).toString(36).padStart(4, "0")}`;

  const emit = (e: MemoryChangeEvent) => {
    for (const cb of [...listeners]) {
      try {
        cb(structuredClone(e));
      } catch {
        // A failing listener must not break the caller or other listeners.
      }
    }
  };

  const log = (
    action: MemoryEvent["action"],
    actor: MemoryEvent["actor"],
    memoryId: string,
    extra: { sessionId?: string } = {},
  ) => {
    store.events.push({ id: ++eventSeq, memoryId, action, actor, at: now(), ...extra });
    emit({ type: "memory", action, id: memoryId });
  };

  /** Wrap every call: optional latency, and results cloned so callers can't mutate the store. */
  const call = async <T>(fn: () => T): Promise<T> => {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    return structuredClone(fn());
  };

  const parse = <S extends z.ZodType>(schema: S, v: unknown): z.output<S> => {
    const r = schema.safeParse(v);
    if (!r.success) throw new MemoryApiError("invalid", r.error.message);
    return r.data;
  };

  const page = <T>(all: T[], cursor: string | undefined): Page<T> => {
    const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isInteger(start) || start < 0) throw new MemoryApiError("invalid", `bad cursor: ${cursor}`);
    const items = all.slice(start, start + pageSize);
    const next = start + pageSize;
    return next < all.length ? { items, nextCursor: String(next) } : { items };
  };

  const mustSession = (id: string) => {
    const s = store.sessions.get(id);
    if (!s) throw new MemoryApiError("not_found", `session ${id} not found`);
    return s;
  };

  const mustMemory = (id: string) => {
    const m = store.memories.get(id);
    if (!m) throw new MemoryApiError("not_found", `memory ${id} not found`);
    return m;
  };

  /** Older versions of a memory, newest first. */
  const historyOf = (m: Memory): Memory[] => {
    const out: Memory[] = [];
    let prev = m.supersedesId ? store.memories.get(m.supersedesId) : undefined;
    while (prev) {
      out.push(prev);
      prev = prev.supersedesId ? store.memories.get(prev.supersedesId) : undefined;
    }
    return out;
  };

  const sameSubject = (a: { key: string; scope: string; projectId?: string | undefined }, b: Memory) =>
    a.key === b.key && a.scope === b.scope && a.projectId === b.projectId;

  const projectMode = (projectId: string | undefined) =>
    projectId === undefined ? "on" : (store.settings.projectModes[projectId] ?? "on");

  const assertWritable = (projectId: string | undefined) => {
    const mode = projectMode(projectId);
    if (mode !== "on") throw new MemoryApiError("project_mode", `project ${projectId} memory is ${mode}`);
  };

  /** Insert a new active memory, superseding `replaces` (or an active memory with the same subject). */
  const insertMemory = (
    fields: Omit<Memory, "id" | "status" | "useCount" | "createdAt" | "updatedAt" | "supersedesId">,
    replaces: Memory | undefined,
    action: "created" | "accepted" | "edited",
  ): Memory => {
    const old =
      replaces ?? [...store.memories.values()].find((m) => m.status === "active" && sameSubject(fields, m));
    const t = now();
    const memory = Memory.parse({
      ...fields,
      id: newId("mem"),
      status: "active",
      useCount: old?.useCount ?? 0,
      lastUsedAt: old?.lastUsedAt,
      supersedesId: old?.id,
      createdAt: t,
      updatedAt: t,
    });
    store.memories.set(memory.id, memory);
    log(action, "user", memory.id);
    if (old) {
      store.memories.set(old.id, { ...old, status: "superseded", updatedAt: t });
      log("superseded", "system", old.id);
    }
    return memory;
  };

  const hardDeleteMemory = (id: string) => {
    store.memories.delete(id);
    for (const [msgId, items] of store.usedMemories) {
      const kept = items.filter((i) => !(i.ref.type === "memory" && i.ref.id === id));
      if (kept.length !== items.length) store.usedMemories.set(msgId, kept);
    }
  };

  const deleteSessionData = (id: string) => {
    for (const m of store.messages.get(id) ?? []) store.usedMemories.delete(m.id);
    store.messages.delete(id);
    store.sessions.delete(id);
    emit({ type: "session", action: "deleted", id });
  };

  const api: MemoryApi = {
    // History ---------------------------------------------------------------

    listSessions: (q) =>
      call(() => {
        const query = q.query?.toLowerCase();
        const all = [...store.sessions.values()]
          .filter((s) => q.projectId === undefined || s.projectId === q.projectId)
          .filter(
            (s) =>
              !query || `${s.title ?? ""}\n${s.summary ?? ""}`.toLowerCase().includes(query),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return page(all, q.cursor);
      }),

    getSession: (id, q) =>
      call(() => {
        const all = store.messages.get(id) ?? [];
        if (!q?.latest) return { session: mustSession(id), messages: page(all, q?.cursor) };
        // Newest first: the cursor counts messages already shown from the end.
        const session = mustSession(id);
        const shown = q.cursor === undefined ? 0 : Number.parseInt(q.cursor, 10);
        if (!Number.isInteger(shown) || shown < 0) throw new MemoryApiError("invalid", `bad cursor: ${q.cursor}`);
        const end = all.length - shown;
        const start = Math.max(0, end - pageSize);
        const items = all.slice(start, Math.max(0, end));
        return { session, messages: start > 0 ? { items, nextCursor: String(shown + pageSize) } : { items } };
      }),

    renameSession: (id, title) =>
      call(() => {
        const s = mustSession(id);
        const clean = title.trim();
        if (!clean) throw new MemoryApiError("invalid", "title must not be empty");
        store.sessions.set(id, { ...s, title: clean, updatedAt: now() });
        emit({ type: "session", action: "updated", id });
      }),

    deleteSession: (id) =>
      call(() => {
        mustSession(id);
        deleteSessionData(id);
      }),

    searchMessages: (q) =>
      call(() => {
        const needle = q.query.trim().toLowerCase();
        if (!needle) throw new MemoryApiError("invalid", "query must not be empty");
        const hits: MessageHit[] = [];
        for (const s of store.sessions.values()) {
          if (q.projectId !== undefined && s.projectId !== q.projectId) continue;
          for (const m of store.messages.get(s.id) ?? []) {
            const hay = m.content.toLowerCase();
            const at = hay.indexOf(needle);
            if (at < 0) continue;
            const count = hay.split(needle).length - 1;
            hits.push({
              sessionId: s.id,
              messageId: m.id,
              snippet: snippet(m.content, at, needle.length),
              score: count,
              createdAt: m.createdAt,
            });
          }
        }
        hits.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
        return page(hits, q.cursor);
      }),

    // Memory ----------------------------------------------------------------

    listMemories: (f) =>
      call(() => {
        const query = f.query?.toLowerCase();
        const all = [...store.memories.values()]
          // Without a status filter, show what the memory browser shows: no old versions, no rejected.
          .filter((m) => (f.status ? m.status === f.status : m.status !== "superseded" && m.status !== "rejected"))
          .filter((m) => f.projectId === undefined || m.scope === "global" || m.projectId === f.projectId)
          .filter((m) => !f.kind || m.kind === f.kind)
          .filter((m) => !query || `${m.key}\n${m.body}`.toLowerCase().includes(query))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
        return page(all, f.cursor);
      }),

    getEvidence: (id) =>
      call(() => {
        // Memories and proposals both carry evidence.
        const owner = store.memories.get(id) ?? store.candidates.get(id);
        if (!owner) throw new MemoryApiError("not_found", `memory ${id} not found`);
        return owner.evidence.map((e): EvidenceItem => {
          for (const [sessionId, msgs] of store.messages) {
            for (const m of msgs) {
              if (e.type === "message" && m.id === e.id) return { ...e, excerpt: m.content.slice(0, 400), sessionId, messageId: m.id, role: m.role };
              const call = e.type === "tool_call" ? m.toolCalls.find((c) => c.id === e.id) : undefined;
              if (call) {
                const excerpt = [call.command ?? call.name, call.outputExcerpt ?? ""].filter(Boolean).join("\n").slice(0, 400);
                return { ...e, excerpt, sessionId, messageId: m.id, role: m.role };
              }
            }
          }
          return { ...e, excerpt: "", missing: true };
        });
      }),

    getMemory: (id) =>
      call(() => {
        const memory = mustMemory(id);
        const history = historyOf(memory);
        const ids = new Set([memory.id, ...history.map((m) => m.id)]);
        const events = store.events.filter((e) => e.memoryId !== undefined && ids.has(e.memoryId));
        return { memory, history, events };
      }),

    createMemory: (input) =>
      call(() => {
        const m = parse(NewMemory, input);
        assertWritable(m.projectId);
        return insertMemory({ ...m, trust: "user", evidence: [] }, undefined, "created");
      }),

    updateMemory: (id, patch) =>
      call(() => {
        const p = parse(MemoryPatch, patch);
        const old = mustMemory(id);
        if (old.status === "superseded") {
          throw new MemoryApiError("conflict", `memory ${id} is superseded; edit the current version`);
        }
        const { appliesTo, ...rest } = p;
        const next = { ...old, ...rest, trust: "user" as const };
        if (appliesTo === null) delete next.appliesTo;
        else if (appliesTo !== undefined) next.appliesTo = appliesTo;
        const { id: _id, status: _s, useCount: _u, createdAt: _c, updatedAt: _up, supersedesId: _sup, ...fields } = next;
        return insertMemory(fields, old, "edited");
      }),

    deleteMemory: (id) =>
      call(() => {
        const memory = mustMemory(id);
        // Old versions hold earlier wording of the same fact, so they go too.
        for (const m of [memory, ...historyOf(memory)]) {
          hardDeleteMemory(m.id);
          log("deleted", "user", m.id);
        }
      }),

    setPinned: (id, pinned) =>
      call(() => {
        const m = mustMemory(id);
        if (m.pinned === pinned) return;
        store.memories.set(id, { ...m, pinned, updatedAt: now() });
        log("edited", "user", id);
      }),

    // Review inbox ----------------------------------------------------------

    listCandidates: () =>
      call(() => {
        const t = now();
        for (const c of [...store.candidates.values()]) {
          if (c.expiresAt <= t) {
            store.candidates.delete(c.id);
            emit({ type: "candidate", action: "expired", id: c.id });
          }
        }
        return [...store.candidates.values()].sort((a, b) => b.createdAt - a.createdAt);
      }),

    resolveCandidate: (id, resolution) =>
      call(() => {
        const r = parse(CandidateResolution, resolution);
        const c = store.candidates.get(id);
        if (!c || c.expiresAt <= now()) throw new MemoryApiError("not_found", `candidate ${id} not found`);
        const fromSession = c.evidence.some((e) => e.type === "message" || e.type === "tool_call");
        const changed = typeof r === "object" && ((r.edit.key !== undefined && r.edit.key !== c.key) || (r.edit.body !== undefined && r.edit.body !== c.body));
        if (r !== "reject") {
          assertWritable(c.projectId);
          const edit = typeof r === "object" ? r.edit : {};
          const fields: Parameters<typeof insertMemory>[0] = {
            kind: c.kind,
            scope: c.scope,
            projectId: c.projectId,
            key: edit.key ?? c.key,
            body: edit.body ?? c.body,
            pinned: edit.pinned ?? false,
            // Confirmed by the user, so it is no longer an inferred memory.
            trust: "user",
            evidence: c.evidence,
          };
          if (edit.appliesTo) fields.appliesTo = edit.appliesTo;
          if (fields.projectId === undefined) delete fields.projectId;
          const conflicting = c.conflictsWith ? store.memories.get(c.conflictsWith) : undefined;
          insertMemory(fields, conflicting?.status === "active" ? conflicting : undefined, "accepted");
        }
        store.candidates.delete(id);
        // Counted only once the decision went through (a refused write isn't a decision).
        reviews.push({ at: now(), fromSession, outcome: r === "reject" ? "rejected" : changed ? "edited" : "accepted" });
        emit({ type: "candidate", action: "resolved", id });
      }),

    reviewStats: () =>
      call((): ReviewStats => {
        const since = now() - 90 * 24 * 3600 * 1000;
        const tally = (fromSession: boolean) => {
          const rs = reviews.filter((r) => r.at >= since && r.fromSession === fromSession);
          return {
            accepted: rs.filter((r) => r.outcome !== "rejected").length,
            edited: rs.filter((r) => r.outcome === "edited").length,
            rejected: rs.filter((r) => r.outcome === "rejected").length,
          };
        };
        return { fromSessions: tally(true), fromFiles: tally(false), since };
      }),

    // Retrieval -------------------------------------------------------------

    retrieve: (task) =>
      call((): RetrieveResult => {
        const req = parse(RetrieveRequest, task);
        if (projectMode(req.projectId) === "off") return { items: [], tokens: 0 };
        const terms = tokenize([req.text, req.errorOutput ?? "", ...(req.files ?? [])].join(" "));
        const versions = req.projectId ? (store.projectVersions[req.projectId] ?? {}) : {};
        const scored: RetrievedItem[] = [];

        for (const m of store.memories.values()) {
          if (m.status !== "active" || m.pinned) continue; // pinned ones live in the always-on block
          if (m.scope === "project" && m.projectId !== req.projectId) continue;
          const overlap = countOverlap(terms, tokenize(`${m.key} ${m.body}`));
          if (overlap === 0) continue;
          const reasons = ["keyword_match", `trust:${m.trust}`];
          let score = overlap;
          if (m.trust === "user" || m.trust === "verified") score += 1;
          const outdated = isOutdated(m.appliesTo, versions);
          if (outdated) reasons.push("version_mismatch");
          scored.push(item({ type: "memory", id: m.id }, m.body, score, reasons, outdated));
        }

        for (const e of store.episodes.values()) {
          if (e.status !== "active") continue;
          const sameProject = e.projectId !== undefined && e.projectId === req.projectId;
          // Other projects only ever see the project-neutral lesson.
          const text = sameProject ? `${e.problem}\nFix: ${e.fixSummary}` : e.lesson;
          if (!text) continue;
          const reasons = ["trust:verified"];
          let score = countOverlap(terms, tokenize(`${e.problem} ${e.lesson ?? ""}`));
          if (e.errorSignature && req.errorOutput?.includes(e.errorSignature)) {
            score += 10;
            reasons.unshift("error_signature_match");
          } else if (score === 0) continue;
          if (!sameProject) reasons.push("cross_project_lesson");
          const outdated = isOutdated(e.env, versions);
          if (outdated) reasons.push("version_mismatch");
          scored.push(item({ type: "episode", id: e.id }, text, score + 1, reasons, outdated));
        }

        scored.sort((a, b) => b.score - a.score);
        const items: RetrievedItem[] = [];
        let tokens = 0;
        for (const i of scored) {
          if (items.length >= RETRIEVAL_BUDGET.maxTaskItems) break;
          if (tokens + i.tokens > RETRIEVAL_BUDGET.taskTokens) continue;
          items.push(i);
          tokens += i.tokens;
        }
        return { items, tokens };
      }),

    getUsedMemories: (messageId) => call(() => store.usedMemories.get(messageId) ?? []),

    // Docs packs ------------------------------------------------------------

    listDocPacks: (projectId) => call(() => store.docPacks.get(projectId) ?? []),

    buildDocPack: (projectId, library, version) =>
      call((): JobRef => {
        if (!projectId.trim() || !library.trim() || !version.trim()) {
          throw new MemoryApiError("invalid", "projectId, library and version required");
        }
        const job: JobRef = { id: newId("job"), kind: "doc_pack", status: "queued" };
        emit({ type: "job", job });
        const step = (status: JobRef["status"], after: () => void) =>
          setTimeout(() => {
            after();
            emit({ type: "job", job: { ...job, status } });
          }, jobStepMs);
        step("running", () =>
          step("done", () => {
            // Older ready packs of the same library go stale for this project only.
            const packs = (store.docPacks.get(projectId) ?? [])
              .filter((p) => !(p.library === library && p.version === version))
              .map((p) => (p.library === library && p.status === "ready" ? { ...p, status: "stale" as const } : p));
            packs.push({
              id: newId("pack"),
              library,
              version,
              status: "ready",
              chunkCount: 120,
              sourceUrl: `https://docs.example.com/${encodeURIComponent(library)}/${encodeURIComponent(version)}`,
              retrievedAt: now(),
            });
            store.docPacks.set(projectId, packs);
          }),
        );
        return job;
      }),

    listEpisodes: (q) =>
      call(() => {
        const query = q.query?.trim().toLowerCase();
        const all = [...store.episodes.values()]
          .filter((e) => e.status !== "rejected")
          .filter((e) => q.projectId === undefined || e.projectId === q.projectId)
          .filter((e) => !query || [e.problem, e.fixSummary, e.lesson ?? "", e.errorSignature ?? ""].some((t) => t.toLowerCase().includes(query)))
          .sort((a, b) => b.createdAt - a.createdAt);
        return page(all, q.cursor);
      }),

    getEpisode: (id) =>
      call(() => {
        const e = store.episodes.get(id);
        if (!e) throw new MemoryApiError("not_found", `episode ${id} not found`);
        return e;
      }),

    deleteEpisode: (id) =>
      call(() => {
        if (!store.episodes.delete(id)) throw new MemoryApiError("not_found", `episode ${id} not found`);
        emit({ type: "episode", action: "deleted", id });
      }),

    suggestDocPacks: (projectId) =>
      call((): DocSuggestion[] => {
        const versions = store.projectVersions[projectId] ?? {};
        const packs = store.docPacks.get(projectId) ?? [];
        return Object.entries(versions).map(([library, version]) => {
          const mine = packs.filter((p) => p.library === library);
          const current = mine.find((p) => p.status !== "stale" && p.version.split(".")[0] === version.split(".")[0]);
          const shown = current ?? mine[0];
          return {
            library,
            label: shown?.label ?? library,
            version,
            auto: true,
            ...(shown ? { pack: { id: shown.id, status: shown.status, version: shown.version, current: !!current } } : {}),
          };
        });
      }),

    seedProject: (projectId) =>
      call(() => {
        if (!projectId.trim()) throw new MemoryApiError("invalid", "projectId required");
        return { created: 0, files: [] };
      }),

    // Settings and data -----------------------------------------------------

    getSettings: () => call(() => store.settings),

    updateSettings: (patch) =>
      call(() => {
        store.settings = parse(MemorySettings, { ...store.settings, ...patch });
        return store.settings;
      }),

    exportData: () =>
      call(() => {
        const path = `/mock/exports/kovach-export-${now()}-${++seq}.json`;
        exports.set(path, structuredClone(store));
        return { path };
      }),

    importData: (path) =>
      call(() => {
        const snap = exports.get(path);
        if (!snap) {
          return ImportReport.parse({
            memories: 0,
            episodes: 0,
            sessions: 0,
            skipped: 0,
            warnings: [`mock: no export at ${path}`],
          });
        }
        let skipped = 0;
        const add = <T extends { id: string }>(from: Map<string, T>, to: Map<string, T>) => {
          let n = 0;
          for (const [id, v] of from) {
            if (to.has(id)) skipped++;
            else {
              to.set(id, structuredClone(v));
              n++;
            }
          }
          return n;
        };
        const memories = add(snap.memories, store.memories);
        const episodes = add(snap.episodes, store.episodes);
        const sessions = add(snap.sessions, store.sessions);
        for (const [id, msgs] of snap.messages) if (!store.messages.has(id)) store.messages.set(id, structuredClone(msgs));
        return { memories, episodes, sessions, skipped, warnings: [] };
      }),

    clearHistory: (q) =>
      call(() => {
        for (const s of [...store.sessions.values()]) {
          if (q.projectId === undefined || s.projectId === q.projectId) deleteSessionData(s.id);
        }
      }),

    // Live updates ----------------------------------------------------------

    onChange: (cb): Unsubscribe => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "it", "with", "this", "that"]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const major = (v: string) => v.replace(/^[^\d]*/, "").split(".")[0] ?? v;

function isOutdated(bound: Record<string, string> | undefined, project: Record<string, string>): boolean {
  if (!bound) return false;
  return Object.entries(bound).some(([lib, v]) => project[lib] !== undefined && major(project[lib]) !== major(v));
}

function item(
  ref: RetrievedItem["ref"],
  text: string,
  score: number,
  reasons: string[],
  possiblyOutdated: boolean,
): RetrievedItem {
  return { ref, text, score, reasons, possiblyOutdated, tokens: estimateTokens(text) };
}

function snippet(content: string, at: number, len: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + len + 40);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

/**
 * A small, fictional dataset that fills every screen: two projects, a few
 * sessions, memories in several states, an episode, inbox candidates and docs packs.
 */
export function demoSeed(base: number = Date.UTC(2026, 10, 1, 9, 0, 0)): MockSeed {
  const min = 60_000;
  const day = 24 * 60 * min;
  const at = (d: number, m = 0) => base + d * day + m * min;
  const app = "proj_shop_app";
  const api = "proj_billing_api";

  const memories: Memory[] = [
    mem("mem_d001", "preference", undefined, "style.semicolons", "No semicolons in TypeScript.", { pinned: true, t: at(0) }),
    mem("mem_d002", "preference", undefined, "reply.language", "Explain in English; code comments in English.", { t: at(0, 5) }),
    mem("mem_d003", "decision", app, "state.library", "Use Zustand for client state; no Redux.", {
      t: at(1),
      appliesTo: { "react-native": "0.76" },
    }),
    mem("mem_d004", "convention", app, "tests.location", "Tests live next to the file as *.test.tsx.", { t: at(1, 10) }),
    mem("mem_d005", "decision", api, "db.migrations", "Schema changes go through numbered SQL migrations, never edited after merge.", {
      t: at(2),
    }),
    mem("mem_d006", "open_issue", app, "android.release.signing", "Release build signing config still uses the debug keystore.", {
      t: at(3),
    }),
    mem("mem_d007", "research", app, "expo.router.typed", "Expo Router typed routes need `experiments.typedRoutes` in app.json.", {
      t: at(3, 30),
      trust: "official",
      appliesTo: { expo: "51" },
    }),
  ];
  // An edited memory: an old version superseded by a newer one.
  memories.push(
    mem("mem_d008", "preference", undefined, "pkg.manager", "Use npm.", { t: at(0, 20), status: "superseded" }),
    { ...mem("mem_d009", "preference", undefined, "pkg.manager", "Use pnpm for all new projects.", { t: at(4) }), supersedesId: "mem_d008" },
  );

  const sessions = [
    session("ses_d001", app, "Fix Metro cache after Reanimated upgrade", at(5), [
      ["user", "After upgrading reanimated the app crashes on start with a worklets error."],
      [
        "assistant",
        "Clearing the Metro cache fixes it: `npx expo start -c`. The typecheck passes now. [m:mem_d003]",
        [
          {
            name: "shell",
            command: "npx expo run:ios",
            exitCode: 1,
            durationMs: 41_200,
            outputExcerpt: "ReanimatedError: [Reanimated] Mismatch between JavaScript part and native part of Reanimated (3.16.1 vs 3.15.0).",
          },
          { name: "shell", command: "npx expo start -c", exitCode: 0, durationMs: 6_400, outputExcerpt: "Metro waiting on exp://192.168.1.20:8081" },
        ],
      ],
    ]),
    session("ses_d002", app, "Add cart badge to tab bar", at(6), [
      ["user", "Add a badge with the cart count to the Cart tab."],
      ["assistant", "Added `CartBadge` reading from the Zustand cart store, with a test next to it."],
    ]),
    session("ses_d003", api, "Invoice PDF timezone bug", at(7), [
      ["user", "Invoices show yesterday's date for customers in UTC+1."],
      ["assistant", "Dates were formatted in the server timezone. Now using the customer's timezone; tests pass."],
    ]),
  ];

  const episode = Episode.parse({
    id: "epi_d001",
    projectId: app,
    sessionId: "ses_d001",
    problem: "App crashes on start after upgrading react-native-reanimated",
    errorSignature: "ReanimatedError: [Reanimated] Mismatch between JavaScript part and native part",
    env: { "react-native": "0.76", "react-native-reanimated": "3.16" },
    attempts: [
      { approach: "Reinstalled pods", outcome: "failed" },
      { approach: "Cleared Metro cache", outcome: "passed" },
    ],
    fixSummary: "Restart Metro with a clean cache (`npx expo start -c`).",
    files: ["babel.config.js"],
    verifiedBy: "run",
    lesson: "After upgrading Reanimated, clear the Metro cache before debugging native code.",
    status: "active",
    createdAt: at(5, 30),
  });

  const candidates: Candidate[] = [
    {
      id: "cand_d001",
      kind: "convention",
      scope: "project",
      projectId: api,
      key: "dates.timezone",
      body: "Format customer-facing dates in the customer's timezone, not the server's.",
      evidence: [{ type: "message", id: "ses_d003_m0" }],
      seenInSessions: 1,
      expiresAt: at(37),
      createdAt: at(7, 15),
    },
    {
      id: "cand_d002",
      kind: "preference",
      scope: "global",
      key: "pkg.manager",
      body: "Use bun for new projects.",
      evidence: [{ type: "message", id: "ses_d002_m0" }],
      conflictsWith: "mem_d009",
      seenInSessions: 1,
      expiresAt: at(36),
      createdAt: at(6, 20),
    },
  ];

  return {
    sessions,
    memories,
    episodes: [episode],
    candidates,
    usedMemories: {
      ses_d001_m1: [
        {
          ref: { type: "memory", id: "mem_d003" },
          text: "Use Zustand for client state; no Redux.",
          score: 3,
          reasons: ["keyword_match", "trust:user"],
          possiblyOutdated: false,
          tokens: 10,
        },
      ],
    },
    docPacks: {
      [app]: [
        pack("pack_d001", "react-native", "0.76", "ready", at(1)),
        pack("pack_d002", "expo", "51", "stale", at(1)),
        pack("pack_d003", "expo", "52", "ready", at(4)),
      ],
      [api]: [pack("pack_d004", "php", "8.3", "ready", at(2))],
    },
    projectVersions: {
      [app]: { "react-native": "0.76", expo: "52", "react-native-reanimated": "3.16" },
      [api]: { php: "8.3" },
    },
    settings: { ...DEFAULT_SETTINGS, projectModes: { [app]: "on", [api]: "read_only" } },
  };

  function mem(
    id: string,
    kind: Memory["kind"],
    projectId: string | undefined,
    key: string,
    body: string,
    o: { t: number; pinned?: boolean; appliesTo?: Record<string, string>; trust?: Memory["trust"]; status?: Memory["status"] },
  ): Memory {
    return Memory.parse({
      id,
      kind,
      scope: projectId ? "project" : "global",
      ...(projectId ? { projectId } : {}),
      key,
      body,
      trust: o.trust ?? "user",
      status: o.status ?? "active",
      pinned: o.pinned ?? false,
      ...(o.appliesTo ? { appliesTo: o.appliesTo } : {}),
      evidence: [],
      useCount: 0,
      createdAt: o.t,
      updatedAt: o.t,
    });
  }

  type DemoCall = Omit<ToolCall, "id" | "createdAt">;
  function session(
    id: string,
    projectId: string,
    title: string,
    t: number,
    turns: ([Message["role"], string] | [Message["role"], string, DemoCall[]])[],
  ) {
    const messages = turns.map(([role, content, calls = []], i) =>
      Message.parse({
        id: `${id}_m${i}`,
        sessionId: id,
        role,
        content,
        createdAt: t + i * min,
        toolCalls: calls.map((c, j) => ({ ...c, id: `${id}_m${i}_t${j}`, createdAt: t + i * min })),
      }),
    );
    return {
      session: SessionSummary.parse({
        id,
        projectId,
        title,
        model: "qwen3.6-35b-a3b",
        status: "done",
        messageCount: messages.length,
        createdAt: t,
        updatedAt: t + turns.length * min,
      }),
      messages,
    };
  }

  function pack(id: string, library: string, version: string, status: DocPack["status"], t: number): DocPack {
    return DocPack.parse({
      id,
      library,
      version,
      status,
      chunkCount: 240,
      sourceUrl: `https://docs.example.com/${library}/${version}`,
      retrievedAt: t,
    });
  }
}
