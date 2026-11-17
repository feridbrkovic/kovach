/**
 * Self-review (MASTER_PLAN › Agent quality, item 6): before a run that changed
 * files finishes, a fresh-context pass looks at only the task, the diff and the
 * check results, and returns the problems it finds as strict JSON. It never saw
 * the agent's reasoning, so it isn't anchored by it. "must_fix" findings go back
 * to the agent to fix or justify; suggestions are only shown.
 */

import type { ChatMessage, ChatModel } from "./model.js";

export interface ReviewIssue {
  file: string;
  line?: number;
  severity: "must_fix" | "suggestion";
  problem: string;
  fix?: string;
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: ["must_fix", "suggestion"] },
          problem: { type: "string" },
          fix: { type: "string" },
        },
        required: ["file", "severity", "problem"],
      },
    },
  },
  required: ["issues"],
} as const;

export const REVIEW_SYSTEM = `You review a code change someone else made. You see only the task, the diff and the results of the project's checks.
Report real problems only:
- a bug, or a case the change gets wrong (empty input, null, off-by-one, wrong units, async mistakes);
- the task not done, or done only in part;
- security: secrets in code, injection, unescaped output, unsafe file or shell use;
- leftovers: debug output, commented-out code, TODOs the task should have finished;
- changes unrelated to the task.
Don't report style or naming preferences, missing comments, or anything the checks already prove. Don't invent problems: an empty list is the usual answer for a good change.
Each diff line starts with its line number in the new file (blank for removed lines); use that number for "line". If the diff says it was clipped, the rest of the change exists but isn't shown: never report something as missing because you didn't see it.
severity must_fix: it is wrong or incomplete and should be fixed before finishing. suggestion: worth knowing, not blocking.
Answer with JSON: {"issues": [{"file", "line", "severity", "problem", "fix"}]}.`;

/** The longest diff the reviewer reads (about 12k tokens); larger changes are clipped. */
const MAX_DIFF_CHARS = 48_000;

/**
 * Put each line's number in the new file in front of it, so the reviewer cites lines it
 * can see instead of counting them. Removed lines get a blank number; headers stay as they are.
 */
export function numberDiff(diff: string): string {
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = diff.split("\n");
  const width = String(lines.length).length + 1;
  const pad = (s: string) => s.padStart(width);
  return lines
    .map((line) => {
      if (oldLeft > 0 || newLeft > 0) {
        // Inside a hunk: its header said how many old and new lines follow.
        if (line.startsWith("-")) {
          oldLeft--;
          return `${pad("")} | ${line}`;
        }
        if (line.startsWith("+")) {
          newLeft--;
          return `${pad(String(next++))} | ${line}`;
        }
        if (line.startsWith(" ") || line === "") {
          oldLeft--;
          newLeft--;
          return `${pad(String(next++))} | ${line}`;
        }
        return line; // "\ No newline at end of file"
      }
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        next = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
      return line;
    })
    .join("\n");
}

export function reviewMessages(input: { task: string; diff: string; checks: string }): ChatMessage[] {
  const numbered = numberDiff(input.diff);
  const diff =
    numbered.length > MAX_DIFF_CHARS
      ? `${numbered.slice(0, numbered.lastIndexOf("\n", MAX_DIFF_CHARS))}\n[diff clipped: ${numbered.length - MAX_DIFF_CHARS} more characters of the change are not shown]`
      : numbered;
  return [
    { role: "system", content: REVIEW_SYSTEM },
    { role: "user", content: `Task:\n${input.task.trim()}\n\nDiff:\n${diff}\nChecks:\n${input.checks.trim() || "none run"}` },
  ];
}

/** Parse the reviewer's JSON, keeping well-formed issues only. */
export function parseReview(raw: string): ReviewIssue[] | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const list = (data as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return undefined;
  const out: ReviewIssue[] = [];
  for (const x of list.slice(0, 8)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.file !== "string" || typeof o.problem !== "string" || !o.problem.trim()) continue;
    if (o.severity !== "must_fix" && o.severity !== "suggestion") continue;
    out.push({
      file: o.file,
      ...(typeof o.line === "number" && Number.isInteger(o.line) && o.line > 0 ? { line: o.line } : {}),
      severity: o.severity,
      problem: o.problem.trim(),
      ...(typeof o.fix === "string" && o.fix.trim() ? { fix: o.fix.trim() } : {}),
    });
  }
  return out;
}

/** Run the review. Undefined when the reviewer failed or answered off-schema (the run then just finishes). */
export async function reviewChange(
  model: ChatModel,
  input: { task: string; diff: string; checks: string },
  signal?: AbortSignal,
): Promise<ReviewIssue[] | undefined> {
  try {
    const res = await model.complete({
      messages: reviewMessages(input),
      jsonSchema: { name: "code_review", schema: REVIEW_SCHEMA as unknown as Record<string, unknown> },
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    return parseReview(res.content);
  } catch (err) {
    if (signal?.aborted) throw err;
    return undefined;
  }
}

export const formatIssue = (i: ReviewIssue) => `${i.file}${i.line ? `:${i.line}` : ""}: ${i.problem}${i.fix ? ` Fix: ${i.fix}` : ""}`;

/** What the agent is told when the review found something to fix. */
export function reviewNudge(issues: ReviewIssue[]): string {
  const must = issues.filter((i) => i.severity === "must_fix");
  return `A review of your change (by a reviewer who saw only the task, the diff and the checks) found:\n${must.map((i, n) => `${n + 1}. ${formatIssue(i)}`).join("\n")}\n\nFix each one, or, if a finding is wrong, say why in one sentence. Then finish with your summary.`;
}
