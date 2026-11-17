/**
 * Inferred memory (MASTER_PLAN › Write path, "Extraction job"; Phase 5).
 *
 * After a session is done (or idle), the local model reads a compact,
 * redacted transcript and proposes at most 5 things worth remembering, each
 * with evidence. Deterministic gates decide what survives: secrets, evidence,
 * duplicates, supersession and conflicts. Survivors wait in the review inbox;
 * nothing inferred is used until the user accepts it (or it recurs in two
 * separate sessions and the user allowed auto-accept).
 */
import type { Db } from "./db.js";
import { redactSecrets, scanSecrets } from "./secrets.js";

export const EXTRACTED_KINDS = ["preference", "decision", "convention", "open_issue", "research"] as const;

export interface ExtractedCandidate {
  kind: (typeof EXTRACTED_KINDS)[number];
  scope: "global" | "project";
  key: string;
  body: string;
  evidence: string[];
  appliesTo?: Record<string, string>;
}

/** Strict check of one candidate from the model; anything off-shape is dropped. */
function asCandidate(v: unknown): ExtractedCandidate | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!EXTRACTED_KINDS.includes(o.kind as ExtractedCandidate["kind"])) return undefined;
  if (o.scope !== "global" && o.scope !== "project") return undefined;
  if (typeof o.key !== "string" || !o.key.trim() || o.key.length > 80) return undefined;
  if (typeof o.body !== "string" || !o.body.trim() || o.body.length > 400) return undefined;
  if (!Array.isArray(o.evidence) || o.evidence.length > 8 || !o.evidence.every((e) => typeof e === "string")) return undefined;
  let appliesTo: Record<string, string> | undefined;
  if (o.appliesTo !== undefined) {
    if (!o.appliesTo || typeof o.appliesTo !== "object" || Array.isArray(o.appliesTo)) return undefined;
    const entries = Object.entries(o.appliesTo as Record<string, unknown>);
    if (!entries.every(([, x]) => typeof x === "string")) return undefined;
    if (entries.length) appliesTo = Object.fromEntries(entries) as Record<string, string>;
  }
  return {
    kind: o.kind as ExtractedCandidate["kind"],
    scope: o.scope,
    key: o.key.trim(),
    body: o.body.trim(),
    evidence: o.evidence as string[],
    ...(appliesTo ? { appliesTo } : {}),
  };
}

/** JSON schema for the model's structured output (mirrors ExtractionOutput). */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...EXTRACTED_KINDS] },
          scope: { type: "string", enum: ["global", "project"] },
          key: { type: "string" },
          body: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          appliesTo: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["kind", "scope", "key", "body", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false,
} as const;

/** Sends the prompt to the local model and returns its raw JSON text. */
export type Extractor = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface TranscriptRef {
  /** Real id: a message id or a tool call id. */
  id: string;
  type: "user" | "assistant" | "tool";
  /** For tool refs: the tool's name and, for web tools, the URL or query. */
  tool?: string;
  url?: string;
  title?: string;
  output?: string;
  /** For user messages: what they said (redacted), to check how it was phrased. */
  text?: string;
}

/**
 * Words that mark a standing wish rather than an instruction for the task at hand
 * ("always", "never", "I prefer", "from now on"), in English and Bosnian/Croatian/Serbian.
 * A preference meant for every project has to be said like one.
 */
export const STANDING =
  /\b(always|never|prefer(s|red)?|from now on|going forward|by default|in general|generally|every (time|project)|all (my |of my )?projects|each time|whenever|i (like|want|hate|don'?t like|don'?t want)|remember|uvijek|uvek|nikad(a)?|preferiram|volim|ne volim|ubuduće|ubuduce|od sada|svaki put|u svim projektima|zapamti)\b/i;

export interface Transcript {
  text: string;
  /** Short alias the model cites (m1, t2) → what it refers to. */
  refs: Map<string, TranscriptRef>;
  /** Newest message time included. */
  upTo: number;
}

const MAX_CHARS = 24_000; // about 6k tokens
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/**
 * The compact transcript (plan step 2): user messages, the assistant's text
 * replies, and tool calls reduced to command + exit code + first error.
 * Everything goes through the secret redactor first.
 */
export function buildTranscript(db: Db, sessionId: string, since: number): Transcript {
  const msgs = db
    .prepare("SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND created_at > ? ORDER BY created_at, rowid")
    .all(sessionId, since) as { id: string; role: string; content: string; created_at: number }[];
  const calls = db
    .prepare(
      `SELECT tc.id, tc.message_id, tc.name, tc.args_json, tc.command, tc.exit_code, tc.output_excerpt
       FROM tool_calls tc JOIN messages m ON m.id = tc.message_id WHERE m.session_id = ? AND m.created_at > ? ORDER BY tc.created_at, tc.rowid`,
    )
    .all(sessionId, since) as {
    id: string;
    message_id: string;
    name: string;
    args_json: string | null;
    command: string | null;
    exit_code: number | null;
    output_excerpt: string | null;
  }[];
  const byMessage = new Map<string, typeof calls>();
  for (const c of calls) byMessage.set(c.message_id, [...(byMessage.get(c.message_id) ?? []), c]);

  const refs = new Map<string, TranscriptRef>();
  const lines: string[] = [];
  let m = 0;
  let t = 0;
  for (const msg of msgs) {
    if (msg.role === "user" && msg.content.trim()) {
      const alias = `m${++m}`;
      const said = clip(redactSecrets(msg.content.trim()), 1500);
      refs.set(alias, { id: msg.id, type: "user", text: said });
      lines.push(`[${alias}] USER: ${said}`);
    } else if (msg.role === "assistant" && msg.content.trim()) {
      const alias = `m${++m}`;
      refs.set(alias, { id: msg.id, type: "assistant" });
      lines.push(`[${alias}] ASSISTANT: ${clip(redactSecrets(msg.content.trim()), 700)}`);
    }
    for (const c of byMessage.get(msg.id) ?? []) {
      const args = c.args_json ? (JSON.parse(c.args_json) as Record<string, unknown>) : {};
      const alias = `t${++t}`;
      const out = c.output_excerpt ?? "";
      if (c.name === "fetch_page" || c.name === "web_search") {
        const url = typeof args.url === "string" ? args.url : undefined;
        const query = typeof args.query === "string" ? args.query : undefined;
        refs.set(alias, { id: c.id, type: "tool", tool: c.name, ...(url ? { url } : {}), title: firstLine(out).slice(0, 160), output: out });
        // Fetched pages are the evidence for research findings, so a short excerpt goes in.
        lines.push(`[${alias}] TOOL ${c.name} ${url ?? `"${query ?? ""}"`}: ${clip(redactSecrets(out.replace(/\s+/g, " ")), c.name === "fetch_page" ? 1200 : 400)}`);
        continue;
      }
      refs.set(alias, { id: c.id, type: "tool", tool: c.name });
      const what = c.command ?? (typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "");
      const failed = c.exit_code !== null && c.exit_code !== 0;
      lines.push(`[${alias}] TOOL ${c.name}${what ? ` ${clip(what, 160)}` : ""}${c.exit_code !== null ? ` → exit ${c.exit_code}` : ""}${failed && out ? `: ${clip(redactSecrets(firstLine(out)), 200)}` : ""}`);
    }
  }
  // Keep the first user message (the task) and the most recent lines within the cap.
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) {
    const head = lines[0] ?? "";
    const tail: string[] = [];
    let size = head.length;
    for (let i = lines.length - 1; i > 0 && size + lines[i]!.length + 1 < MAX_CHARS - 40; i--) {
      tail.unshift(lines[i]!);
      size += lines[i]!.length + 1;
    }
    text = [head, "… (earlier part of the session left out) …", ...tail].join("\n");
  }
  return { text, refs, upTo: msgs.at(-1)?.created_at ?? since };
}

/**
 * Extraction is a judgment that should come out the same every time: sample greedily.
 * With the server's default sampling, the same session gave different proposals run to run.
 */
export const EXTRACTION_TEMPERATURE = 0;

/** System message for the extraction model, shared by the app and the eval runner. */
export const EXTRACTION_SYSTEM =
  "You decide what an assistant should remember about a user and their project. Be strict: most sessions have nothing worth remembering. Answer with JSON only.";

export function extractionPrompt(transcript: Transcript, ctx: { project?: string; stack: string[] }): string {
  return [
    "Read this coding session and propose what is worth remembering for FUTURE sessions with this user.",
    ctx.project ? `Project: ${ctx.project}${ctx.stack.length ? ` (${ctx.stack.join(", ")})` : ""}.` : "No project (a general chat).",
    "",
    "Propose only durable facts, at most 5, often none:",
    "- preference: how the user wants things done in general (scope global) or in this project (scope project). Must come from something the USER said.",
    '- decision: a choice for this project that will matter again, often said with its reason ("we stay on MySQL, no second database", "payments only through the hosted page"). Scope project. Must come from something the USER said or agreed to.',
    "- convention: a rule for how code is written in this project (scope project). Must come from the USER.",
    '- open_issue: a problem the USER says is still unresolved or is deliberately left for later ("the export still times out on big shops", "skip the iPad layout for now"). Scope project. Never the work requested or done in this session.',
    "- research: a fact read on a fetched web page (cite the fetch_page tool line). Always kind research, even when the user asked the question. Add appliesTo {library: version} if it is about one version.",
    "",
    'Do NOT propose: what only the assistant suggested, details of this one task, what was built or changed in this session ("added a settings screen", "the form needs a date field"), anything temporary, secrets, keys, passwords, tokens or personal data.',
    'An instruction for the job at hand is not a preference: "run the tests", "fix the cart", "don\'t change files" describe this task only. A preference is said as a standing wish ("always…", "never…", "I prefer…", "from now on…", "in this project…").',
    'key: a short dotted subject, e.g. "style.semicolons", "state.library", "api.retries". body: one plain sentence.',
    "evidence: the bracketed ids of the lines that show it, e.g. [\"m3\"] or [\"t2\"].",
    'Answer with JSON: {"candidates": [...]}. If nothing qualifies, {"candidates": []}.',
    "",
    "Session:",
    transcript.text,
  ].join("\n");
}

/** Parse the model's answer, tolerating text around the JSON. Off-shape candidates are dropped; at most 5 are kept. */
export function parseExtraction(raw: string): ExtractedCandidate[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates
      .map(asCandidate)
      .filter((c): c is ExtractedCandidate => !!c)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export type GateResult =
  | { ok: true; candidate: ExtractedCandidate; evidence: { type: "message" | "tool_call" | "source"; id: string }[]; sources: TranscriptRef[] }
  | { ok: false; reason: "secret" | "evidence" | "scope" };

/**
 * Gates 1–2 (secret scan, evidence) and scope rules. Duplicates, supersession
 * and conflicts need the database and are decided by the store.
 */
export function gate(c: ExtractedCandidate, refs: Map<string, TranscriptRef>, hasProject: boolean): GateResult {
  if (scanSecrets([c.key, c.body, JSON.stringify(c.appliesTo ?? {})].join("\n")).length) return { ok: false, reason: "secret" };
  const cited = c.evidence.map((e) => refs.get(e.replace(/[[\]\s]/g, ""))).filter((r): r is TranscriptRef => !!r);
  const userCited = cited.filter((r) => r.type === "user");
  const webCited = cited.filter((r) => r.type === "tool" && (r.tool === "fetch_page" || r.tool === "web_search") && r.url);
  // Preferences, decisions and conventions must come from the user, not the assistant.
  if ((c.kind === "preference" || c.kind === "decision" || c.kind === "convention") && userCited.length === 0) return { ok: false, reason: "evidence" };
  // Research must point at a page that was actually fetched.
  if (c.kind === "research" && webCited.length === 0) return { ok: false, reason: "evidence" };
  if (cited.length === 0) return { ok: false, reason: "evidence" };
  // Without a project only general preferences make sense.
  if (!hasProject && !(c.kind === "preference" || c.kind === "research")) return { ok: false, reason: "scope" };
  const candidate: ExtractedCandidate = { ...c, scope: hasProject ? c.scope : "global" };
  if (candidate.kind !== "preference" && candidate.kind !== "research" && candidate.scope === "global") candidate.scope = "project";
  // A preference for every project must be said as one, not read into a task instruction ("run the tests"):
  // otherwise it stays with the project it was said in, or is dropped when there is none.
  if (candidate.kind === "preference" && candidate.scope === "global" && !userCited.some((r) => STANDING.test(r.text ?? ""))) {
    if (!hasProject) return { ok: false, reason: "scope" };
    candidate.scope = "project";
  }
  return {
    ok: true,
    candidate,
    evidence: cited.map((r) => ({ type: r.type === "tool" ? ("tool_call" as const) : ("message" as const), id: r.id })),
    sources: webCited,
  };
}

/** Significant words of a sentence, for checking a research claim against its page. */
export function claimTerms(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "use", "uses", "not", "can", "has", "have", "you", "your", "its", "when", "into", "than", "then", "will", "should", "must", "only", "also"]);
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_.-]+/gu) ?? []).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w.length > 2 && !stop.has(w)))];
}

/** Share of a claim's terms still found on its page (0–1). */
export function claimSupport(claim: string, page: string): number {
  const terms = claimTerms(claim);
  if (terms.length === 0) return 1;
  const hay = page.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length / terms.length;
}
