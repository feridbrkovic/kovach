/**
 * Long-term memory (MASTER_PLAN › Data model, Write path, Read path).
 *
 * - Explicit memories with versioning: an edit writes a new row and marks the
 *   old one superseded, so only the newest is ever retrieved (T6).
 * - Hard delete across tables and indexes (T7); triggers clean FTS, vectors
 *   and the "used" lists.
 * - Hybrid retrieval: FTS5 bm25 and vector search, merged with reciprocal
 *   rank fusion, filtered by scope and project mode, boosted by trust, error
 *   signature and recent use, cut to the plan's budgets (T2, T3).
 * - The always-on block: project card, pinned memories, global preferences and
 *   the project's decisions and conventions.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  type Candidate,
  CandidateResolution,
  type DocSuggestion,
  type EvidenceItem,
  type JobRef,
  type MemoryApi,
  MemoryApiError,
  type MemoryChangeEvent,
  type Memory,
  type MemoryEvent,
  MemoryPatch,
  MemorySettings,
  NewMemory,
  type NewMemoryInput,
  type Page,
  type ProjectMemoryMode,
  RETRIEVAL_BUDGET,
  RetrieveRequest,
  type RetrievedItem,
  type RetrieveResult,
  type Unsubscribe,
} from "@kovach-dev/memory-contract";
import type { Db } from "./db.js";
import { createDocsIndex, type DocHit, type DocPackView } from "./docs/packs.js";
import type { DocsFetcher } from "./docs/sources.js";
import type { Embedder } from "./embeddings.js";
import { createJobRunner, type JobRunner } from "./jobs.js";
import { findConventions, seedKey } from "./seed.js";
import { createEpisodes, errorSignatureOf, normalizeSignature, type Summarizer } from "./episodes.js";
import { buildTranscript, claimSupport, type Extractor, extractionPrompt, gate, parseExtraction, type TranscriptRef } from "./extraction.js";
import { isOutdated, manifestHash, type ProjectCard, renderCard, scanProject } from "./scanner.js";
import { scanSecrets } from "./secrets.js";

/** The contract's memory methods, as served to the UI. */
export type MemoryServiceApi = Pick<
  MemoryApi,
  | "listMemories"
  | "getMemory"
  | "getEvidence"
  | "createMemory"
  | "updateMemory"
  | "deleteMemory"
  | "setPinned"
  | "listCandidates"
  | "resolveCandidate"
  | "reviewStats"
  | "retrieve"
  | "getUsedMemories"
  | "listDocPacks"
  | "buildDocPack"
  | "suggestDocPacks"
  | "seedProject"
  | "listEpisodes"
  | "getEpisode"
  | "deleteEpisode"
  | "getSettings"
  | "updateSettings"
  | "onChange"
>;

export interface MemoryOptions {
  now?: () => number;
  newId?: (prefix: string) => string;
  embedder?: Embedder;
  /** Items per page in listMemories. Default 50. */
  pageSize?: number;
  /** Default embedding model reported in settings until the user picks one. */
  defaultEmbeddingModel?: string;
  /** Downloads docs for packs (git + npm registry). Without it, pack builds fail with a clear error. */
  docsFetcher?: () => DocsFetcher;
  /** Background jobs; one is created when not given. Call `jobs.start()` to run them. */
  jobs?: JobRunner;
  /** Writes problem, fix and lesson for a verified fix (the local model). Without it, a plain summary. */
  summarizer?: () => Summarizer | undefined;
  /** Proposes memories from a finished session (the local model). Without it, nothing is extracted. */
  extractor?: () => Extractor | undefined;
}

/** Context for one task: what the agent gets, with short handles it can cite. */
export interface ContextItem extends RetrievedItem {
  /** e.g. "m:4f2a9c" for a memory, "e:91bd00" for an episode. */
  handle: string;
  kind?: string;
  trust?: string;
}

export interface AlwaysOnBlock {
  /** Ready to put in the system prompt; empty when there is nothing to say. */
  text: string;
  items: ContextItem[];
  tokens: number;
}

export interface TaskBlock {
  /** Ready to append to the user's message; empty when nothing was found. */
  text: string;
  items: ContextItem[];
  tokens: number;
}

export interface MemoryStore extends MemoryServiceApi {
  /** As in the contract; `by: "auto"` marks the recurring-proposal auto-accept, which isn't counted as the user's decision. */
  resolveCandidate(id: string, resolution: CandidateResolution, by?: "user" | "auto"): Promise<void>;
  /** Pinned memories, global preferences, the project card and its decisions and conventions. */
  alwaysOn(projectId?: string): Promise<AlwaysOnBlock>;
  /** Hybrid search for one task, leaving out what the always-on block already holds. */
  taskContext(req: { projectId?: string; text: string; errorOutput?: string; files?: string[] }, exclude?: Set<string>): Promise<TaskBlock>;
  /** Record what an answer was given and which items it cited. Updates use counts and the audit log. */
  recordUse(messageId: string, items: ContextItem[], answer: string, sessionId?: string): void;
  /** A memory the user asked for in conversation (approved in the UI): trust "user". */
  remember(input: NewMemoryInput, evidence: { sessionId?: string; messageId?: string; contextProjectId?: string }): Promise<Memory>;
  /** The scanner's card for a project (cached; rebuilt when its manifests change). */
  projectCard(projectId: string): ProjectCard | undefined;
  projectMode(projectId: string | undefined): ProjectMemoryMode;
  /** Swap the embedding model (settings change). Vectors are rebuilt by reindex(). */
  setEmbedder(embedder: Embedder | undefined): void;
  /** Embed what isn't embedded yet; rebuilds everything after a model change. Never throws. */
  reindex(signal?: AbortSignal): Promise<{ embedded: number; docs?: number; error?: string }>;
  /** True when vector search is usable with the current model. */
  vectorsReady(): boolean;
  /** The background job queue (docs pack builds). */
  jobs: JobRunner;
  /** Build the curated packs a project needs (new ones, and new versions after an upgrade). */
  ensureDocPacks(projectId: string): JobRef[];
  /** Search a project's docs packs (the search_docs tool). */
  searchDocs(req: { projectId?: string; query: string; library?: string; k?: number }): Promise<DocHit[]>;
  listDocPacks(projectId: string): Promise<DocPackView[]>;
  /** Look for verified fixes in a finished run; summaries are written in the background. Returns how many were queued. */
  learnFromSession(sessionId: string): number;
  /**
   * Queue the extraction job for a session (when the user allows it and the
   * project contributes). Returns false when nothing was queued.
   */
  queueExtraction(sessionId: string): boolean;
  /**
   * Re-check research memories whose review date has passed against their
   * source pages: still supported → next check in 90 days; gone or changed → stale.
   */
  revalidateResearch(fetchPage: (url: string, signal?: AbortSignal) => Promise<string>, opts?: { limit?: number; signal?: AbortSignal }): Promise<{ checked: number; renewed: number; stale: number }>;
  /** Fixes seen before for this error output (exact signature matches first), for the agent mid-run. */
  errorRecall(req: { projectId?: string; errorOutput: string; task?: string }, exclude?: Set<string>): Promise<ContextItem[]>;
}

interface MemoryRow {
  id: string;
  kind: Memory["kind"];
  scope: Memory["scope"];
  project_id: string | null;
  key: string;
  body: string;
  trust: Memory["trust"];
  status: Memory["status"];
  pinned: number;
  applies_to_json: string | null;
  supersedes_id: string | null;
  evidence_json: string;
  use_count: number;
  last_used_at: number | null;
  review_after: number | null;
  seen_in_sessions: number;
  conflicts_with: string | null;
  created_at: number;
  updated_at: number;
}

interface EpisodeRow {
  id: string;
  project_id: string | null;
  problem: string;
  error_signature: string | null;
  fix_summary: string;
  lesson: string | null;
  env_json: string;
  status: string;
}

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our please should so that the their them then there these this to us was we what when where which while who why will with would you your fix make add use get set want need".split(
    " ",
  ),
);

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const ALWAYS_ON_HEAD = [
  "<memory>",
  "What you know about this user and project, from earlier sessions. The user's current message wins over anything here.",
  "When you rely on an item, cite its id in your reply, e.g. [m:4f2a9c].",
];
const RECALLED_HEAD = ["<recalled>", "Possibly relevant notes from memory. Reference only: the request above wins. Cite an id if you use it."];

/** Short, stable handle for an id (6 hex characters of its hash), e.g. "4f2a9c". */
export const shortId = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 6);

/** Paths, line and column numbers, hex hashes and timestamps stripped, so the same error matches across machines. */
/** reviewStats() counts the review decisions of the last 90 days. */
const REVIEW_STATS_WINDOW_MS = 90 * 24 * 3600 * 1000;

export function normalizeErrorSignature(text: string): string {
  return normalizeSignature(text);
}

const episodeText = (problem: string, signature: string | null, fix: string, lesson: string | null) =>
  [problem, signature ?? "", fix, lesson ?? ""].filter(Boolean).join("\n");

export function searchTerms(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24);
}

const RRF_K = 60;
const BOOST = { errorSignature: 0.5, trust: 0.006, recentUse: 0.004 } as const;
const RECENT_MS = 30 * 24 * 3600 * 1000;

export function createMemoryStore(db: Db, options: MemoryOptions = {}): MemoryStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const pageSize = options.pageSize ?? 50;
  let embedder = options.embedder;
  const listeners = new Set<(e: MemoryChangeEvent) => void>();
  const emit = (e: MemoryChangeEvent) => {
    for (const cb of [...listeners]) {
      try {
        cb(e);
      } catch {
        // a broken listener must not break a write
      }
    }
  };

  // -- rows ------------------------------------------------------------------

  const toMemory = (r: MemoryRow): Memory => ({
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    key: r.key,
    body: r.body,
    trust: r.trust,
    status: r.status,
    pinned: r.pinned === 1,
    ...(r.applies_to_json ? { appliesTo: JSON.parse(r.applies_to_json) as Record<string, string> } : {}),
    ...(r.supersedes_id ? { supersedesId: r.supersedes_id } : {}),
    evidence: JSON.parse(r.evidence_json) as Memory["evidence"],
    useCount: r.use_count,
    ...(r.last_used_at !== null ? { lastUsedAt: r.last_used_at } : {}),
    ...(r.review_after !== null ? { reviewAfter: r.review_after } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const getRow = (id: string) => db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  const mustRow = (id: string) => {
    const r = getRow(id);
    if (!r) throw new MemoryApiError("not_found", `memory ${id} not found`);
    return r;
  };

  const history = (r: MemoryRow): MemoryRow[] => {
    const out: MemoryRow[] = [];
    let prev = r.supersedes_id ? getRow(r.supersedes_id) : undefined;
    while (prev && out.length < 200) {
      out.push(prev);
      prev = prev.supersedes_id ? getRow(prev.supersedes_id) : undefined;
    }
    return out;
  };

  const log = (action: MemoryEvent["action"], actor: MemoryEvent["actor"], memoryId: string, sessionId?: string) => {
    db.prepare("INSERT INTO memory_events (memory_id, action, actor, session_id, at) VALUES (?, ?, ?, ?, ?)").run(
      memoryId,
      action,
      actor,
      sessionId ?? null,
      now(),
    );
  };

  const projectMode = (projectId: string | undefined): ProjectMemoryMode => {
    if (!projectId) return "on";
    const r = db.prepare("SELECT memory_mode FROM projects WHERE id = ?").get(projectId) as { memory_mode: ProjectMemoryMode } | undefined;
    return r?.memory_mode ?? "on";
  };

  const assertWritable = (projectId: string | undefined) => {
    if (!projectId) return;
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new MemoryApiError("not_found", `project ${projectId} not found`);
    const mode = projectMode(projectId);
    if (mode !== "on") {
      throw new MemoryApiError("project_mode", `Memory for this project is ${mode === "off" ? "off" : "read-only"}, so nothing new is saved for it`);
    }
  };

  const assertNoSecrets = (...texts: string[]) => {
    const found = scanSecrets(texts.join("\n"));
    if (found.length) {
      throw new MemoryApiError("invalid", `That looks like it contains a secret (${found[0]!.kind}). Memories never store secrets.`);
    }
  };

  // -- settings ---------------------------------------------------------------

  const readSetting = <T>(key: string, fallback: T): T => {
    const r = db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    if (!r) return fallback;
    try {
      return JSON.parse(r.value_json) as T;
    } catch {
      return fallback;
    }
  };
  const writeSetting = (key: string, value: unknown) =>
    db.prepare("INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(
      key,
      JSON.stringify(value),
    );

  const settings = (): MemorySettings => {
    const modes = db.prepare("SELECT id, memory_mode FROM projects").all() as { id: string; memory_mode: ProjectMemoryMode }[];
    return {
      autoExtract: readSetting("autoExtract", true),
      autoAcceptRecurring: readSetting("autoAcceptRecurring", false),
      projectModes: Object.fromEntries(modes.map((m) => [m.id, m.memory_mode])),
      embeddingModel: readSetting("embeddingModel", options.defaultEmbeddingModel ?? embedder?.model ?? "embeddinggemma"),
    };
  };

  // -- vectors ---------------------------------------------------------------

  const meta = () => db.prepare("SELECT model, dims FROM embedding_meta WHERE id = 1").get() as { model: string; dims: number } | undefined;
  /**
   * Vector search stays off until a reindex with the current model has finished,
   * so a half-rebuilt index never answers (keywords cover the gap).
   */
  let indexed = false;
  let reindexGen = 0;
  const vectorsReady = () => indexed && !!embedder && meta()?.model === embedder.model;
  const isActive = (id: string) => getRow(id)?.status === "active";

  // -- docs packs and jobs ------------------------------------------------------

  const jobs =
    options.jobs ??
    createJobRunner(db, {
      now,
      newId,
      onChange: (job) => emit({ type: "job", job }),
    });
  const docs = createDocsIndex(db, {
    now,
    newId,
    emit,
    jobs,
    projectCard: (id) => projectCard(id),
    projectMode: (id) => projectMode(id),
    terms: searchTerms,
    embedder: () => embedder,
    vectorMeta: () => (vectorsReady() ? meta() : undefined),
    ...(options.docsFetcher ? { fetcher: options.docsFetcher } : {}),
  });
  /** Embed one verified fix next to the memories, best effort. */
  const embedEpisode = async (id: string, text: string) => {
    const e = embedder;
    if (!e || !vectorsReady()) return;
    const [v] = await e.embed([text], "document");
    const m = meta();
    if (v && embedder === e && vectorsReady() && m && v.length === m.dims && db.prepare("SELECT 1 FROM episodes WHERE id = ? AND status = 'active'").get(id)) {
      writeVector(vecKey("episode", id), v);
    }
  };
  const episodes = createEpisodes(db, {
    now,
    newId,
    emit,
    jobs,
    projectMode: (id) => projectMode(id),
    stack: (id) => {
      const card = id ? projectCard(id) : undefined;
      const libs = [...(card?.stackLibraries ?? []), "node"];
      const versions = Object.fromEntries(libs.filter((l) => card?.versions[l]).map((l) => [l, card!.versions[l]!]));
      return { versions, labels: card?.stack ?? [] };
    },
    summarizer: () => options.summarizer?.(),
    embed: embedEpisode,
    pageSize,
  });

  // -- inferred memory (extraction) -----------------------------------------------

  const RESEARCH_REVIEW_MS = 90 * 24 * 3600 * 1000;
  const CANDIDATE_TTL_MS = 30 * 24 * 3600 * 1000;
  const sameText = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "") === b.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");

  /** Content words, for a rough "says the same thing" check. */
  const STOP = new Set(["the", "and", "are", "for", "with", "that", "this", "must", "should", "always", "never", "use", "uses", "not", "all", "its", "into", "from", "they", "them", "our", "your", "you"]);
  const contentWords = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map((w) => w.replace(/s$/, "")),
    );

  /**
   * Already saved from the same message: the user asked to remember it in that session, and the
   * proposal restates it. A different fact from the same message still gets through.
   */
  const savedFromSameMessage = (body: string, evidence: Memory["evidence"], projectId: string | undefined): boolean => {
    const words = contentWords(body);
    if (words.size === 0) return false;
    for (const e of evidence) {
      if (e.type !== "message") continue;
      const rows = db
        .prepare(
          `SELECT body FROM memories WHERE status = 'active' AND evidence_json LIKE ? ESCAPE '\\'
           AND (scope = 'global' OR project_id = ?)`,
        )
        .all(`%"${e.id.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`, projectId ?? "") as { body: string }[];
      for (const r of rows) {
        const theirs = contentWords(r.body);
        let shared = 0;
        for (const w of words) if (theirs.has(w)) shared++;
        if (shared / Math.min(words.size, theirs.size || 1) >= 0.5) return true;
      }
    }
    return false;
  };

  /** Sessions a candidate's evidence comes from (messages and tool calls). */
  const evidenceSessions = (evidence: Memory["evidence"]): Set<string> => {
    const out = new Set<string>();
    for (const e of evidence) {
      const r =
        e.type === "message"
          ? (db.prepare("SELECT session_id FROM messages WHERE id = ?").get(e.id) as { session_id: string } | undefined)
          : e.type === "tool_call"
            ? (db.prepare("SELECT m.session_id FROM tool_calls tc JOIN messages m ON m.id = tc.message_id WHERE tc.id = ?").get(e.id) as { session_id: string } | undefined)
            : undefined;
      if (r) out.add(r.session_id);
    }
    return out;
  };

  /** One source row per URL; refreshed when seen again. */
  const sourceFor = (ref: TranscriptRef): string => {
    const have = db.prepare("SELECT id FROM sources WHERE url = ?").get(ref.url!) as { id: string } | undefined;
    const t = now();
    const hash = createHash("sha256").update((ref.output ?? "").replace(/\s+/g, " ")).digest("hex");
    if (have) {
      db.prepare("UPDATE sources SET retrieved_at = ?, content_hash = ? WHERE id = ?").run(t, hash, have.id);
      return have.id;
    }
    const id = newId("src");
    db.prepare("INSERT INTO sources (id, url, title, is_official, retrieved_at, content_hash, excerpt) VALUES (?, ?, ?, 0, ?, ?, ?)").run(
      id,
      ref.url!,
      ref.title ?? null,
      t,
      hash,
      (ref.output ?? "").replace(/\s+/g, " ").slice(0, 200),
    );
    return id;
  };

  /** Too close in meaning to an active memory in reach (cosine similarity above 0.9). */
  const nearDuplicate = async (text: string, projectId: string | undefined): Promise<boolean> => {
    const e = embedder;
    if (!e || !vectorsReady()) return false;
    try {
      const [v] = await e.embed([text], "document");
      if (!v || v.length !== meta()?.dims) return false;
      return knn(v, 5).some((h) => h.distance < 0.1 && h.key.startsWith("memory:") && eligible(h.key, projectId));
    } catch {
      return false;
    }
  };

  /** Gates 3–5 and landing in the inbox. Returns the candidate id, or why it was dropped. */
  const admit = async (
    c: import("./extraction.js").ExtractedCandidate,
    evidence: Memory["evidence"],
    projectId: string | undefined,
    sessionId: string,
  ): Promise<string | "duplicate" | "recurring" | "invalid"> => {
    const key = normalizeKey(c.key);
    if (!key) return "invalid";
    const scopeProject = c.scope === "project" ? projectId : undefined;
    const active = db
      .prepare("SELECT * FROM memories WHERE status = 'active' AND scope = ? AND COALESCE(project_id, '') = ? AND key = ?")
      .get(c.scope, scopeProject ?? "", key) as MemoryRow | undefined;
    // A global memory or proposal on the same subject already reaches this project.
    const globalRow = (status: string) =>
      c.scope === "project"
        ? (db.prepare("SELECT * FROM memories WHERE status = ? AND scope = 'global' AND key = ?").get(status, key) as MemoryRow | undefined)
        : undefined;
    // 3. Dedup: the same thing is already remembered.
    if (active && sameText(active.body, c.body)) return "duplicate";
    const activeGlobal = globalRow("active");
    if (activeGlobal && sameText(activeGlobal.body, c.body)) return "duplicate";
    if (!active && (await nearDuplicate(`${key}: ${c.body}`, projectId))) return "duplicate";
    if (savedFromSameMessage(c.body, evidence, projectId)) return "duplicate";
    const own = db
      .prepare("SELECT * FROM memories WHERE status = 'pending_review' AND scope = ? AND COALESCE(project_id, '') = ? AND key = ?")
      .get(c.scope, scopeProject ?? "", key) as MemoryRow | undefined;
    const pendingGlobal = own ? undefined : globalRow("pending_review");
    const pending = own ?? (pendingGlobal && sameText(pendingGlobal.body, c.body) ? pendingGlobal : undefined);
    if (pending && sameText(pending.body, c.body)) {
      // The same proposal from another session: it recurs. Two sessions may auto-accept it.
      const prior = JSON.parse(pending.evidence_json) as Memory["evidence"];
      if (evidenceSessions(prior).has(sessionId)) return "duplicate";
      const merged = [...prior, ...evidence.filter((e) => !prior.some((p) => p.type === e.type && p.id === e.id))];
      db.prepare("UPDATE memories SET seen_in_sessions = seen_in_sessions + 1, evidence_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), now(), pending.id);
      const seen = pending.seen_in_sessions + 1;
      if (seen >= 2 && readSetting("autoAcceptRecurring", false) && !pending.conflicts_with) {
        await api.resolveCandidate(pending.id, "accept", "auto");
      } else emit({ type: "candidate", action: "created", id: pending.id });
      return "recurring";
    }
    // A newer proposal for the same subject replaces an older one still waiting.
    if (pending) db.prepare("DELETE FROM memories WHERE id = ?").run(pending.id);
    const t = now();
    const id = newId("mem");
    // 4–5. Same subject, different value: the inbox asks (accepting supersedes the old memory).
    db.prepare(
      `INSERT INTO memories (id, kind, scope, project_id, key, body, trust, status, applies_to_json, evidence_json, review_after, seen_in_sessions, conflicts_with, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'inferred', 'pending_review', ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      c.kind,
      c.scope,
      scopeProject ?? null,
      key,
      c.body,
      c.appliesTo ? JSON.stringify(c.appliesTo) : null,
      JSON.stringify(evidence),
      t + CANDIDATE_TTL_MS,
      active?.id ?? null,
      t,
      t,
    );
    db.prepare("INSERT INTO memory_events (memory_id, action, actor, session_id, at) VALUES (?, 'created', 'system', ?, ?)").run(id, sessionId, t);
    emit({ type: "candidate", action: "created", id });
    return id;
  };

  const handleExtractJob = async (payload: Record<string, unknown>, ctx: import("./jobs.js").JobContext): Promise<void> => {
    const sessionId = String(payload.sessionId);
    const s = db.prepare("SELECT project_id, extracted_at FROM sessions WHERE id = ?").get(sessionId) as { project_id: string | null; extracted_at: number | null } | undefined;
    if (!s) return;
    const projectId = s.project_id ?? undefined;
    // Read-only and off projects contribute nothing (T8, decision 3).
    if (projectMode(projectId) !== "on") return;
    const extract = options.extractor?.();
    if (!extract) return;
    const transcript = buildTranscript(db, sessionId, s.extracted_at ?? 0);
    const markDone = () => db.prepare("UPDATE sessions SET extracted_at = ? WHERE id = ?").run(transcript.upTo, sessionId);
    if (![...transcript.refs.values()].some((r) => r.type === "user")) return void markDone();
    ctx.progress("Looking for things to remember");
    const card = projectId ? projectCard(projectId) : undefined;
    const projectName = projectId ? (db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name : undefined;
    const raw = await extract(extractionPrompt(transcript, { ...(projectName ? { project: projectName } : {}), stack: card?.stack ?? [] }), ctx.signal);
    await ctx.checkpoint();
    // Subjects proposed in this run: a second, different proposal under the same key is a
    // separate fact the model filed under one name, not a newer version of the first.
    const thisRun = new Map<string, string[]>();
    for (const c of parseExtraction(raw)) {
      const g = gate(c, transcript.refs, !!projectId);
      if (!g.ok) continue;
      const base = `${g.candidate.scope}|${normalizeKey(g.candidate.key)}`;
      const bodies = thisRun.get(base) ?? [];
      if (bodies.some((b) => sameText(b, g.candidate.body))) continue;
      const candidate = bodies.length ? { ...g.candidate, key: `${normalizeKey(g.candidate.key)}-${bodies.length + 1}` } : g.candidate;
      thisRun.set(base, [...bodies, g.candidate.body]);
      const evidence: Memory["evidence"] = [...g.evidence, ...g.sources.map((r) => ({ type: "source" as const, id: sourceFor(r) }))];
      await admit(candidate, evidence, projectId, sessionId);
    }
    markDone();
  };

  jobs.register("extraction", async (payload, ctx) => (payload.type === "memories" ? handleExtractJob(payload, ctx) : episodes.handleFixJob(payload, ctx)));

  /** Docs hits as context items, cut to what is left of the task budget. */
  const docItems = (hits: DocHit[], room: { items: number; tokens: number }): ContextItem[] => {
    const out: ContextItem[] = [];
    for (const h of hits) {
      if (out.length >= room.items) break;
      const text = `${h.label} ${h.docsVersion} docs — ${h.heading}: ${h.text} (${h.url})`;
      const tokens = estimateTokens(text) + 12;
      if (tokens > room.tokens) continue;
      room.tokens -= tokens;
      out.push({
        ref: { type: "doc", id: h.id },
        handle: h.handle,
        kind: "doc",
        trust: "official",
        text,
        score: h.score,
        reasons: [`docs:${h.library}@${h.docsVersion}`, ...(h.agreed ? ["keywords_and_meaning"] : []), ...(h.possiblyOutdated ? ["version_mismatch"] : [])],
        possiblyOutdated: h.possiblyOutdated,
        tokens: estimateTokens(text),
      });
    }
    return out;
  };
  const vecKey = (type: "memory" | "episode", id: string) => `${type}:${id}`;

  const writeVector = (key: string, v: Float32Array) => {
    db.prepare("DELETE FROM memory_vec WHERE ref_key = ?").run(key);
    db.prepare("INSERT INTO memory_vec (ref_key, embedding) VALUES (?, ?)").run(key, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  };

  /** Embed one memory right after a write. Failures are fine: reindex() catches up, FTS still works. */
  const embedMemory = async (m: { id: string; key: string; body: string }) => {
    const e = embedder;
    if (!e || !vectorsReady()) return;
    try {
      const [v] = await e.embed([`${m.key}: ${m.body}`], "document");
      // The model may have changed, or the row been edited or deleted, while we waited.
      if (v && embedder === e && vectorsReady() && v.length === meta()!.dims && isActive(m.id)) writeVector(vecKey("memory", m.id), v);
    } catch {
      // the model server may be down; retrieval falls back to keywords
    }
  };

  const recreateVecTable = (dims: number) => {
    db.exec("DROP TABLE IF EXISTS memory_vec");
    db.exec(`CREATE VIRTUAL TABLE memory_vec USING vec0(ref_key TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`);
  };

  const knn = (q: Float32Array, k: number): { key: string; distance: number }[] =>
    (
      db
        .prepare("SELECT ref_key, distance FROM memory_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance")
        .all(Buffer.from(q.buffer, q.byteOffset, q.byteLength), k) as { ref_key: string; distance: number }[]
    ).map((r) => ({ key: r.ref_key, distance: r.distance }));

  // -- writes -----------------------------------------------------------------

  type Fields = {
    kind: Memory["kind"];
    scope: Memory["scope"];
    projectId?: string | undefined;
    key: string;
    body: string;
    pinned: boolean;
    trust: Memory["trust"];
    appliesTo?: Record<string, string> | undefined;
    evidence: Memory["evidence"];
  };

  /** Insert an active memory, superseding `replaces` or the active memory with the same subject. */
  const insertMemory = (f: Fields, replaces: MemoryRow | undefined, action: "created" | "accepted" | "edited", actor: MemoryEvent["actor"], sessionId?: string): Memory => {
    const t = now();
    const id = newId("mem");
    const memory = db.transaction(() => {
      const old =
        replaces ??
        (db
          .prepare("SELECT * FROM memories WHERE status = 'active' AND scope = ? AND COALESCE(project_id, '') = ? AND key = ?")
          .get(f.scope, f.projectId ?? "", f.key) as MemoryRow | undefined);
      // Another active memory already holding the new subject would break "one active per subject".
      const clash = db
        .prepare("SELECT id FROM memories WHERE status = 'active' AND scope = ? AND COALESCE(project_id, '') = ? AND key = ? AND id != ?")
        .get(f.scope, f.projectId ?? "", f.key, old?.id ?? "") as { id: string } | undefined;
      if (clash) throw new MemoryApiError("conflict", `Another memory already uses the subject "${f.key}". Edit that one instead.`);
      if (old) {
        db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?").run(t, old.id);
      }
      db.prepare(
        `INSERT INTO memories (id, kind, scope, project_id, key, body, trust, status, pinned, applies_to_json, supersedes_id,
           evidence_json, use_count, last_used_at, review_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        f.kind,
        f.scope,
        f.projectId ?? null,
        f.key,
        f.body,
        f.trust,
        f.pinned ? 1 : 0,
        f.appliesTo ? JSON.stringify(f.appliesTo) : null,
        old?.id ?? null,
        JSON.stringify(f.evidence),
        old?.use_count ?? 0,
        old?.last_used_at ?? null,
        // Research is re-checked against its source every 90 days.
        f.kind === "research" ? t + 90 * 24 * 3600 * 1000 : null,
        t,
        t,
      );
      log(action, actor, id, sessionId);
      if (old) {
        log("superseded", "system", old.id, sessionId);
        db.prepare("DELETE FROM memory_vec WHERE ref_key = ?").run(vecKey("memory", old.id));
      }
      return toMemory(mustRow(id));
    })();
    emit({ type: "memory", action, id: memory.id });
    if (memory.supersedesId) emit({ type: "memory", action: "superseded", id: memory.supersedesId });
    return memory;
  };

  const normalizeKey = (key: string) =>
    key
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ".")
      .replace(/[^a-z0-9._/-]/g, "")
      .replace(/\.{2,}/g, ".")
      .replace(/^\.|\.$/g, "");

  const create = async (input: NewMemoryInput, trustActor: { actor: MemoryEvent["actor"]; evidence: Memory["evidence"]; sessionId?: string }) => {
    let m: ReturnType<typeof NewMemory.parse>;
    try {
      m = NewMemory.parse(input);
    } catch (err) {
      throw new MemoryApiError("invalid", err instanceof Error ? err.message : "invalid memory");
    }
    const key = normalizeKey(m.key);
    if (!key) throw new MemoryApiError("invalid", "Give the memory a short subject, e.g. style.semicolons");
    assertWritable(m.projectId);
    assertNoSecrets(m.key, m.body, JSON.stringify(m.appliesTo ?? {}));
    const memory = insertMemory(
      {
        kind: m.kind,
        scope: m.scope,
        projectId: m.projectId,
        key,
        body: m.body.trim(),
        pinned: m.pinned,
        trust: "user",
        appliesTo: m.appliesTo,
        evidence: trustActor.evidence,
      },
      undefined,
      "created",
      trustActor.actor,
      trustActor.sessionId,
    );
    await embedMemory(memory);
    return memory;
  };

  // -- retrieval ----------------------------------------------------------------

  const cardCache = new Map<string, { hash: string; card: ProjectCard }>();
  const projectCard = (projectId: string): ProjectCard | undefined => {
    const p = db.prepare("SELECT path, name FROM projects WHERE id = ?").get(projectId) as { path: string; name: string } | undefined;
    if (!p) return undefined;
    let hash: string;
    try {
      hash = manifestHash(p.path);
    } catch {
      return undefined;
    }
    const mem = cardCache.get(projectId);
    if (mem?.hash === hash) return mem.card;
    const row = db.prepare("SELECT card_json, manifest_hash FROM project_cards WHERE project_id = ?").get(projectId) as
      | { card_json: string; manifest_hash: string }
      | undefined;
    let card: ProjectCard;
    if (row?.manifest_hash === hash) card = JSON.parse(row.card_json) as ProjectCard;
    else {
      card = scanProject(p.path, p.name);
      db.prepare(
        `INSERT INTO project_cards (project_id, card_json, manifest_hash, scanned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET card_json = excluded.card_json, manifest_hash = excluded.manifest_hash, scanned_at = excluded.scanned_at`,
      ).run(projectId, JSON.stringify(card), hash, now());
    }
    cardCache.set(projectId, { hash, card });
    return card;
  };

  const date = (t: number) => new Date(t).toISOString().slice(0, 10);

  const memoryItem = (r: MemoryRow, score: number, reasons: string[], versions: Record<string, string>): ContextItem => {
    const bound = r.applies_to_json ? (JSON.parse(r.applies_to_json) as Record<string, string>) : undefined;
    const v = isOutdated(bound, versions);
    const text = `${r.key}: ${r.body}`;
    return {
      ref: { type: "memory", id: r.id },
      handle: `m:${shortId(r.id)}`,
      kind: r.kind,
      trust: r.trust,
      text,
      score,
      reasons: v.outdated ? [...reasons, "version_mismatch"] : reasons,
      possiblyOutdated: v.outdated,
      tokens: estimateTokens(text),
      ...(v.outdated && v.detail ? { outdatedDetail: v.detail } : {}),
    } as ContextItem;
  };

  const line = (i: ContextItem, withDate?: number) => {
    const tags = [i.kind ?? i.ref.type, i.trust, withDate ? date(withDate) : undefined, i.possiblyOutdated ? "possibly outdated" : undefined].filter(Boolean);
    return `- [${i.handle}] (${tags.join(", ")}) ${i.text}`;
  };

  const alwaysOn = async (projectId?: string): Promise<AlwaysOnBlock> => {
    const mode = projectMode(projectId);
    if (mode === "off") return { text: "", items: [], tokens: 0 };
    const card = projectId ? projectCard(projectId) : undefined;
    const versions = card?.versions ?? {};
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE status = 'active' AND (
           pinned = 1 AND (scope = 'global' OR project_id = ?)
           OR (scope = 'global' AND kind = 'preference' AND trust = 'user')
           OR (scope = 'project' AND project_id = ? AND kind IN ('decision', 'convention') AND trust IN ('user', 'verified'))
         )
         ORDER BY pinned DESC,
           CASE kind WHEN 'preference' THEN 0 WHEN 'decision' THEN 1 WHEN 'convention' THEN 2 ELSE 3 END,
           use_count DESC, updated_at DESC`,
      )
      .all(projectId ?? "", projectId ?? "") as MemoryRow[];

    const cardLine = card ? renderCard(card) : "";
    let tokens = estimateTokens(cardLine) + estimateTokens(ALWAYS_ON_HEAD.join("\n")) + 4;
    const items: ContextItem[] = [];
    const lines: string[] = [];
    for (const r of rows) {
      const item = memoryItem(r, 1, r.pinned ? ["pinned"] : [`always_on:${r.kind}`], versions);
      const l = line(item, r.updated_at);
      const cost = estimateTokens(l);
      if (tokens + cost > RETRIEVAL_BUDGET.alwaysOnTokens) continue;
      items.push(item);
      lines.push(l);
      tokens += cost;
    }
    if (!cardLine && items.length === 0) return { text: "", items: [], tokens: 0 };
    const text = [
      ...ALWAYS_ON_HEAD,
      ...(cardLine ? [cardLine] : []),
      ...lines,
      "</memory>",
    ].join("\n");
    return { text, items, tokens };
  };

  /** Hybrid search: FTS and vectors, reciprocal rank fusion, filters, boosts, budget. */
  const search = async (
    req: { projectId?: string; text: string; errorOutput?: string; files?: string[] },
    exclude: Set<string>,
  ): Promise<ContextItem[]> => {
    if (projectMode(req.projectId) === "off") return [];
    const card = req.projectId ? projectCard(req.projectId) : undefined;
    const versions = card?.versions ?? {};
    const errorHead = req.errorOutput ? req.errorOutput.split("\n").filter((l) => l.trim()).slice(0, 6).join("\n").slice(0, 600) : "";
    const fileWords = (req.files ?? []).map((f) => f.split(/[\\/]/).pop() ?? f);
    const query = [req.text, errorHead, ...fileWords].join(" ");

    const ranks = new Map<string, number>();
    const add = (key: string, rank: number) => ranks.set(key, (ranks.get(key) ?? 0) + 1 / (RRF_K + rank));
    // Which signal found each item: another project's fix needs more than one (see step 4).
    const byKeywords = new Set<string>();
    const byMeaning = new Set<string>();

    // 1. Keywords (bm25).
    const terms = searchTerms(query);
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const hits = db
        .prepare("SELECT ref_id, ref_type FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT 60")
        .all(match) as { ref_id: string; ref_type: "memory" | "episode" }[];
      let rank = 0;
      for (const h of hits) {
        const key = `${h.ref_type}:${h.ref_id}`;
        if (exclude.has(key) || !eligible(key, req.projectId)) continue;
        add(key, ++rank);
        byKeywords.add(key);
        if (rank >= 20) break;
      }
    }

    // 2. Meaning (vectors), when the embedding model is ready.
    if (embedder && vectorsReady()) {
      try {
        const [q] = await embedder.embed([query.slice(0, 2000)], "query");
        if (q && q.length === meta()!.dims) {
          let rank = 0;
          for (const h of knn(q, 60)) {
            if (exclude.has(h.key) || !eligible(h.key, req.projectId)) continue;
            add(h.key, ++rank);
            byMeaning.add(h.key);
            if (rank >= 20) break;
          }
        }
      } catch {
        // keyword results still stand
      }
    }

    // 3. Exact error signature: the strongest signal, even without a keyword hit.
    const normError = errorHead ? normalizeErrorSignature(errorHead) : "";
    const firstError = req.errorOutput ? errorSignatureOf(req.errorOutput) : "";
    const sigEpisodes = new Set<string>();
    if (normError || firstError) {
      const eps = db
        .prepare("SELECT id, error_signature FROM episodes WHERE status = 'active' AND error_signature IS NOT NULL")
        .all() as { id: string; error_signature: string }[];
      for (const e of eps) {
        if (e.error_signature && (normError.includes(e.error_signature) || firstError === e.error_signature)) {
          const key = `episode:${e.id}`;
          if (exclude.has(key) || !eligible(key, req.projectId)) continue;
          sigEpisodes.add(key);
          if (!ranks.has(key)) ranks.set(key, 0);
        }
      }
    }

    // 4. Build items, boost, sort, cut to budget.
    const t = now();
    const items: ContextItem[] = [];
    for (const [key, rrf] of ranks) {
      const [type, id] = key.split(/:(.*)/s) as ["memory" | "episode", string];
      if (type === "memory") {
        const r = getRow(id);
        if (!r) continue;
        let score = rrf;
        const reasons: string[] = [];
        if (r.trust === "user" || r.trust === "verified") {
          score += BOOST.trust;
          reasons.push(`trust:${r.trust}`);
        }
        if (r.last_used_at && t - r.last_used_at < RECENT_MS) {
          score += BOOST.recentUse;
          reasons.push("recently_used");
        }
        reasons.unshift(r.scope === "project" ? "project_memory" : "global_memory");
        items.push(memoryItem(r, score, reasons, versions));
      } else {
        const e = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as EpisodeRow | undefined;
        if (!e) continue;
        const same = !!e.project_id && e.project_id === req.projectId;
        // Another project's fix is about a failure. For a task without an error it is shown only
        // when keywords and meaning agree on it; otherwise it crowds out this project's own notes.
        if (!same && !sigEpisodes.has(key) && !req.errorOutput && !(byKeywords.has(key) && byMeaning.has(key))) continue;
        // Other projects only ever see the project-neutral lesson, never paths or code.
        const text = same ? `${e.problem}\nFix: ${e.fix_summary}` : (e.lesson ?? "");
        if (!text) continue;
        let score = rrf + BOOST.trust;
        const reasons = ["trust:verified"];
        if (sigEpisodes.has(key)) {
          score += BOOST.errorSignature;
          reasons.unshift("error_signature_match");
        }
        if (!same) reasons.push("cross_project_lesson");
        const env = JSON.parse(e.env_json) as Record<string, string>;
        const v = isOutdated(env, versions);
        if (v.outdated) reasons.push("version_mismatch");
        items.push({
          ref: { type: "episode", id: e.id },
          handle: `e:${shortId(e.id)}`,
          kind: same ? "fix" : "lesson",
          trust: "verified",
          text,
          score,
          reasons,
          possiblyOutdated: v.outdated,
          tokens: estimateTokens(text),
        });
      }
    }
    items.sort((a, b) => b.score - a.score);
    const out: ContextItem[] = [];
    // The wrapper and each line's id/tags count against the budget too.
    let tokens = estimateTokens(RECALLED_HEAD.join("\n")) + 4;
    for (const i of items) {
      if (out.length >= RETRIEVAL_BUDGET.maxTaskItems) break;
      const cost = estimateTokens(line(i));
      if (tokens + cost > RETRIEVAL_BUDGET.taskTokens) continue;
      out.push(i);
      tokens += cost;
    }
    return out;
  };

  /** Status, scope and project-mode filter for one index hit. */
  function eligible(key: string, projectId: string | undefined): boolean {
    const [type, id] = key.split(/:(.*)/s) as [string, string];
    if (type === "memory") {
      const r = db.prepare("SELECT status, scope, project_id, pinned FROM memories WHERE id = ?").get(id) as
        | { status: string; scope: string; project_id: string | null; pinned: number }
        | undefined;
      // Pinned memories are usually always on; callers exclude what the always-on block already holds.
      if (!r || r.status !== "active") return false;
      return r.scope === "global" || (!!projectId && r.project_id === projectId);
    }
    if (type === "episode") {
      const e = db.prepare("SELECT status, project_id, lesson FROM episodes WHERE id = ?").get(id) as
        | { status: string; project_id: string | null; lesson: string | null }
        | undefined;
      if (!e || e.status !== "active") return false;
      if (e.project_id && e.project_id === projectId) return true;
      // Another project's episode: only its lesson may cross, and only if that project shares memory.
      return !!e.lesson && (!e.project_id || projectMode(e.project_id) !== "off");
    }
    return false;
  }

  const strip = ({ handle: _h, kind: _k, trust: _t, ...item }: ContextItem): RetrievedItem => {
    const { outdatedDetail: _d, ...rest } = item as RetrievedItem & { outdatedDetail?: string };
    return rest;
  };

  // -- the API ----------------------------------------------------------------

  const api: MemoryStore = {
    async listMemories(f) {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.status) {
        where.push("status = ?");
        args.push(f.status);
      } else where.push("status NOT IN ('superseded', 'rejected', 'pending_review')");
      if (f.projectId !== undefined) {
        where.push("(scope = 'global' OR project_id = ?)");
        args.push(f.projectId);
      }
      if (f.kind) {
        where.push("kind = ?");
        args.push(f.kind);
      }
      if (f.query?.trim()) {
        where.push("(lower(key) LIKE ? OR lower(body) LIKE ?)");
        const like = `%${f.query.trim().toLowerCase().replace(/[%_]/g, (c) => `\\${c}`)}%`;
        args.push(like, like);
      }
      const offset = f.cursor ? Number.parseInt(f.cursor, 10) : 0;
      if (!Number.isFinite(offset) || offset < 0) throw new MemoryApiError("invalid", "bad cursor");
      const rows = db
        .prepare(
          `SELECT * FROM memories WHERE ${where.join(" AND ").replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")}
           ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, pageSize + 1, offset) as MemoryRow[];
      const page: Page<Memory> = { items: rows.slice(0, pageSize).map(toMemory) };
      if (rows.length > pageSize) page.nextCursor = String(offset + pageSize);
      return page;
    },

    async getEvidence(id) {
      const r = mustRow(id);
      const refs = JSON.parse(r.evidence_json) as Memory["evidence"];
      const cut = (s: string) => (s.length > 400 ? `${s.slice(0, 400)}…` : s);
      return refs.map((e): EvidenceItem => {
        if (e.type === "message") {
          const m = db.prepare("SELECT session_id, role, content FROM messages WHERE id = ?").get(e.id) as
            | { session_id: string; role: EvidenceItem["role"]; content: string }
            | undefined;
          return m ? { ...e, excerpt: cut(m.content), sessionId: m.session_id, messageId: e.id, ...(m.role ? { role: m.role } : {}) } : { ...e, excerpt: "", missing: true };
        }
        if (e.type === "tool_call") {
          const c = db
            .prepare("SELECT t.name, t.command, t.output_excerpt, t.message_id, m.session_id FROM tool_calls t JOIN messages m ON m.id = t.message_id WHERE t.id = ?")
            .get(e.id) as { name: string; command: string | null; output_excerpt: string | null; message_id: string; session_id: string } | undefined;
          if (!c) return { ...e, excerpt: "", missing: true };
          const excerpt = [c.command ?? c.name, c.output_excerpt ?? ""].filter(Boolean).join("\n");
          return { ...e, excerpt: cut(excerpt), sessionId: c.session_id, messageId: c.message_id, role: "assistant" };
        }
        if (e.type === "source") {
          const src = db.prepare("SELECT url, title, excerpt FROM sources WHERE id = ?").get(e.id) as { url: string; title: string | null; excerpt: string | null } | undefined;
          return src ? { ...e, excerpt: cut(src.excerpt ?? ""), url: src.url, ...(src.title ? { title: src.title } : {}) } : { ...e, excerpt: "", missing: true };
        }
        const ep = db.prepare("SELECT problem, fix_summary, session_id FROM episodes WHERE id = ?").get(e.id) as
          | { problem: string; fix_summary: string; session_id: string | null }
          | undefined;
        return ep ? { ...e, excerpt: cut(`${ep.problem}\n${ep.fix_summary}`), ...(ep.session_id ? { sessionId: ep.session_id } : {}) } : { ...e, excerpt: "", missing: true };
      });
    },

    async getMemory(id) {
      const r = mustRow(id);
      const older = history(r);
      const ids = [r.id, ...older.map((o) => o.id)];
      const events = db
        .prepare(`SELECT * FROM memory_events WHERE memory_id IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`)
        .all(...ids) as { id: number; memory_id: string | null; episode_id: string | null; action: MemoryEvent["action"]; actor: MemoryEvent["actor"]; session_id: string | null; at: number }[];
      return {
        memory: toMemory(r),
        history: older.map(toMemory),
        events: events.map((e) => ({
          id: e.id,
          ...(e.memory_id ? { memoryId: e.memory_id } : {}),
          ...(e.episode_id ? { episodeId: e.episode_id } : {}),
          action: e.action,
          actor: e.actor,
          ...(e.session_id ? { sessionId: e.session_id } : {}),
          at: e.at,
        })),
      };
    },

    createMemory: (input) => create(input, { actor: "user", evidence: [] }),

    async remember(input, evidence) {
      // Saving from inside a read-only or off project is refused even for global
      // memories: otherwise what the user marked private could leak to every project.
      if (evidence.contextProjectId && projectMode(evidence.contextProjectId) !== "on") {
        throw new MemoryApiError("project_mode", "Memory for this project is read-only or off, so nothing new is saved from it");
      }
      const refs: Memory["evidence"] = evidence.messageId ? [{ type: "message", id: evidence.messageId }] : [];
      return create(input, { actor: "user", evidence: refs, ...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}) });
    },

    async updateMemory(id, patch) {
      let p: MemoryPatch;
      try {
        p = MemoryPatch.parse(patch);
      } catch (err) {
        throw new MemoryApiError("invalid", err instanceof Error ? err.message : "invalid patch");
      }
      const old = mustRow(id);
      if (old.status === "superseded") throw new MemoryApiError("conflict", "This is an old version; edit the current one");
      assertWritable(old.project_id ?? undefined);
      const key = p.key !== undefined ? normalizeKey(p.key) : old.key;
      if (!key) throw new MemoryApiError("invalid", "Give the memory a short subject, e.g. style.semicolons");
      const body = p.body !== undefined ? p.body.trim() : old.body;
      assertNoSecrets(key, body, JSON.stringify(p.appliesTo ?? {}));
      const appliesTo =
        p.appliesTo === null ? undefined : (p.appliesTo ?? (old.applies_to_json ? (JSON.parse(old.applies_to_json) as Record<string, string>) : undefined));
      const memory = insertMemory(
        {
          kind: old.kind,
          scope: old.scope,
          projectId: old.project_id ?? undefined,
          key,
          body,
          pinned: p.pinned ?? old.pinned === 1,
          trust: "user",
          appliesTo,
          evidence: JSON.parse(old.evidence_json) as Memory["evidence"],
        },
        old,
        "edited",
        "user",
      );
      await embedMemory(memory);
      return memory;
    },

    async deleteMemory(id) {
      const r = mustRow(id);
      const all = [r, ...history(r)];
      db.transaction(() => {
        // Newest first, so supersedes_id never points at a row that is already gone.
        for (const m of all) {
          db.prepare("DELETE FROM memories WHERE id = ?").run(m.id);
          log("deleted", "user", m.id);
        }
      })();
      for (const m of all) emit({ type: "memory", action: "deleted", id: m.id });
    },

    async setPinned(id, pinned) {
      const r = mustRow(id);
      assertWritable(r.project_id ?? undefined);
      if ((r.pinned === 1) === pinned) return;
      db.prepare("UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?").run(pinned ? 1 : 0, now(), id);
      log("edited", "user", id);
      emit({ type: "memory", action: "edited", id });
    },

    async listCandidates() {
      const t = now();
      const expired = db
        .prepare("SELECT id FROM memories WHERE status = 'pending_review' AND review_after IS NOT NULL AND review_after <= ?")
        .all(t) as { id: string }[];
      if (expired.length) {
        db.transaction(() => {
          for (const e of expired) db.prepare("DELETE FROM memories WHERE id = ?").run(e.id);
        })();
        for (const e of expired) emit({ type: "candidate", action: "expired", id: e.id });
      }
      const rows = db.prepare("SELECT * FROM memories WHERE status = 'pending_review' ORDER BY created_at DESC").all() as MemoryRow[];
      return rows.map(
        (r): Candidate => ({
          id: r.id,
          kind: r.kind,
          scope: r.scope,
          ...(r.project_id ? { projectId: r.project_id } : {}),
          key: r.key,
          body: r.body,
          evidence: JSON.parse(r.evidence_json) as Candidate["evidence"],
          ...(r.conflicts_with ? { conflictsWith: r.conflicts_with } : {}),
          seenInSessions: Math.max(1, r.seen_in_sessions),
          expiresAt: r.review_after ?? r.created_at + 30 * 24 * 3600 * 1000,
          createdAt: r.created_at,
        }),
      );
    },

    /** `by: "auto"` is the recurring-proposal auto-accept: not the user's decision, so not counted in reviewStats. */
    async resolveCandidate(id, resolution, by: "user" | "auto" = "user") {
      let r: CandidateResolution;
      try {
        r = CandidateResolution.parse(resolution);
      } catch (err) {
        throw new MemoryApiError("invalid", err instanceof Error ? err.message : "invalid resolution");
      }
      const c = getRow(id);
      if (!c || c.status !== "pending_review" || (c.review_after !== null && c.review_after <= now())) {
        throw new MemoryApiError("not_found", `candidate ${id} not found`);
      }
      const evidence = JSON.parse(c.evidence_json) as Memory["evidence"];
      const decide = (outcome: "accepted" | "edited" | "rejected") => {
        if (by !== "user") return;
        const fromSession = evidence.some((e) => e.type === "message" || e.type === "tool_call") ? 1 : 0;
        db.prepare("INSERT INTO review_decisions (from_session, outcome, at) VALUES (?, ?, ?)").run(fromSession, outcome, now());
      };
      if (r === "reject") {
        decide("rejected");
        db.prepare("UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ?").run(now(), id);
        emit({ type: "candidate", action: "resolved", id });
        return;
      }
      assertWritable(c.project_id ?? undefined);
      const edit = typeof r === "object" ? r.edit : {};
      const key = edit.key !== undefined ? normalizeKey(edit.key) : c.key;
      const body = edit.body !== undefined ? edit.body.trim() : c.body;
      assertNoSecrets(key, body, JSON.stringify(edit.appliesTo ?? {}));
      const conflict = c.conflicts_with ? getRow(c.conflicts_with) : undefined;
      // An edit that moves the candidate to another subject no longer replaces the conflicting memory.
      const movedAway = edit.key !== undefined && key !== c.key && conflict?.key !== key;
      const replaces = conflict?.status === "active" && !movedAway ? conflict : undefined;
      const appliesTo =
        edit.appliesTo === null ? undefined : (edit.appliesTo ?? (c.applies_to_json ? (JSON.parse(c.applies_to_json) as Record<string, string>) : undefined));
      const memory = db.transaction(() => {
        const m = insertMemory(
        {
          kind: c.kind,
          scope: c.scope,
          projectId: c.project_id ?? undefined,
          key,
          body,
          pinned: edit.pinned ?? false,
          // Confirmed by the user, so it is no longer an inferred memory.
          trust: "user",
          appliesTo,
          evidence,
        },
        replaces,
        "accepted",
        "user",
      );
        db.prepare("DELETE FROM memories WHERE id = ?").run(id);
        const changed = key !== c.key || body !== c.body || (edit.appliesTo !== undefined && JSON.stringify(edit.appliesTo) !== (c.applies_to_json ?? "null"));
        decide(changed ? "edited" : "accepted");
        return m;
      })();
      emit({ type: "candidate", action: "resolved", id });
      await embedMemory(memory);
    },

    async reviewStats() {
      const since = now() - REVIEW_STATS_WINDOW_MS;
      const rows = db
        .prepare("SELECT from_session, outcome, COUNT(*) AS n FROM review_decisions WHERE at >= ? GROUP BY from_session, outcome")
        .all(since) as { from_session: number; outcome: "accepted" | "edited" | "rejected"; n: number }[];
      const tally = (fromSession: number) => {
        const n = (o: string) => rows.find((r) => r.from_session === fromSession && r.outcome === o)?.n ?? 0;
        return { accepted: n("accepted") + n("edited"), edited: n("edited"), rejected: n("rejected") };
      };
      return { fromSessions: tally(1), fromFiles: tally(0), since };
    },

    async retrieve(task): Promise<RetrieveResult> {
      let req: RetrieveRequest;
      try {
        req = RetrieveRequest.parse(task);
      } catch (err) {
        throw new MemoryApiError("invalid", err instanceof Error ? err.message : "invalid request");
      }
      const mem = await search(req, new Set());
      // Docs are searched separately (top 3) and fill what the memories left of the budget.
      const used = mem.reduce((n, i) => n + estimateTokens(line(i)), estimateTokens(RECALLED_HEAD.join("\n")) + 4);
      const room = { items: Math.min(3, RETRIEVAL_BUDGET.maxTaskItems - mem.length), tokens: RETRIEVAL_BUDGET.taskTokens - used };
      const docHits = room.items > 0 && req.projectId ? await docs.search({ projectId: req.projectId, query: req.text, k: 3, excerpt: 600 }) : [];
      const items = [...mem, ...docItems(docHits, room)].map(strip);
      return { items, tokens: items.reduce((n, i) => n + i.tokens, 0) };
    },

    async taskContext(req, exclude = new Set()) {
      if (!req.text.trim()) return { text: "", items: [], tokens: 0 };
      const mem = await search(req, exclude);
      // Docs go in only when keywords and meaning agree on them, so small talk doesn't pull in pages.
      const used = mem.reduce((n, i) => n + estimateTokens(line(i)), estimateTokens(RECALLED_HEAD.join("\n")) + 4);
      const room = { items: Math.min(2, RETRIEVAL_BUDGET.maxTaskItems - mem.length), tokens: RETRIEVAL_BUDGET.taskTokens - used };
      const docHits =
        room.items > 0 && req.projectId
          ? (await docs.search({ projectId: req.projectId, query: [req.text, req.errorOutput ?? ""].join(" "), k: 4, excerpt: 500 })).filter((h) => h.agreed)
          : [];
      const items = [...mem, ...docItems(docHits, room)].filter((i) => !exclude.has(`${i.ref.type}:${i.ref.id}`));
      if (items.length === 0) return { text: "", items: [], tokens: 0 };
      const text = [
        ...RECALLED_HEAD,
        ...items.map((i) => line(i)),
        "</recalled>",
      ].join("\n");
      return { text, items, tokens: items.reduce((n, i) => n + i.tokens, 0) };
    },

    alwaysOn,

    async listDocPacks(projectId) {
      return docs.listDocPacks(projectId);
    },

    async buildDocPack(projectId, library, version) {
      return docs.buildDocPack(projectId, library, version);
    },

    async suggestDocPacks(projectId): Promise<DocSuggestion[]> {
      return docs.suggestDocPacks(projectId);
    },

    ensureDocPacks: (projectId) => docs.ensureDocPacks(projectId),

    async listEpisodes(q) {
      return episodes.listEpisodes(q);
    },
    async getEpisode(id) {
      return episodes.getEpisode(id);
    },
    async deleteEpisode(id) {
      episodes.deleteEpisode(id);
    },
    learnFromSession: (sessionId) => episodes.learnFromSession(sessionId),

    queueExtraction(sessionId) {
      const s = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId) as { project_id: string | null } | undefined;
      if (!s || !readSetting("autoExtract", true) || !options.extractor?.()) return false;
      if (projectMode(s.project_id ?? undefined) !== "on") return false;
      if (jobs.pending().some((j) => j.kind === "extraction" && j.payload.type === "memories" && j.payload.sessionId === sessionId)) return false;
      jobs.enqueue("extraction", { type: "memories", sessionId });
      return true;
    },

    async revalidateResearch(fetchPage, opts = {}) {
      const due = db
        .prepare("SELECT * FROM memories WHERE kind = 'research' AND status = 'active' AND review_after IS NOT NULL AND review_after <= ? ORDER BY review_after LIMIT ?")
        .all(now(), opts.limit ?? 10) as MemoryRow[];
      let renewed = 0;
      let stale = 0;
      for (const m of due) {
        if (opts.signal?.aborted) break;
        const sourceIds = (JSON.parse(m.evidence_json) as Memory["evidence"]).filter((e) => e.type === "source").map((e) => e.id);
        const urls = sourceIds
          .map((id) => (db.prepare("SELECT url FROM sources WHERE id = ?").get(id) as { url: string } | undefined)?.url)
          .filter((u): u is string => !!u);
        let supported = false;
        for (const url of urls) {
          try {
            const page = await fetchPage(url, opts.signal);
            if (claimSupport(`${m.key.replace(/[._]/g, " ")} ${m.body}`, page) >= 0.5) {
              supported = true;
              db.prepare("UPDATE sources SET retrieved_at = ? WHERE url = ?").run(now(), url);
              break;
            }
          } catch {
            // unreachable: try the next source
          }
        }
        if (supported) {
          db.prepare("UPDATE memories SET review_after = ? WHERE id = ?").run(now() + RESEARCH_REVIEW_MS, m.id);
          renewed++;
        } else {
          // The page is gone or no longer says this: keep it out of retrieval until the user re-confirms it.
          db.prepare("UPDATE memories SET status = 'stale', updated_at = ? WHERE id = ?").run(now(), m.id);
          db.prepare("INSERT INTO memory_events (memory_id, action, actor, at) VALUES (?, 'edited', 'system', ?)").run(m.id, now());
          emit({ type: "memory", action: "edited", id: m.id });
          stale++;
        }
      }
      return { checked: due.length, renewed, stale };
    },

    async errorRecall(req, exclude = new Set()) {
      if (!req.errorOutput.trim()) return [];
      const items = await search({ ...(req.projectId ? { projectId: req.projectId } : {}), text: req.task ?? "", errorOutput: req.errorOutput }, exclude);
      // Only fixes for this very error: anything looser would be noise in the middle of a run.
      return items.filter((i) => i.ref.type === "episode" && i.reasons.includes("error_signature_match")).slice(0, 2);
    },

    searchDocs: (req) => docs.search(req),

    jobs,

    async seedProject(projectId, opts) {
      const p = db.prepare("SELECT path, seeded_at FROM projects WHERE id = ?").get(projectId) as { path: string; seeded_at: number | null } | undefined;
      if (!p) throw new MemoryApiError("not_found", `project ${projectId} not found`);
      if (projectMode(projectId) !== "on") return { created: 0, files: [] };
      if (p.seeded_at && !opts?.again) return { created: 0, files: [] };
      const items = findConventions(p.path);
      const t = now();
      // Already known as a memory or a proposal: not proposed again.
      const known = new Set(
        (
          db
            .prepare("SELECT lower(body) AS b FROM memories WHERE (project_id = ? OR scope = 'global') AND status IN ('active', 'pending_review')")
            .all(projectId) as { b: string }[]
        ).map((r) => r.b),
      );
      const keys = new Set<string>();
      const created: string[] = [];
      const files = new Set<string>();
      db.transaction(() => {
        const sources = new Map<string, string>();
        for (const item of items) {
          if (known.has(item.text.toLowerCase())) continue;
          let key = normalizeKey(seedKey(item));
          if (!key) continue;
          for (let n = 2; keys.has(key) || db.prepare("SELECT 1 FROM memories WHERE key = ? AND project_id = ? AND status IN ('active', 'pending_review')").get(key, projectId); n++) {
            key = `${normalizeKey(seedKey(item))}-${n}`;
          }
          keys.add(key);
          let src = sources.get(item.file);
          if (!src) {
            src = newId("src");
            db.prepare("INSERT INTO sources (id, url, title, is_official, retrieved_at, excerpt) VALUES (?, ?, ?, 0, ?, ?)").run(
              src,
              `file://${p.path.replace(/\/+$/, "")}/${item.file}`,
              item.file,
              t,
              item.text.slice(0, 200),
            );
            sources.set(item.file, src);
          }
          const id = newId("mem");
          db.prepare(
            `INSERT INTO memories (id, kind, scope, project_id, key, body, trust, status, evidence_json, review_after, created_at, updated_at)
             VALUES (?, 'convention', 'project', ?, ?, ?, 'inferred', 'pending_review', ?, ?, ?, ?)`,
          ).run(id, projectId, key, item.text, JSON.stringify([{ type: "source", id: src }]), t + 30 * 24 * 3600 * 1000, t, t);
          created.push(id);
          files.add(item.file);
        }
        db.prepare("UPDATE projects SET seeded_at = ? WHERE id = ?").run(t, projectId);
      })();
      for (const id of created) emit({ type: "candidate", action: "created", id });
      return { created: created.length, files: [...files] };
    },

    recordUse(messageId, items, answer, sessionId) {
      if (items.length === 0) return;
      const cited = new Set((answer.match(/\[(?:m|e|d):[a-z0-9]{4,8}\]/gi) ?? []).map((c) => c.slice(1, -1).toLowerCase()));
      const t = now();
      // An answer that cites nothing still used what it was given (the same rule getUsedMemories shows).
      const anyCited = items.some((i) => cited.has(i.handle));
      db.transaction(() => {
        for (const i of items) {
          // A memory deleted while the run was going stays deleted.
          if (i.ref.type === "memory" && !getRow(i.ref.id)) continue;
          const isCited = cited.has(i.handle);
          db.prepare(
            `INSERT OR IGNORE INTO memory_uses (message_id, ref_type, ref_id, text, score, reasons_json, possibly_outdated, tokens, cited)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(messageId, i.ref.type, i.ref.id, i.text, i.score, JSON.stringify(i.reasons), i.possiblyOutdated ? 1 : 0, i.tokens, isCited ? 1 : 0);
          if (i.ref.type === "memory") {
            log("injected", "agent", i.ref.id, sessionId);
            if (isCited || !anyCited) db.prepare("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").run(t, i.ref.id);
          }
        }
      })();
    },

    async getUsedMemories(messageId) {
      const rows = db.prepare("SELECT * FROM memory_uses WHERE message_id = ? ORDER BY cited DESC, score DESC").all(messageId) as {
        ref_type: RetrievedItem["ref"]["type"];
        ref_id: string;
        text: string;
        score: number;
        reasons_json: string;
        possibly_outdated: number;
        tokens: number;
        cited: number;
      }[];
      // Cited items when the answer cited any; otherwise everything it was given, labelled as such.
      const anyCited = rows.some((r) => r.cited === 1);
      return rows
        .filter((r) => !anyCited || r.cited === 1)
        .map((r) => ({
          ref: { type: r.ref_type, id: r.ref_id },
          text: r.text,
          score: r.score,
          reasons: [r.cited ? "cited" : "provided", ...(JSON.parse(r.reasons_json) as string[])],
          possiblyOutdated: r.possibly_outdated === 1,
          tokens: r.tokens,
        }));
    },

    async getSettings() {
      return settings();
    },

    async updateSettings(patch) {
      let p: Partial<MemorySettings>;
      try {
        p = MemorySettings.partial().parse(patch);
      } catch (err) {
        throw new MemoryApiError("invalid", err instanceof Error ? err.message : "invalid settings");
      }
      db.transaction(() => {
        for (const [projectId, mode] of Object.entries(p.projectModes ?? {})) {
          const res = db.prepare("UPDATE projects SET memory_mode = ? WHERE id = ?").run(mode, projectId);
          if (res.changes === 0) throw new MemoryApiError("not_found", `project ${projectId} not found`);
        }
        if (p.autoExtract !== undefined) writeSetting("autoExtract", p.autoExtract);
        if (p.autoAcceptRecurring !== undefined) writeSetting("autoAcceptRecurring", p.autoAcceptRecurring);
        if (p.embeddingModel !== undefined) {
          const model = p.embeddingModel.trim();
          if (!model) throw new MemoryApiError("invalid", "Enter the embedding model's name");
          writeSetting("embeddingModel", model);
        }
      })();
      return settings();
    },

    onChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    projectCard,
    projectMode,

    setEmbedder(e) {
      embedder = e;
      indexed = false;
      reindexGen++; // a reindex still running for the old model stops at its next batch
    },

    vectorsReady,

    async reindex(signal) {
      const e = embedder;
      if (!e) return { embedded: 0, error: "no embedding model" };
      const gen = ++reindexGen;
      const stale = () => gen !== reindexGen || embedder !== e;
      const STALE = "a newer reindex took over";
      try {
        // Memories and verified fixes share the vector index.
        const indexable = () => [
          ...(db.prepare("SELECT id, key, body FROM memories WHERE status = 'active'").all() as { id: string; key: string; body: string }[]).map((r) => ({
            vkey: vecKey("memory", r.id),
            text: `${r.key}: ${r.body}`,
            live: () => isActive(r.id),
          })),
          ...(db.prepare("SELECT id, problem, error_signature, fix_summary, lesson FROM episodes WHERE status = 'active'").all() as {
            id: string;
            problem: string;
            error_signature: string | null;
            fix_summary: string;
            lesson: string | null;
          }[]).map((r) => ({
            vkey: vecKey("episode", r.id),
            text: episodeText(r.problem, r.error_signature, r.fix_summary, r.lesson),
            live: () => !!db.prepare("SELECT 1 FROM episodes WHERE id = ? AND status = 'active'").get(r.id),
          })),
        ];
        const missing = () => {
          const have = new Set((db.prepare("SELECT ref_key FROM memory_vec").all() as { ref_key: string }[]).map((r) => r.ref_key));
          return indexable().filter((r) => !have.has(r.vkey));
        };
        const current = meta();
        let todo = current?.model === e.model ? missing() : indexable();
        let embedded = 0;
        if (current?.model !== e.model || todo.length > 0) {
          // Learn the model's dimensions from a first batch (or a probe when there is nothing to embed).
          const first = todo.slice(0, 32);
          const firstVecs = await e.embed(first.length ? first.map((r) => r.text) : ["probe"], "document", signal);
          if (stale()) return { embedded: 0, error: STALE };
          const dims = firstVecs[0]?.length;
          if (!dims) return { embedded: 0, error: "embedding model returned no vectors" };
          if (current?.model !== e.model || current.dims !== dims) {
            db.transaction(() => {
              if (!current || current.dims !== dims) recreateVecTable(dims);
              else db.exec("DELETE FROM memory_vec");
              docs.resetVectors(dims); // docs vectors belong to the old model too
              db.prepare(
                "INSERT INTO embedding_meta (id, model, dims, created_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model, dims = excluded.dims, created_at = excluded.created_at",
              ).run(e.model, dims, now());
            })();
          }
          const write = (batch: typeof todo, vecs: Float32Array[]) =>
            db.transaction(() => {
              batch.forEach((r, i) => {
                const v = vecs[i];
                if (v && v.length === dims && r.live()) {
                  writeVector(r.vkey, v);
                  embedded++;
                }
              });
            })();
          if (first.length) write(first, firstVecs);
          // Rows written while we worked are picked up by another pass.
          for (let pass = 0; pass < 3; pass++) {
            for (let i = pass === 0 ? 32 : 0; i < todo.length; i += 32) {
              if (signal?.aborted) return { embedded, error: "aborted" };
              const batch = todo.slice(i, i + 32);
              const vecs = await e.embed(batch.map((r) => r.text), "document", signal);
              if (stale()) return { embedded, error: STALE };
              write(batch, vecs);
            }
            todo = missing();
            if (todo.length === 0) break;
          }
        }
        if (stale()) return { embedded, error: STALE };
        indexed = true;
        // Docs after memories: memory search is usable while the (larger) docs catch up.
        const docsEmbedded = await docs.embedMissing(signal).catch(() => 0);
        return { embedded, ...(docsEmbedded ? { docs: docsEmbedded } : {}) };
      } catch (err) {
        return { embedded: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
  return api;
}
