import { randomUUID } from "node:crypto";
import {
  type MemoryApi,
  MemoryApiError,
  type MemoryChangeEvent,
  Message,
  type MessageHit,
  type Page,
  type SessionDetail,
  SessionSummary,
  ToolCall,
  type Unsubscribe,
} from "@kovach-dev/memory-contract";
import { type BlobStore, EXCERPT_MAX_BYTES, utf8Prefix } from "./blobs.js";
import type { Db } from "./db.js";

/** The contract's history methods, as served to the UI. */
export type HistoryApi = Pick<
  MemoryApi,
  "listSessions" | "getSession" | "renameSession" | "deleteSession" | "searchMessages" | "clearHistory" | "onChange"
>;

export type SessionStatus = SessionSummary["status"];
export type Role = Message["role"];

export interface NewToolCall {
  name: string;
  args?: unknown;
  command?: string;
}

export interface ToolResult {
  exitCode?: number;
  /** Full output. Up to 8 KB stays in the database; longer output also goes to a blob file. */
  output?: string;
  durationMs?: number;
}

export interface HistoryOptions {
  blobs: BlobStore;
  now?: () => number;
  newId?: (prefix: string) => string;
  /** Items per page for sessions, messages and search hits. Default 50. */
  pageSize?: number;
  /**
   * Applied to tool output before it is stored (excerpt and blob). The plan's
   * secret scanner plugs in here; message text is stored as typed.
   */
  redactOutput?: (text: string) => string;
}

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  memoryMode: "on" | "read_only" | "off";
  isClient: boolean;
  createdAt: number;
}

export interface ResumeContext {
  session: SessionSummary;
  summary?: string;
  /** The last N messages, oldest first, with their tool calls. */
  messages: Message[];
}

/** Agent-loop writes plus the contract's history reads. */
export interface HistoryStore extends HistoryApi {
  ensureProject(p: { path: string; name: string; isClient?: boolean }): string;
  getProject(id: string): ProjectInfo | undefined;
  /** All projects, most recently used first. */
  listProjects(): ProjectInfo[];
  createSession(s?: { projectId?: string; title?: string; model?: string }): SessionSummary;
  appendMessage(
    sessionId: string,
    m: { role: Role; content: string; model?: string; tokens?: number; toolCalls?: NewToolCall[] },
  ): Message;
  completeToolCall(toolCallId: string, result: ToolResult): ToolCall;
  /** Full output of a tool call: the blob when there is one, else the excerpt. */
  readToolOutput(toolCallId: string): string | undefined;
  setSummary(sessionId: string, summary: string): void;
  setStatus(sessionId: string, status: SessionStatus): void;
  resume(sessionId: string, opts?: { lastN?: number }): ResumeContext;
  /** Reclaim space after large deletes ("Clear history" offers this). */
  vacuum(): void;
  /**
   * Search for the agent: only the given project's sessions, or with no
   * project only sessions that have none, so a scratch chat can't read a
   * private project's conversations.
   */
  searchScoped(q: { query: string; projectId?: string; limit?: number }): MessageHit[];
}

interface SessionRow {
  id: string;
  project_id: string | null;
  title: string | null;
  summary: string | null;
  model: string | null;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface MessageRow {
  rid: number;
  id: string;
  session_id: string;
  role: Role;
  content: string;
  model: string | null;
  tokens: number | null;
  created_at: number;
}

interface ToolCallRow {
  id: string;
  message_id: string;
  name: string;
  args_json: string | null;
  command: string | null;
  exit_code: number | null;
  output_excerpt: string | null;
  output_path: string | null;
  duration_ms: number | null;
  created_at: number;
}

interface ProjectRow {
  id: string;
  path: string;
  name: string;
  memory_mode: ProjectInfo["memoryMode"];
  is_client: number;
  created_at: number;
}

const toProject = (r: ProjectRow): ProjectInfo => ({
  id: r.id,
  path: r.path,
  name: r.name,
  memoryMode: r.memory_mode,
  isClient: r.is_client === 1,
  createdAt: r.created_at,
});

const SESSION_COLUMNS = `s.id, s.project_id, s.title, s.summary, s.model, s.status, s.created_at, s.updated_at,
  (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count`;

const MESSAGE_COLUMNS = "rowid AS rid, id, session_id, role, content, model, tokens, created_at";

export function createHistoryStore(db: Db, options: HistoryOptions): HistoryStore {
  const { blobs } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const pageSize = options.pageSize ?? 50;
  const redactOutput = options.redactOutput ?? ((t: string) => t);
  const listeners = new Set<(e: MemoryChangeEvent) => void>();

  const emit = (e: MemoryChangeEvent) => {
    for (const cb of [...listeners]) {
      try {
        cb(e);
      } catch {
        // A failing listener must not break a write.
      }
    }
  };

  // -- rows → contract objects ----------------------------------------------

  const toSession = (r: SessionRow): SessionSummary =>
    SessionSummary.parse({
      id: r.id,
      projectId: r.project_id ?? undefined,
      title: r.title ?? undefined,
      summary: r.summary ?? undefined,
      model: r.model ?? undefined,
      status: r.status,
      messageCount: r.message_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });

  const toToolCall = (r: ToolCallRow): ToolCall =>
    ToolCall.parse({
      id: r.id,
      name: r.name,
      args: r.args_json === null ? undefined : JSON.parse(r.args_json),
      command: r.command ?? undefined,
      exitCode: r.exit_code ?? undefined,
      outputExcerpt: r.output_excerpt ?? undefined,
      outputPath: r.output_path ?? undefined,
      durationMs: r.duration_ms ?? undefined,
      createdAt: r.created_at,
    });

  const withToolCalls = (rows: MessageRow[]): Message[] => {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const calls = db
      .prepare(
        `SELECT * FROM tool_calls WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at, rowid`,
      )
      .all(...ids) as ToolCallRow[];
    const byMessage = new Map<string, ToolCall[]>();
    for (const c of calls) {
      const list = byMessage.get(c.message_id) ?? [];
      list.push(toToolCall(c));
      byMessage.set(c.message_id, list);
    }
    return rows.map((r) =>
      Message.parse({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        model: r.model ?? undefined,
        tokens: r.tokens ?? undefined,
        toolCalls: byMessage.get(r.id) ?? [],
        createdAt: r.created_at,
      }),
    );
  };

  // -- lookups ----------------------------------------------------------------

  const sessionRow = (id: string) =>
    db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`).get(id) as SessionRow | undefined;

  const mustSession = (id: string): SessionRow => {
    const row = sessionRow(id);
    if (!row) throw new MemoryApiError("not_found", `session ${id} not found`);
    return row;
  };

  const touch = (sessionId: string) => {
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), sessionId);
  };

  /** Delete sessions and any blob files no other tool call still points at. */
  const deleteSessions = (ids: string[]) => {
    if (ids.length === 0) return;
    const marks = ids.map(() => "?").join(",");
    const paths = (
      db
        .prepare(
          `SELECT DISTINCT t.output_path AS p FROM tool_calls t JOIN messages m ON m.id = t.message_id
           WHERE m.session_id IN (${marks}) AND t.output_path IS NOT NULL`,
        )
        .all(...ids) as { p: string }[]
    ).map((r) => r.p);
    db.transaction(() => {
      db.prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...ids);
    })();
    const stillUsed = db.prepare("SELECT 1 FROM tool_calls WHERE output_path = ? LIMIT 1");
    for (const p of paths) if (!stillUsed.get(p)) blobs.delete(p);
    for (const id of ids) emit({ type: "session", action: "deleted", id });
  };

  // -- writes (agent loop) ---------------------------------------------------

  const store: HistoryStore = {
    ensureProject({ path, name, isClient = false }) {
      const found = db.prepare("SELECT id FROM projects WHERE path = ?").get(path) as { id: string } | undefined;
      if (found) return found.id;
      const id = newId("prj");
      // Client work defaults to read_only memory (plan: privacy and trust boundaries).
      db.prepare(
        "INSERT INTO projects (id, path, name, memory_mode, is_client, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, path, name, isClient ? "read_only" : "on", isClient ? 1 : 0, now());
      return id;
    },

    getProject(id) {
      const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
      return row ? toProject(row) : undefined;
    },

    listProjects() {
      const rows = db
        .prepare(
          `SELECT p.* FROM projects p
           LEFT JOIN (SELECT project_id, max(updated_at) AS last FROM sessions GROUP BY project_id) s ON s.project_id = p.id
           ORDER BY COALESCE(s.last, p.created_at) DESC, p.name`,
        )
        .all() as ProjectRow[];
      return rows.map(toProject);
    },

    createSession(s = {}) {
      if (s.projectId !== undefined && !db.prepare("SELECT 1 FROM projects WHERE id = ?").get(s.projectId)) {
        throw new MemoryApiError("not_found", `project ${s.projectId} not found`);
      }
      const id = newId("ses");
      const t = now();
      db.prepare(
        "INSERT INTO sessions (id, project_id, title, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)",
      ).run(id, s.projectId ?? null, s.title?.trim() || null, s.model ?? null, t, t);
      emit({ type: "session", action: "created", id });
      return toSession(mustSession(id));
    },

    appendMessage(sessionId, m) {
      mustSession(sessionId);
      const id = newId("msg");
      const t = now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO messages (id, session_id, role, content, model, tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(id, sessionId, m.role, m.content, m.model ?? null, m.tokens ?? null, t);
        const ins = db.prepare(
          "INSERT INTO tool_calls (id, message_id, name, args_json, command, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const c of m.toolCalls ?? []) {
          ins.run(newId("tc"), id, c.name, c.args === undefined ? null : JSON.stringify(c.args), c.command ?? null, t);
        }
        touch(sessionId);
      })();
      emit({ type: "session", action: "updated", id: sessionId });
      const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id) as MessageRow;
      return withToolCalls([row])[0]!;
    },

    completeToolCall(toolCallId, result) {
      const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(toolCallId) as ToolCallRow | undefined;
      if (!row) throw new MemoryApiError("not_found", `tool call ${toolCallId} not found`);
      if (row.exit_code !== null || row.output_excerpt !== null || row.duration_ms !== null) {
        throw new MemoryApiError("conflict", `tool call ${toolCallId} already has a result`);
      }
      let excerpt: string | null = null;
      let path: string | null = null;
      if (result.output !== undefined) {
        const clean = redactOutput(result.output);
        excerpt = utf8Prefix(clean, EXCERPT_MAX_BYTES);
        if (excerpt.length < clean.length) path = blobs.put(clean);
      }
      const sessionId = (
        db.prepare("SELECT session_id FROM messages WHERE id = ?").get(row.message_id) as { session_id: string }
      ).session_id;
      db.transaction(() => {
        db.prepare(
          "UPDATE tool_calls SET exit_code = ?, output_excerpt = ?, output_path = ?, duration_ms = ? WHERE id = ?",
        ).run(result.exitCode ?? null, excerpt, path, result.durationMs ?? null, toolCallId);
        touch(sessionId);
      })();
      emit({ type: "session", action: "updated", id: sessionId });
      return toToolCall(db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(toolCallId) as ToolCallRow);
    },

    readToolOutput(toolCallId) {
      const row = db
        .prepare("SELECT output_excerpt, output_path FROM tool_calls WHERE id = ?")
        .get(toolCallId) as Pick<ToolCallRow, "output_excerpt" | "output_path"> | undefined;
      if (!row) throw new MemoryApiError("not_found", `tool call ${toolCallId} not found`);
      if (row.output_path) return blobs.read(row.output_path);
      return row.output_excerpt ?? undefined;
    },

    setSummary(sessionId, summary) {
      mustSession(sessionId);
      db.prepare("UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?").run(summary.trim() || null, now(), sessionId);
      emit({ type: "session", action: "updated", id: sessionId });
    },

    setStatus(sessionId, status) {
      mustSession(sessionId);
      db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), sessionId);
      emit({ type: "session", action: "updated", id: sessionId });
    },

    resume(sessionId, opts = {}) {
      const lastN = opts.lastN ?? 20;
      if (!Number.isInteger(lastN) || lastN < 0) throw new MemoryApiError("invalid", "lastN must be a non-negative integer");
      const session = toSession(mustSession(sessionId));
      const rows = (
        db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
          .all(sessionId, lastN) as MessageRow[]
      ).reverse();
      const out: ResumeContext = { session, messages: withToolCalls(rows) };
      if (session.summary !== undefined) out.summary = session.summary;
      return out;
    },

    vacuum() {
      db.exec("VACUUM");
    },

    // -- reads (contract) ------------------------------------------------------

    async listSessions(q) {
      const after = q.cursor === undefined ? undefined : decodeCursor<[number, string]>(q.cursor, 2);
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.projectId !== undefined) {
        where.push("s.project_id = ?");
        params.push(q.projectId);
      }
      const text = q.query?.trim();
      if (text) {
        const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push("(s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\')");
        params.push(like, like);
      }
      if (after) {
        where.push("(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))");
        params.push(after[0], after[0], after[1]);
      }
      const rows = db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`,
        )
        .all(...params, pageSize + 1) as SessionRow[];
      return pageOf(rows.map(toSession), pageSize, (last) => encodeCursor([last.updatedAt, last.id]));
    },

    async getSession(id, q): Promise<SessionDetail> {
      const session = toSession(mustSession(id));
      const after = q?.cursor === undefined ? undefined : decodeCursor<[number, number]>(q.cursor, 2);
      if (q?.latest) {
        // Newest page first; the cursor is the oldest message shown, and pages go back from there.
        const rows = db
          .prepare(
            `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ?
             ${after ? "AND (created_at < ? OR (created_at = ? AND rowid < ?))" : ""}
             ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(...(after ? [id, after[0], after[0], after[1]] : [id]), pageSize + 1) as MessageRow[];
        const hasMore = rows.length > pageSize;
        const pageRows = rows.slice(0, pageSize).reverse();
        const items = withToolCalls(pageRows);
        const first = pageRows[0];
        const messages: Page<Message> = hasMore && first ? { items, nextCursor: encodeCursor([first.created_at, first.rid]) } : { items };
        return { session, messages };
      }
      const rows = db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ?
           ${after ? "AND (created_at > ? OR (created_at = ? AND rowid > ?))" : ""}
           ORDER BY created_at, rowid LIMIT ?`,
        )
        .all(...(after ? [id, after[0], after[0], after[1]] : [id]), pageSize + 1) as MessageRow[];
      const hasMore = rows.length > pageSize;
      const pageRows = rows.slice(0, pageSize);
      const items = withToolCalls(pageRows);
      const last = pageRows.at(-1);
      const messages: Page<Message> = hasMore && last ? { items, nextCursor: encodeCursor([last.created_at, last.rid]) } : { items };
      return { session, messages };
    },

    async renameSession(id, title) {
      mustSession(id);
      const clean = title.trim();
      if (!clean) throw new MemoryApiError("invalid", "title must not be empty");
      db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(clean, now(), id);
      emit({ type: "session", action: "updated", id });
    },

    async deleteSession(id) {
      mustSession(id);
      deleteSessions([id]);
    },

    async searchMessages(q) {
      const match = ftsQuery(q.query);
      const offset = q.cursor === undefined ? 0 : decodeCursor<[number]>(q.cursor, 1)[0];
      const rows = db
        .prepare(
          `SELECT m.id AS messageId, m.session_id AS sessionId, m.created_at AS createdAt,
                  snippet(messages_fts, 0, '', '', '…', 16) AS snippet, bm25(messages_fts) AS rank
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
           ${q.projectId !== undefined ? "JOIN sessions s ON s.id = m.session_id" : ""}
           WHERE messages_fts MATCH ? ${q.projectId !== undefined ? "AND s.project_id = ?" : ""}
           ORDER BY rank, m.created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...(q.projectId !== undefined ? [match, q.projectId] : [match]), pageSize + 1, offset) as (Omit<
        MessageHit,
        "score"
      > & { rank: number })[];
      const hits: MessageHit[] = rows.map(({ rank, ...h }) => ({ ...h, score: -rank }));
      const items = hits.slice(0, pageSize);
      return hits.length > pageSize ? { items, nextCursor: encodeCursor([offset + pageSize]) } : { items };
    },

    searchScoped(q) {
      const match = ftsQuery(q.query);
      const rows = db
        .prepare(
          `SELECT m.id AS messageId, m.session_id AS sessionId, m.created_at AS createdAt,
                  snippet(messages_fts, 0, '', '', '…', 16) AS snippet, bm25(messages_fts) AS rank
           FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
           WHERE messages_fts MATCH ? AND ${q.projectId !== undefined ? "s.project_id = ?" : "s.project_id IS NULL"}
           ORDER BY rank, m.created_at DESC LIMIT ?`,
        )
        .all(...(q.projectId !== undefined ? [match, q.projectId] : [match]), q.limit ?? 8) as (Omit<MessageHit, "score"> & { rank: number })[];
      return rows.map(({ rank, ...h }) => ({ ...h, score: -rank }));
    },

    async clearHistory(q) {
      const ids = (
        q.projectId === undefined
          ? db.prepare("SELECT id FROM sessions").all()
          : db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(q.projectId)
      ) as { id: string }[];
      deleteSessions(ids.map((r) => r.id));
    },

    onChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pageOf<T>(rows: T[], size: number, cursorFor: (last: T) => string): Page<T> {
  if (rows.length <= size) return { items: rows };
  const items = rows.slice(0, size);
  return { items, nextCursor: cursorFor(items[items.length - 1]!) };
}

function encodeCursor(parts: unknown[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeCursor<T extends unknown[]>(cursor: string, length: number): T {
  try {
    const parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parts) && parts.length === length) return parts as T;
  } catch {
    // fall through
  }
  throw new MemoryApiError("invalid", "bad cursor");
}

/**
 * Turn free text into a safe FTS5 query: every word is quoted (so operators
 * and punctuation can't break the syntax), all words must match, and the last
 * word matches as a prefix for search-as-you-type.
 */
export function ftsQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length === 0) throw new MemoryApiError("invalid", "search query has no words");
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}
