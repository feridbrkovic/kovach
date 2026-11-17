/**
 * Local Kovach memory contract.
 *
 * The single boundary between the memory service and the UI / agent loop.
 * Schemas are the source of truth; TypeScript types are inferred from them.
 * Breaking changes bump CONTRACT_VERSION (semver) and need a migration note.
 */
import { z } from "zod";

export const CONTRACT_VERSION = "1.4.0";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Unix epoch milliseconds. */
export const Timestamp = z.number().int().nonnegative();
export const Id = z.string().min(1);

export const Trust = z.enum(["user", "verified", "official", "inferred"]);
export type Trust = z.infer<typeof Trust>;

export const MemoryStatus = z.enum(["active", "pending_review", "superseded", "stale", "rejected"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryKind = z.enum(["preference", "decision", "convention", "open_issue", "lesson", "research"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const Scope = z.enum(["global", "project"]);
export type Scope = z.infer<typeof Scope>;

export const ProjectMemoryMode = z.enum(["on", "read_only", "off"]);
export type ProjectMemoryMode = z.infer<typeof ProjectMemoryMode>;

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().optional() });
export type Page<T> = { items: T[]; nextCursor?: string | undefined };

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const SessionStatus = z.enum(["open", "done", "archived"]);

export const SessionSummary = z.object({
  id: Id,
  projectId: Id.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  model: z.string().optional(),
  status: SessionStatus,
  messageCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const Role = z.enum(["user", "assistant", "tool", "system"]);

export const ToolCall = z.object({
  id: Id,
  name: z.string(),
  args: z.unknown().optional(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  /** First 8 KB of output; the full output lives in a blob file. */
  outputExcerpt: z.string().max(8192).optional(),
  outputPath: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  createdAt: Timestamp,
});
export type ToolCall = z.infer<typeof ToolCall>;

export const Message = z.object({
  id: Id,
  sessionId: Id,
  role: Role,
  content: z.string(),
  model: z.string().optional(),
  tokens: z.number().int().nonnegative().optional(),
  toolCalls: z.array(ToolCall).default([]),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const SessionDetail = z.object({
  session: SessionSummary,
  messages: Page(Message),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

export const MessageHit = z.object({
  sessionId: Id,
  messageId: Id,
  snippet: z.string(),
  score: z.number(),
  createdAt: Timestamp,
});
export type MessageHit = z.infer<typeof MessageHit>;

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

export const EvidenceRef = z.object({
  type: z.enum(["message", "tool_call", "source", "episode"]),
  id: Id,
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** A piece of evidence resolved for display: what was said or seen, and where (since 1.4). */
export const EvidenceItem = z.object({
  type: EvidenceRef.shape.type,
  id: Id,
  /** What it says: a message, a command and its output, or a page or file excerpt. Redacted, short. */
  excerpt: z.string(),
  /** Where to open it in history, for messages and tool calls. */
  sessionId: Id.optional(),
  messageId: Id.optional(),
  role: z.enum(["user", "assistant", "tool", "system"]).optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  /** It was deleted since (with its session, say). */
  missing: z.boolean().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** Version constraints a fact is bound to, e.g. { "react-native": "0.76" }. */
export const AppliesTo = z.record(z.string(), z.string());

export const Memory = z
  .object({
    id: Id,
    kind: MemoryKind,
    scope: Scope,
    projectId: Id.optional(),
    /** Normalized subject, e.g. "style.semicolons", "state.library". */
    key: z.string().min(1),
    body: z.string().min(1),
    trust: Trust,
    status: MemoryStatus,
    pinned: z.boolean(),
    appliesTo: AppliesTo.optional(),
    supersedesId: Id.optional(),
    evidence: z.array(EvidenceRef),
    useCount: z.number().int().nonnegative(),
    lastUsedAt: Timestamp.optional(),
    reviewAfter: Timestamp.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .refine((m) => (m.scope === "project") === (m.projectId !== undefined), {
    message: "projectId is required for project scope and forbidden for global scope",
    path: ["projectId"],
  });
export type Memory = z.infer<typeof Memory>;

/** Explicit memory from the user: always trust "user", status "active". */
export const NewMemory = z
  .object({
    kind: MemoryKind,
    scope: Scope,
    projectId: Id.optional(),
    key: z.string().min(1),
    body: z.string().min(1),
    pinned: z.boolean().default(false),
    appliesTo: AppliesTo.optional(),
  })
  .refine((m) => (m.scope === "project") === (m.projectId !== undefined), {
    message: "projectId is required for project scope and forbidden for global scope",
    path: ["projectId"],
  });
export type NewMemory = z.infer<typeof NewMemory>;
/** What callers pass to `createMemory`: defaults (e.g. `pinned`) may be omitted. */
export type NewMemoryInput = z.input<typeof NewMemory>;

/** An edit creates a new version; the old row becomes "superseded". */
export const MemoryPatch = z
  .object({
    key: z.string().min(1),
    body: z.string().min(1),
    pinned: z.boolean(),
    appliesTo: AppliesTo.nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });
export type MemoryPatch = z.infer<typeof MemoryPatch>;

export const MemoryEvent = z.object({
  id: z.number().int(),
  memoryId: Id.optional(),
  episodeId: Id.optional(),
  action: z.enum(["created", "accepted", "edited", "superseded", "injected", "deleted"]),
  actor: z.enum(["user", "agent", "system"]),
  sessionId: Id.optional(),
  at: Timestamp,
});
export type MemoryEvent = z.infer<typeof MemoryEvent>;

export const Attempt = z.object({
  approach: z.string(),
  outcome: z.enum(["failed", "partial", "passed"]),
});

export const Episode = z.object({
  id: Id,
  projectId: Id.optional(),
  sessionId: Id.optional(),
  problem: z.string(),
  /** Normalized error: paths, line numbers, timestamps and hashes stripped. */
  errorSignature: z.string().optional(),
  env: z.record(z.string(), z.string()),
  attempts: z.array(Attempt),
  fixSummary: z.string(),
  files: z.array(z.string()),
  verifiedBy: z.enum(["test", "build", "typecheck", "run", "user"]),
  /** Project-neutral takeaway; the only part shown in other projects. */
  lesson: z.string().optional(),
  status: z.enum(["active", "stale", "rejected"]),
  createdAt: Timestamp,
});
export type Episode = z.infer<typeof Episode>;

/** Output of the extraction job, waiting in the review inbox. */
export const Candidate = z.object({
  id: Id,
  kind: MemoryKind,
  scope: Scope,
  projectId: Id.optional(),
  key: z.string(),
  body: z.string(),
  evidence: z.array(EvidenceRef).min(1),
  /** Set when the candidate conflicts with an existing user-trusted memory. */
  conflictsWith: Id.optional(),
  seenInSessions: z.number().int().positive(),
  expiresAt: Timestamp,
  createdAt: Timestamp,
});
export type Candidate = z.infer<typeof Candidate>;

export const CandidateResolution = z.union([
  z.literal("accept"),
  z.literal("reject"),
  z.object({ edit: MemoryPatch }),
]);
export type CandidateResolution = z.infer<typeof CandidateResolution>;

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** How proposals fared in review: the plan's extraction precision, measured on real decisions (since 1.3). */
export const ReviewTally = z.object({
  accepted: z.number().int().nonnegative(),
  /** Of the accepted ones, how many were edited first. */
  edited: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type ReviewTally = z.infer<typeof ReviewTally>;

export const ReviewStats = z.object({
  /** Proposed from what was said in sessions (the extraction job). */
  fromSessions: ReviewTally,
  /** Imported from project files (AGENTS.md, CLAUDE.md, README…). */
  fromFiles: ReviewTally,
  /** Start of the window counted, in ms since the epoch. */
  since: Timestamp,
});
export type ReviewStats = z.infer<typeof ReviewStats>;

export const RetrieveRequest = z.object({
  projectId: Id.optional(),
  text: z.string().min(1),
  errorOutput: z.string().optional(),
  files: z.array(z.string()).optional(),
});
export type RetrieveRequest = z.infer<typeof RetrieveRequest>;

export const RetrievedItem = z.object({
  ref: z.object({ type: z.enum(["memory", "episode", "doc", "skill"]), id: Id }),
  text: z.string(),
  score: z.number(),
  /** Why it ranked, e.g. ["error_signature_match", "trust:verified"]. */
  reasons: z.array(z.string()),
  possiblyOutdated: z.boolean(),
  tokens: z.number().int().nonnegative(),
});
export type RetrievedItem = z.infer<typeof RetrievedItem>;

export const RetrieveResult = z.object({
  items: z.array(RetrievedItem),
  tokens: z.number().int().nonnegative(),
});
export type RetrieveResult = z.infer<typeof RetrieveResult>;

/** Hard budgets from the plan. */
export const RETRIEVAL_BUDGET = {
  alwaysOnTokens: 400,
  taskTokens: 1200,
  maxTaskItems: 6,
} as const;

// ---------------------------------------------------------------------------
// Docs packs, jobs, settings
// ---------------------------------------------------------------------------

export const JobRef = z.object({
  id: Id,
  kind: z.enum(["extraction", "embedding", "doc_pack", "reindex", "skill_research"]),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
});
export type JobRef = z.infer<typeof JobRef>;

export const DocPack = z.object({
  id: Id,
  library: z.string(),
  version: z.string(),
  status: z.enum(["building", "ready", "stale", "failed"]),
  chunkCount: z.number().int().nonnegative(),
  sourceUrl: z.string().url(),
  retrievedAt: Timestamp.optional(),
  /** Since 1.1: display name, e.g. "React Native". */
  label: z.string().optional(),
  /** Since 1.1: the docs version actually used when it differs (e.g. "0.77" docs for a 0.76 project). */
  docsVersion: z.string().optional(),
  /** Since 1.1: what the build resolved to, e.g. "0.76 is no longer published; using the nearest docs (0.77)". */
  note: z.string().optional(),
  /** Since 1.1: why the last build failed. */
  error: z.string().optional(),
  /** Since 1.1: progress of a running build. */
  progress: z.string().optional(),
});
export type DocPack = z.infer<typeof DocPack>;

/** Since 1.1: a library a project uses that can have a docs pack. */
export const DocSuggestion = z.object({
  library: z.string(),
  label: z.string(),
  /** The version the project uses. */
  version: z.string(),
  /** Built automatically when a project uses it. */
  auto: z.boolean(),
  pack: z
    .object({ id: Id, status: DocPack.shape.status, version: z.string(), current: z.boolean() })
    .optional(),
});
export type DocSuggestion = z.infer<typeof DocSuggestion>;

/** Since 1.1: what importing conventions from a project's own files proposed. */
export const SeedResult = z.object({
  /** Proposals added to the review inbox. */
  created: z.number().int().nonnegative(),
  /** Files they came from, relative to the project root. */
  files: z.array(z.string()),
});
export type SeedResult = z.infer<typeof SeedResult>;

export const MemorySettings = z.object({
  autoExtract: z.boolean(),
  /** Accept a candidate automatically when the same key+value recurs across sessions. */
  autoAcceptRecurring: z.boolean(),
  projectModes: z.record(Id, ProjectMemoryMode),
  embeddingModel: z.string(),
});
export type MemorySettings = z.infer<typeof MemorySettings>;

export const ImportReport = z.object({
  memories: z.number().int().nonnegative(),
  episodes: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type ImportReport = z.infer<typeof ImportReport>;

export const MemoryChangeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory"), action: MemoryEvent.shape.action, id: Id }),
  z.object({ type: z.literal("session"), action: z.enum(["created", "updated", "deleted"]), id: Id }),
  z.object({ type: z.literal("candidate"), action: z.enum(["created", "resolved", "expired"]), id: Id }),
  z.object({ type: z.literal("job"), job: JobRef }),
  /** Since 1.2: a verified fix was recorded or deleted. */
  z.object({ type: z.literal("episode"), action: z.enum(["created", "deleted"]), id: Id }),
]);
export type MemoryChangeEvent = z.infer<typeof MemoryChangeEvent>;

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every MemoryApi method rejects with a MemoryApiError carrying one of these codes.
 * - not_found:    the id does not exist (or was hard-deleted)
 * - invalid:      input failed the zod schema or a basic rule (empty title, bad cursor)
 * - conflict:     the target changed state, e.g. editing a superseded memory
 * - project_mode: the project's memory mode (read_only / off) forbids the write
 * - unavailable:  the service cannot answer right now (starting, migrating, closed)
 */
export const MemoryErrorCode = z.enum(["not_found", "invalid", "conflict", "project_mode", "unavailable"]);
export type MemoryErrorCode = z.infer<typeof MemoryErrorCode>;

/** Wire shape of an error, for transports (IPC, HTTP) that drop the class. */
export const MemoryApiErrorData = z.object({ code: MemoryErrorCode, message: z.string() });
export type MemoryApiErrorData = z.infer<typeof MemoryApiErrorData>;

export class MemoryApiError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryApiError";
    this.code = code;
  }

  toJSON(): MemoryApiErrorData {
    return { code: this.code, message: this.message };
  }

  /** Rebuild an error after it crossed a transport; anything unrecognised becomes "unavailable". */
  static from(value: unknown): MemoryApiError {
    if (value instanceof MemoryApiError) return value;
    const parsed = MemoryApiErrorData.safeParse(value);
    if (parsed.success) return new MemoryApiError(parsed.data.code, parsed.data.message);
    const message = value instanceof Error ? value.message : String(value);
    return new MemoryApiError("unavailable", message);
  }
}

export function isMemoryApiError(value: unknown, code?: MemoryErrorCode): value is MemoryApiError {
  return value instanceof MemoryApiError && (code === undefined || value.code === code);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface MemoryApi {
  // History
  listSessions(q: { projectId?: string; query?: string; cursor?: string }): Promise<Page<SessionSummary>>;
  /**
   * A session and a page of its messages, oldest first. With `latest`, the first page is the
   * newest messages instead (still in order) and `nextCursor` continues to earlier ones.
   */
  getSession(id: string, q?: { cursor?: string; latest?: boolean }): Promise<SessionDetail>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  searchMessages(q: { query: string; projectId?: string; cursor?: string }): Promise<Page<MessageHit>>;

  // Memory
  listMemories(f: {
    projectId?: string;
    kind?: MemoryKind;
    status?: MemoryStatus;
    query?: string;
    cursor?: string;
  }): Promise<Page<Memory>>;
  getMemory(id: string): Promise<{ memory: Memory; history: Memory[]; events: MemoryEvent[] }>;
  /** A memory's or proposal's evidence, resolved to what it says and where (since 1.4). */
  getEvidence(memoryId: string): Promise<EvidenceItem[]>;
  createMemory(input: NewMemoryInput): Promise<Memory>;
  updateMemory(id: string, patch: MemoryPatch): Promise<Memory>;
  /** Hard delete, including FTS and vector index rows. */
  deleteMemory(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;

  // Experience memory (since 1.2)
  /** Verified fixes, newest first; optionally one project's, or matching a search. */
  listEpisodes(q: { projectId?: string; query?: string; cursor?: string }): Promise<Page<Episode>>;
  getEpisode(id: string): Promise<Episode>;
  /** Hard delete, including FTS and vector index rows. */
  deleteEpisode(id: string): Promise<void>;

  // Review inbox
  listCandidates(): Promise<Candidate[]>;
  resolveCandidate(id: string, resolution: CandidateResolution): Promise<void>;
  /** Accepted, edited and rejected proposals over the last 90 days (since 1.3). */
  reviewStats(): Promise<ReviewStats>;

  // Retrieval
  retrieve(task: RetrieveRequest): Promise<RetrieveResult>;
  getUsedMemories(messageId: string): Promise<RetrievedItem[]>;

  // Docs packs
  listDocPacks(projectId: string): Promise<DocPack[]>;
  /** Build (or rebuild) the pack for one library version a project uses; older packs of that library go stale for that project. */
  buildDocPack(projectId: string, library: string, version: string): Promise<JobRef>;
  /** Since 1.1: libraries the project uses that can have a pack, with this project's pack status. */
  suggestDocPacks(projectId: string): Promise<DocSuggestion[]>;
  /**
   * Since 1.1: propose conventions from the project's AGENTS.md, CLAUDE.md, editor rule files and
   * README guideline sections as review-inbox candidates. Runs once per project unless `again`.
   */
  seedProject(projectId: string, opts?: { again?: boolean }): Promise<SeedResult>;

  // Settings and data
  getSettings(): Promise<MemorySettings>;
  updateSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;
  exportData(): Promise<{ path: string }>;
  importData(path: string): Promise<ImportReport>;
  clearHistory(q: { projectId?: string }): Promise<void>;

  // Live updates
  onChange(cb: (e: MemoryChangeEvent) => void): Unsubscribe;
}
