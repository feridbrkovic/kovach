/**
 * Experience memory (MASTER_PLAN › Write path, "Verified fix"; Phase 4).
 *
 * Detection is mechanical: within one session, the same check or command
 * fails (exit != 0) and later passes, with edits in between. The failing
 * output's first error becomes the error signature. Only the wording
 * (problem, fix, a project-neutral lesson) comes from the model, as a
 * background job; without a model a plain summary is written instead.
 */
import type { Episode, MemoryChangeEvent } from "@kovach-dev/memory-contract";
import { MemoryApiError, type Page } from "@kovach-dev/memory-contract";
import type { Db } from "./db.js";
import type { JobContext, JobRunner } from "./jobs.js";
import { scanSecrets } from "./secrets.js";

/** One recorded tool call, oldest first. */
export interface RecordedCall {
  id: string;
  name: string;
  args?: unknown;
  command?: string | null;
  exitCode?: number | null;
  output?: string | null;
}

export type VerifiedBy = Episode["verifiedBy"];

/** A failing check or command that later passed, with what changed in between. */
export interface DetectedFix {
  /** Stable for one session: the check/command and the error signature. */
  key: string;
  command: string;
  verifiedBy: VerifiedBy;
  /** First error line, normalized. */
  errorSignature: string;
  /** The failing output (first one), clipped. */
  errorExcerpt: string;
  /** Files edited between the first failure and the pass. */
  files: string[];
  /** Edits in order, for the summary: path and short before/after excerpts. */
  edits: { path: string; change: string }[];
  /** Each failing run before the pass is a failed attempt; the pass is the last. */
  attempts: { approach: string; outcome: "failed" | "partial" | "passed" }[];
  failCallId: string;
  passCallId: string;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)[^/]*)$/i;
const ERROR_LINE = /\b(error|failed|failure|exception|cannot|can't|undefined is not|is not a function|not found|unexpected|expected|assert|panic|fatal)\b|TS\d{4}|✕|✗|×|FAIL\b|E\d{3,}/i;

/** The same normalization retrieval uses: paths, line/col numbers, hashes and timestamps stripped. */
export function normalizeSignature(text: string): string {
  return text
    .replace(ANSI, "")
    // Absolute and relative paths (C:\\x, /a/b.ts, src/a.ts, ./a.ts).
    .replace(/(?:[A-Za-z]:|\.{1,2}|[\w@-][\w.@-]*)?(?:[\\/][\w.@-]+)+(?:\.\w+)?/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "<time>")
    .replace(/[:(]\d+(?:[:,]\d+)?\)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Test-runner summary lines ("# fail 1", "Tests: 1 failed", "2 failing") say that something failed, not what. */
const SUMMARY = /^(#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b|(Tests?|Test Suites|Snapshots|Time|Ran all)\b.*:|\d+ (passing|failing|pending)\b|not ok \d+|ok \d+|1\.\.\d+|TAP version)/i;
/** Lines that name the error itself: these match across projects. */
const NAMED = /\b[A-Z][A-Za-z]*(Error|Exception)\b|\berror TS\d+|\bE[A-Z_]{3,}\b:|\bpanic:|Fatal error/;
/** Runner markers for a failing test (the test's own name follows). */
const MARKER = /^(✕|×|●|✗|FAIL\b)/;

/**
 * The line that best names the error, normalized and clipped: a runner's error
 * block (node:test/TAP "error:" with its name), else a line naming an error
 * type, else any error-looking line that isn't a summary, else the first line.
 */
export function errorSignatureOf(output: string): string {
  const lines = output.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Skip the command echo and package-manager banners.
  const useful = lines.filter((l) => !/^(>|\$|npm (ERR!|WARN)|ELIFECYCLE|pnpm|yarn run|Done in|error Command failed|at\s)/i.test(l));
  const pick = (): string => {
    for (let i = 0; i < useful.length; i++) {
      const m = /^error:\s*(.*)$/.exec(useful[i]!);
      if (!m) continue;
      let message = m[1]!.replace(/^['"]|['"]$/g, "");
      if (/^(\|-?|>-?)?$/.test(message)) message = useful[i + 1] ?? "";
      if (!message) continue;
      const name = useful.slice(i, i + 16).map((l) => /^name:\s*'?([A-Za-z]+(Error|Exception))'?/.exec(l)?.[1]).find(Boolean);
      return name && !message.startsWith(name) ? `${name}: ${message}` : message;
    }
    return (
      useful.find((l) => NAMED.test(l) && !SUMMARY.test(l)) ??
      useful.find((l) => MARKER.test(l) && !SUMMARY.test(l)) ??
      useful.find((l) => ERROR_LINE.test(l) && !SUMMARY.test(l)) ??
      useful.find((l) => !SUMMARY.test(l)) ??
      useful[0] ??
      ""
    );
  };
  return normalizeSignature(pick()).slice(0, 300);
}

/** run_checks output: "typecheck: `pnpm typecheck` FAILED (exit 2)\n<output>" sections (see describeChecks in the agent). */
export function parseChecksOutput(text: string): { kind: string; command: string; exitCode: number; output: string }[] {
  const out: { kind: string; command: string; exitCode: number; output: string }[] = [];
  const header = /^(typecheck|lint|test): `(.+)` (passed|FAILED \(exit (-?\d+)\)|not run \(declined\))\s*$/;
  let cur: (typeof out)[number] | undefined;
  for (const line of text.split("\n")) {
    const m = header.exec(line);
    if (m) {
      cur = { kind: m[1]!, command: m[2]!, exitCode: m[3] === "passed" ? 0 : m[4] !== undefined ? Number(m[4]) : -1, output: "" };
      out.push(cur);
      continue;
    }
    if (cur) cur.output += `${line}\n`;
  }
  return out.map((c) => ({ ...c, output: c.output.trim() }));
}

function verifiedByOf(command: string, kind?: string): VerifiedBy {
  if (kind === "test" || /\b(test|jest|vitest|mocha|pytest|phpunit|playwright)\b/i.test(command)) return "test";
  if (kind === "typecheck" || /\b(tsc|typecheck|type-check|mypy|phpstan)\b/i.test(command)) return "typecheck";
  if (/\bbuild\b/i.test(command)) return "build";
  return "run";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Find verified fixes in one session's tool calls. Deterministic. */
export function detectFixes(calls: RecordedCall[]): DetectedFix[] {
  type Run = { callId: string; key: string; command: string; kind?: string; exitCode: number; output: string };
  const runs: (Run | { edit: { path: string; change: string } })[] = [];
  for (const c of calls) {
    const args = (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown>;
    if (c.name === "edit_file" || c.name === "create_file") {
      const path = String(args.path ?? "");
      if (!path) continue;
      const change =
        c.name === "create_file"
          ? `created (${String(args.content ?? "").split("\n").length} lines)`
          : ((args.edits as { old?: string; new?: string }[] | undefined) ?? [])
              .map((e) => `- ${clip(String(e.old ?? "").trim(), 160)}\n+ ${clip(String(e.new ?? "").trim(), 160)}`)
              .join("\n");
      // Failed edits don't count as changes.
      if (c.exitCode !== undefined && c.exitCode !== null && c.exitCode !== 0) continue;
      runs.push({ edit: { path, change } });
      continue;
    }
    if (c.exitCode === undefined || c.exitCode === null || c.exitCode < 0) continue;
    if (c.name === "run_checks" && c.output) {
      for (const r of parseChecksOutput(c.output)) {
        if (r.exitCode < 0) continue;
        runs.push({ callId: c.id, key: `check:${r.command}`, command: r.command, kind: r.kind, exitCode: r.exitCode, output: r.output });
      }
      continue;
    }
    const raw = c.command ?? (typeof args.command === "string" ? args.command : undefined);
    if ((c.name === "check" || c.name === "run_command") && raw) {
      const command = raw.trim().replace(/\s+/g, " ");
      runs.push({ callId: c.id, key: `check:${command}`, command, exitCode: c.exitCode, output: c.output ?? "" });
    }
  }

  const open = new Map<string, { first: Run; failures: Run[]; edits: { path: string; change: string }[] }>();
  const fixes: DetectedFix[] = [];
  const pendingEdits: { path: string; change: string }[] = [];
  for (const r of runs) {
    if ("edit" in r) {
      for (const o of open.values()) o.edits.push(r.edit);
      pendingEdits.push(r.edit);
      continue;
    }
    const o = open.get(r.key);
    if (r.exitCode !== 0) {
      if (!o) open.set(r.key, { first: r, failures: [r], edits: [] });
      else o.failures.push(r);
      continue;
    }
    if (!o) continue;
    open.delete(r.key);
    if (o.edits.length === 0) continue; // passed without a change: flaky or environmental, not a fix
    const files = [...new Set(o.edits.map((e) => e.path))];
    const signature = errorSignatureOf(o.first.output);
    if (!signature) continue;
    fixes.push({
      key: `${r.key}|${signature}`,
      command: r.command,
      verifiedBy: verifiedByOf(r.command, r.kind ?? o.first.kind),
      errorSignature: signature,
      errorExcerpt: clip(o.first.output.replace(ANSI, ""), 3000),
      files,
      edits: o.edits.filter((e) => !SECRET_FILE.test(e.path)).slice(-12),
      attempts: [
        ...o.failures.slice(1).map((f) => ({ approach: `Still failing: ${clip(errorSignatureOf(f.output), 160)}`, outcome: "failed" as const })),
        { approach: `Changed ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`, outcome: "passed" as const },
      ],
      failCallId: o.first.callId,
      passCallId: r.callId,
    });
  }
  return fixes;
}

/** What the model writes about a fix. */
export interface FixSummary {
  problem: string;
  fixSummary: string;
  /** Project-neutral: no paths, names or code from this project. */
  lesson?: string;
}

export type Summarizer = (fix: DetectedFix, context: { task?: string; stack: string[] }, signal?: AbortSignal) => Promise<FixSummary>;

/** Without a model: a plain summary from the facts, and no lesson (lessons need judgement). */
export function plainSummary(fix: DetectedFix): FixSummary {
  return {
    problem: `\`${fix.command}\` failed: ${fix.errorSignature}`,
    fixSummary: `Fixed by changing ${fix.files.join(", ")}; \`${fix.command}\` passed afterwards.`,
  };
}

/** The prompt the summarizer job sends (exported for the desktop's model call). */
export function summaryPrompt(fix: DetectedFix, context: { task?: string; stack: string[] }): string {
  return [
    "A check failed and then passed after code changes. Describe the fix for a memory of solved problems.",
    "",
    context.task ? `Task: ${clip(context.task, 400)}` : "",
    context.stack.length ? `Stack: ${context.stack.join(", ")}` : "",
    `Command: ${fix.command}`,
    `Error (first failing output):\n${clip(fix.errorExcerpt, 1800)}`,
    `Changes:\n${fix.edits.map((e) => `${e.path}\n${e.change}`).join("\n\n").slice(0, 2400)}`,
    "",
    "Write JSON with:",
    '- "problem": one sentence, what was wrong (may name files).',
    '- "fixSummary": one or two sentences, what fixed it (may name files).',
    '- "lesson": one sentence another project could use: the general cause and fix. No file paths, project names, secrets or code from this project.',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

interface EpisodeRow {
  id: string;
  project_id: string | null;
  session_id: string | null;
  problem: string;
  error_signature: string | null;
  env_json: string;
  attempts_json: string;
  fix_summary: string;
  files_json: string;
  verified_by: VerifiedBy;
  lesson: string | null;
  status: Episode["status"];
  created_at: number;
}

export const episodeOf = (r: EpisodeRow): Episode => ({
  id: r.id,
  ...(r.project_id ? { projectId: r.project_id } : {}),
  ...(r.session_id ? { sessionId: r.session_id } : {}),
  problem: r.problem,
  ...(r.error_signature ? { errorSignature: r.error_signature } : {}),
  env: JSON.parse(r.env_json) as Record<string, string>,
  attempts: JSON.parse(r.attempts_json) as Episode["attempts"],
  fixSummary: r.fix_summary,
  files: JSON.parse(r.files_json) as string[],
  verifiedBy: r.verified_by,
  ...(r.lesson ? { lesson: r.lesson } : {}),
  status: r.status,
  createdAt: r.created_at,
});

/** Lessons cross projects, so anything that looks project-specific or secret is dropped from them. */
export function cleanLesson(lesson: string | undefined, fix: DetectedFix): string | undefined {
  if (!lesson) return undefined;
  const l = lesson.trim().replace(/\s+/g, " ");
  if (l.length < 12) return undefined;
  if (/(?:[\\/][\w.@-]+){2,}/.test(l)) return undefined; // a path
  if (fix.files.some((f) => l.includes(f) || l.includes(f.split("/").pop()!))) return undefined;
  if (scanSecrets(l).length) return undefined;
  return clip(l, 400);
}

export function createEpisodes(
  db: Db,
  deps: {
    now: () => number;
    newId: (prefix: string) => string;
    emit: (e: MemoryChangeEvent) => void;
    jobs: JobRunner;
    projectMode: (projectId: string | undefined) => "on" | "read_only" | "off";
    stack: (projectId: string | undefined) => { versions: Record<string, string>; labels: string[] };
    summarizer: () => Summarizer | undefined;
    /** Embed a new episode (memory_vec), best effort. */
    embed: (id: string, text: string) => Promise<void>;
    pageSize: number;
  },
) {
  const { now, newId, emit, jobs } = deps;

  const sessionCalls = (sessionId: string): RecordedCall[] =>
    (
      db
        .prepare(
          `SELECT tc.id, tc.name, tc.args_json, tc.command, tc.exit_code, tc.output_excerpt
           FROM tool_calls tc JOIN messages m ON m.id = tc.message_id
           WHERE m.session_id = ? ORDER BY m.created_at, m.rowid, tc.created_at, tc.rowid`,
        )
        .all(sessionId) as { id: string; name: string; args_json: string | null; command: string | null; exit_code: number | null; output_excerpt: string | null }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      args: r.args_json ? (JSON.parse(r.args_json) as unknown) : undefined,
      command: r.command,
      exitCode: r.exit_code,
      output: r.output_excerpt,
    }));

  const sessionInfo = (sessionId: string) =>
    db.prepare("SELECT project_id, title FROM sessions WHERE id = ?").get(sessionId) as { project_id: string | null; title: string | null } | undefined;

  /**
   * Look for verified fixes in a finished run and queue a summary for each new
   * one. Read-only and off projects contribute nothing (decision 3).
   */
  const learnFromSession = (sessionId: string): number => {
    const s = sessionInfo(sessionId);
    if (!s) return 0;
    const projectId = s.project_id ?? undefined;
    if (deps.projectMode(projectId) !== "on") return 0;
    const known = new Set(
      (db.prepare("SELECT error_signature FROM episodes WHERE session_id = ?").all(sessionId) as { error_signature: string | null }[]).map((r) => r.error_signature),
    );
    const queued = new Set(
      jobs
        .pending()
        .filter((j) => j.kind === "extraction" && j.payload.type !== "memories" && j.payload.sessionId === sessionId)
        .map((j) => String(j.payload.signature)),
    );
    let n = 0;
    for (const fix of detectFixes(sessionCalls(sessionId))) {
      if (known.has(fix.errorSignature) || queued.has(fix.errorSignature)) continue;
      // Secrets in the error itself: nothing about this fix is kept.
      if (scanSecrets(`${fix.errorSignature}\n${fix.errorExcerpt}`).length) continue;
      jobs.enqueue("extraction", { type: "fix", sessionId, signature: fix.errorSignature });
      queued.add(fix.errorSignature);
      n++;
    }
    return n;
  };

  /** Job handler: summarize one detected fix (the store routes "extraction" jobs here or to memory extraction). */
  const handleFixJob = async (payload: Record<string, unknown>, ctx: JobContext): Promise<void> => {
    const sessionId = String(payload.sessionId);
    const s = sessionInfo(sessionId);
    if (!s) return;
    const projectId = s.project_id ?? undefined;
    if (deps.projectMode(projectId) !== "on") return;
    const fix = detectFixes(sessionCalls(sessionId)).find((f) => f.errorSignature === payload.signature);
    if (!fix) return;
    if (db.prepare("SELECT 1 FROM episodes WHERE session_id = ? AND error_signature = ?").get(sessionId, fix.errorSignature)) return;
    const stack = deps.stack(projectId);
    ctx.progress("Summarizing a fix");
    let summary = plainSummary(fix);
    const summarize = deps.summarizer();
    if (summarize) {
      try {
        const s2 = await summarize(fix, { ...(s.title ? { task: s.title } : {}), stack: stack.labels }, ctx.signal);
        if (s2.problem?.trim() && s2.fixSummary?.trim()) summary = { problem: s2.problem.trim(), fixSummary: s2.fixSummary.trim(), ...(s2.lesson ? { lesson: s2.lesson } : {}) };
      } catch {
        // the plain summary stands
      }
    }
    await ctx.checkpoint();
    const lesson = cleanLesson(summary.lesson, fix);
    if (scanSecrets(`${summary.problem}\n${summary.fixSummary}`).length) return; // any hit drops the episode
    const id = newId("ep");
    // Only the libraries that matter, so other projects can compare versions.
    const env = Object.fromEntries(Object.entries(stack.versions).slice(0, 12));
    db.prepare(
      `INSERT INTO episodes (id, project_id, session_id, problem, error_signature, env_json, attempts_json, fix_summary, files_json, verified_by, lesson, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      id,
      projectId ?? null,
      sessionId,
      summary.problem,
      fix.errorSignature,
      JSON.stringify(env),
      JSON.stringify(fix.attempts),
      summary.fixSummary,
      JSON.stringify(fix.files),
      fix.verifiedBy,
      lesson ?? null,
      now(),
    );
    db.prepare("INSERT INTO memory_events (episode_id, action, actor, session_id, at) VALUES (?, 'created', 'system', ?, ?)").run(id, sessionId, now());
    emit({ type: "episode", action: "created", id });
    await deps.embed(id, `${summary.problem}\n${fix.errorSignature}\n${summary.fixSummary}\n${lesson ?? ""}`).catch(() => undefined);
  };

  const row = (id: string) => db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as EpisodeRow | undefined;

  return {
    handleFixJob,
    learnFromSession,
    detectInSession: (sessionId: string) => detectFixes(sessionCalls(sessionId)),

    listEpisodes(q: { projectId?: string; query?: string; cursor?: string }): Page<Episode> {
      const where = ["status != 'rejected'"];
      const args: unknown[] = [];
      if (q.projectId !== undefined) {
        where.push("project_id = ?");
        args.push(q.projectId);
      }
      if (q.query?.trim()) {
        where.push("(lower(problem) LIKE ? OR lower(fix_summary) LIKE ? OR lower(coalesce(lesson, '')) LIKE ? OR lower(coalesce(error_signature, '')) LIKE ?)");
        const like = `%${q.query.trim().toLowerCase()}%`;
        args.push(like, like, like, like);
      }
      const offset = q.cursor ? Number.parseInt(q.cursor, 10) || 0 : 0;
      const rows = db
        .prepare(`SELECT * FROM episodes WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
        .all(...args, deps.pageSize + 1, offset) as EpisodeRow[];
      const items = rows.slice(0, deps.pageSize).map(episodeOf);
      return rows.length > deps.pageSize ? { items, nextCursor: String(offset + deps.pageSize) } : { items };
    },

    getEpisode(id: string): Episode {
      const r = row(id);
      if (!r) throw new MemoryApiError("not_found", `episode ${id} not found`);
      return episodeOf(r);
    },

    deleteEpisode(id: string): void {
      if (!row(id)) throw new MemoryApiError("not_found", `episode ${id} not found`);
      db.transaction(() => {
        db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
        db.prepare("INSERT INTO memory_events (episode_id, action, actor, at) VALUES (?, 'deleted', 'user', ?)").run(id, now());
      })();
      emit({ type: "episode", action: "deleted", id });
    },
  };
}

export type EpisodeStore = ReturnType<typeof createEpisodes>;
