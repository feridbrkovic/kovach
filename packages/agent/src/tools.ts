import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Check } from "./checks.js";
import { CODE_TOOLS } from "./code-intel/tools.js";
import { applyEdits } from "./edits.js";
import type { ImagePart, ToolSpec } from "./model.js";
import { appKitTool } from "./app-kit.js";
import { designKitTool } from "./page-builder.js";
import { clip, focusClip, runCommand } from "./shell.js";
import type { Workspace } from "./workspace.js";

/**
 * What the user is asked to allow. `command` is a shell command or, for the other
 * kinds, a one-line description of the action ("click at 640, 220 (Save button)").
 */
export type ApprovalRequest = {
  kind: "command" | "check" | "computer" | "web" | "media" | "memory";
  command: string;
  cwd: string;
};
/** Ask the user before a command runs. Resolve true to allow. */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export interface CheckRun {
  check: Check;
  exitCode: number;
  output: string;
  durationMs: number;
  /** Not run because the user declined. */
  declined?: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  approve: Approver;
  checks: Check[];
  limits: { editLines: number; newFileLines: number; commandTimeoutMs: number };
  signal?: AbortSignal;
  /** Files this run created (project-relative). Those can be replaced whole: nothing of the user's is lost. */
  createdThisRun?: Set<string>;
}

/** What a tool returns: text for the model, plus details the history keeps. */
export interface ToolOutcome {
  /** Sent back to the model. */
  content: string;
  ok: boolean;
  /** For history: the command that ran and its result. */
  command?: string;
  exitCode?: number;
  /** Full output for history (the model gets a clipped version in `content`). */
  output?: string;
  durationMs?: number;
  /** The tool changed a file. */
  edited?: boolean;
  /** run_checks results. */
  checkRuns?: CheckRun[];
  /** Images for the model to look at next (a screenshot, a generated picture). */
  images?: ImagePart[];
  /** Files the tool wrote that the user may want to open (absolute paths). */
  files?: string[];
  /** A project file this tool changed, with its content before the change (null: it didn't exist). */
  change?: { path: string; before: string | null };
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

const tool = <S extends z.ZodType>(t: AgentTool<S>): AgentTool => t as unknown as AgentTool;

const MAX_READ_LINES = 400;

/**
 * A file's lines as read_file numbers them. A final newline ends the last line rather than
 * starting an empty one, so every tool agrees on how many lines a file has.
 */
export function fileLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export async function runChecks(ctx: ToolContext): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const check of ctx.checks) {
    if (!(await ctx.approve({ kind: "check", command: check.command, cwd: ctx.workspace.root }))) {
      runs.push({ check, exitCode: -1, output: "declined by the user", durationMs: 0, declined: true });
      continue;
    }
    const r = await runCommand(check.command, {
      cwd: ctx.workspace.root,
      timeoutMs: ctx.limits.commandTimeoutMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    runs.push({ check, exitCode: r.exitCode, output: r.output, durationMs: r.durationMs });
  }
  return runs;
}

export function describeChecks(runs: CheckRun[]): string {
  if (runs.length === 0) return "No checks found for this project (no typecheck, lint or test script).";
  return runs
    .map((r) => {
      const status = r.declined ? "not run (declined)" : r.exitCode === 0 ? "passed" : `FAILED (exit ${r.exitCode})`;
      const body = r.exitCode === 0 || r.declined ? "" : `\n${focusClip(r.output, 4000)}`;
      return `${r.check.kind}: \`${r.check.command}\` ${status}${body}`;
    })
    .join("\n\n");
}

export const allChecksPassed = (runs: CheckRun[]) => runs.every((r) => !r.declined && r.exitCode === 0);

export const TOOLS: AgentTool[] = [
  tool({
    name: "list_files",
    description: "List project files (respects .gitignore). Optionally only paths containing `filter`.",
    schema: z.object({ filter: z.string().optional().describe("Substring the path must contain, e.g. 'src/' or '.test.'") }),
    async run({ filter }, { workspace }) {
      const files = (await workspace.listFiles(5000)).filter((f) => !filter || f.includes(filter));
      const shown = files.slice(0, 300);
      const more = files.length > shown.length ? `\n… and ${files.length - shown.length} more; narrow with filter` : "";
      return { ok: true, content: shown.length ? shown.join("\n") + more : "No files match." };
    },
  }),

  tool({
    name: "read_file",
    description: `Read a file with line numbers. Reads at most ${MAX_READ_LINES} lines per call; use startLine/endLine for long files.`,
    schema: z.object({
      path: z.string().describe("Path relative to the project root"),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    async run({ path, startLine, endLine }, { workspace }) {
      const lines = fileLines(workspace.readText(path));
      const from = startLine ?? 1;
      const to = Math.min(endLine ?? from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1, lines.length);
      if (lines.length === 0) return { ok: true, content: `${path} is empty.` };
      if (from > lines.length) return { ok: false, content: `${path} has only ${lines.length} lines.` };
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}| ${l}`)
        .join("\n");
      const note = to < lines.length ? `\n[lines ${from}-${to} of ${lines.length}]` : "";
      return { ok: true, content: body + note };
    },
  }),

  tool({
    name: "search",
    description:
      "Search project files for text with a regular expression (ripgrep syntax). Returns path:line: text. For where a function, class or method is defined or used, find_symbol and find_references are exact; use search for strings, config keys and comments.",
    schema: z.object({
      pattern: z.string().min(1),
      glob: z.string().optional().describe("Limit to files matching this glob, e.g. '*.ts' or 'src/**'"),
    }),
    async run({ pattern, glob }, { workspace }) {
      const hits = await workspace.search(pattern, glob ? { glob } : {});
      // A bare identifier is usually a symbol: point at the tools that tell same-named ones apart.
      const symbolHint = /^[A-Za-z_$][\w$]*$/.test(pattern)
        ? `\n\nThis is a text match. For ${pattern} as a symbol, find_symbol gives its definitions and find_references the uses of each one exactly.`
        : "";
      if (hits.length === 0) return { ok: true, content: `No matches.${symbolHint}` };
      return { ok: true, content: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n") + symbolHint };
    },
  }),

  tool({
    name: "edit_file",
    description:
      "Change an existing file with exact search/replace blocks. Each `old` must match the file exactly once (copy it from read_file without the line numbers). All blocks apply or none do. Keep each call small.",
    schema: z.object({
      path: z.string(),
      edits: z.array(z.object({ old: z.string(), new: z.string() })).min(1),
    }),
    async run({ path, edits }, ctx) {
      const before = ctx.workspace.readText(path);
      const result = applyEdits(before, edits);
      if (!result.ok) return { ok: false, content: `Edit not applied: ${result.error}` };
      if (result.changedLines > ctx.limits.editLines) {
        return {
          ok: false,
          content: `Edit not applied: it changes about ${result.changedLines} existing lines; the limit per step is ${ctx.limits.editLines}. Split it into smaller steps and run checks between them. (Adding new lines next to an unchanged line doesn't count toward this limit: keep "old" whole at the start or end of "new".)`,
        };
      }
      if (result.addedLines > ctx.limits.newFileLines) {
        return {
          ok: false,
          content: `Edit not applied: it adds ${result.addedLines} new lines; the limit for new content per step is ${ctx.limits.newFileLines}. Add it in parts, one edit_file call each.`,
        };
      }
      writeFileSync(ctx.workspace.resolve(path), result.content, "utf8");
      const change = { path: ctx.workspace.rel(ctx.workspace.resolve(path)), before };
      const parts = [
        result.changedLines ? `${result.changedLines} line${result.changedLines === 1 ? "" : "s"} changed` : "",
        result.addedLines ? `${result.addedLines} line${result.addedLines === 1 ? "" : "s"} added` : "",
      ].filter(Boolean);
      return { ok: true, edited: true, change, content: `Edited ${path} (${parts.join(", ")}).` };
    },
  }),

  tool({
    name: "create_file",
    description: "Create a new file. Fails if the file already exists (use edit_file for changes), except for a file you created earlier in this task, which it replaces.",
    schema: z.object({ path: z.string(), content: z.string() }),
    async run({ path, content }, ctx) {
      const abs = ctx.workspace.resolve(path);
      const rel = ctx.workspace.rel(abs);
      const replacing = existsSync(abs);
      if (replacing && !ctx.createdThisRun?.has(rel)) {
        return { ok: false, content: `${path} already exists and wasn't created in this task, so it can't be replaced whole. Change it with edit_file (small "old" blocks) or add to it with insert_lines.` };
      }
      const previous = replacing ? ctx.workspace.readText(path) : null;
      const lines = fileLines(content).length;
      // The step size is a target, not a reason to throw away a file the model has already
      // written in full (minutes of generation on a local model): up to five times the target
      // is created with a note; beyond that, refused.
      const hardLimit = ctx.limits.newFileLines * 5;
      if (lines > hardLimit) {
        return {
          ok: false,
          content: `Not created: ${lines} lines is over the ${hardLimit}-line limit for one step (aim for ${ctx.limits.newFileLines}). Create the first part, then add the rest with insert_lines after the file's last line.`,
        };
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      const note =
        lines > ctx.limits.newFileLines
          ? ` That is over the ${ctx.limits.newFileLines}-line step size: check it with diagnostics before going on, and keep the next steps smaller.`
          : "";
      ctx.createdThisRun?.add(rel);
      return { ok: true, edited: true, change: { path: rel, before: previous }, content: `${replacing ? "Replaced" : "Created"} ${path} (${lines} lines).${note}` };
    },
  }),

  designKitTool(),
  appKitTool(),

  tool({
    name: "insert_lines",
    description:
      'Insert new lines into an existing file after a line number from read_file (0 = at the start). Best for adding a new section or appending to the end, where edit_file\'s "old" text would repeat (closing tags, braces). Existing lines are left as they are.',
    schema: z.object({
      path: z.string(),
      afterLine: z.number().int().min(0).describe("Insert after this line (from read_file); the file's last line number appends at the end"),
      content: z.string().min(1),
    }),
    async run({ path, afterLine, content }, ctx) {
      const before = ctx.workspace.readText(path);
      const lines = before.split("\n");
      const count = fileLines(before).length;
      // Older read_file output numbered the empty "line" after a final newline; one past the
      // end still means "append", which is what the model wants.
      if (afterLine === count + 1) afterLine = count;
      if (afterLine > count) {
        return { ok: false, content: `${path} has ${count} lines; afterLine must be 0–${count} (${count} appends at the end).` };
      }
      const added = content.replace(/\n$/, "").split("\n");
      if (added.length > ctx.limits.newFileLines) {
        return { ok: false, content: `Not inserted: ${added.length} lines is over the ${ctx.limits.newFileLines}-line limit for new content in one step. Insert it in parts.` };
      }
      const head = lines.slice(0, afterLine);
      const tail = lines.slice(afterLine);
      const after = [...head, ...added, ...tail].join("\n");
      writeFileSync(ctx.workspace.resolve(path), after, "utf8");
      // Show the seams, so the model can tell it landed where it meant: the line before, the
      // first and last new lines, and the line after.
      const all = after.split("\n");
      const at = (n: number) => (n >= 1 && n <= all.length ? `${String(n).padStart(5)}  ${all[n - 1]}` : undefined);
      const first = afterLine + 1;
      const last = afterLine + added.length;
      const seam = [at(afterLine), at(first), ...(last > first + 1 ? ["  ..."] : []), ...(last > first ? [at(last)] : []), at(last + 1)].filter((l): l is string => l !== undefined).join("\n");
      return {
        ok: true,
        edited: true,
        change: { path: ctx.workspace.rel(ctx.workspace.resolve(path)), before },
        content: `Inserted ${added.length} line${added.length === 1 ? "" : "s"} into ${path} after line ${afterLine}:\n${seam}`,
      };
    },
  }),

  tool({
    name: "run_command",
    description: "Run a shell command in the project root. The user approves each command first. Prefer run_checks for typecheck, lint and tests.",
    schema: z.object({
      command: z.string().min(1),
      timeoutSeconds: z.number().int().positive().max(1800).optional(),
    }),
    async run({ command, timeoutSeconds }, ctx) {
      if (!(await ctx.approve({ kind: "command", command, cwd: ctx.workspace.root }))) {
        return { ok: false, command, content: `The user declined to run \`${command}\`. Find another way or ask them.` };
      }
      const r = await runCommand(command, {
        cwd: ctx.workspace.root,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : ctx.limits.commandTimeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      return {
        ok: r.exitCode === 0,
        command,
        exitCode: r.exitCode,
        output: r.output,
        durationMs: r.durationMs,
        content: `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${r.exitCode !== 0 ? focusClip(r.output, 6000) : clip(r.output)}`,
      };
    },
  }),

  tool({
    name: "run_checks",
    description: "Run the project's typecheck, lint and tests. Do this after every step that changes code.",
    schema: z.object({}),
    async run(_args, ctx) {
      const runs = await runChecks(ctx);
      return { ok: allChecksPassed(runs), checkRuns: runs, content: describeChecks(runs) };
    },
  }),
  // Precise navigation: definitions, references and fast diagnostics (A1).
  ...CODE_TOOLS,
];

/** JSON-schema tool specs for the model. */
export function toolSpecs(tools: AgentTool[] = TOOLS): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}
