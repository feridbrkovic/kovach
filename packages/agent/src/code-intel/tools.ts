/**
 * Precise code navigation for the agent (MASTER_PLAN › Agent quality, A1):
 * find_symbol, find_references and diagnostics. Tree-sitter for every indexed
 * language; TypeScript's language service for exact references and type errors
 * in TS/JS. Cheaper and more exact than grepping and reading whole files.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentTool, ToolOutcome } from "../tools.js";
import type { Workspace } from "../workspace.js";
import { languageFor } from "./languages.js";
import { createSymbolIndex, type Definition, INDEXED_LANGUAGES, MAX_INDEXED_FILES, type SymbolIndex } from "./symbols.js";
import { createTsProject, isTsFile, type TsProject } from "./typescript.js";

interface CodeIntel {
  index: SymbolIndex;
  files: string[];
  ts?: TsProject;
  tsError?: string;
  /** Keeps two tool calls from indexing at once. */
  updating?: Promise<void>;
}

/** One index per project folder, kept for the app's lifetime and refreshed as files change. */
const byRoot = new Map<string, CodeIntel>();

async function intel(workspace: Workspace): Promise<CodeIntel> {
  let c = byRoot.get(workspace.root);
  if (!c) {
    c = { index: createSymbolIndex(workspace.root), files: [] };
    byRoot.set(workspace.root, c);
  }
  const current = c;
  while (current.updating) await current.updating;
  current.updating = (async () => {
    current.files = await workspace.listFiles(MAX_INDEXED_FILES * 2);
    await current.index.update(current.files);
  })();
  try {
    await current.updating;
  } finally {
    current.updating = undefined;
  }
  return current;
}

function tsFor(c: CodeIntel, workspace: Workspace): TsProject | undefined {
  if (c.ts || c.tsError) return c.ts;
  try {
    c.ts = createTsProject(workspace.root, () => c.files);
  } catch (err) {
    c.tsError = (err as Error).message;
  }
  return c.ts;
}

/** Forget a project's index (tests, or after a project is removed). */
export function resetCodeIntel(root?: string): void {
  if (root) byRoot.delete(root);
  else byRoot.clear();
}

const MAX_LIST = 40;

const describeDef = (d: Definition) => `${d.kind} ${d.container ? `${d.container}.` : ""}${d.name} — ${d.path}:${d.line}\n    ${d.signature}`;

function more(total: number, shown: number, what: string): string {
  return total > shown ? `\n…and ${total - shown} more ${what}; narrow it with path.` : "";
}

export const CODE_TOOLS: AgentTool[] = [
  {
    name: "find_symbol",
    description: `Where a function, class, method, type or constant is defined (${INDEXED_LANGUAGES.join(", ")}). Exact name first; near matches when there is none. Faster and more exact than search.`,
    schema: z.object({
      name: z.string().min(1).describe("The symbol's name, e.g. 'useCart', 'TaxCalculator', 'optics_lens_price'"),
      kind: z.string().optional().describe("Only this kind: function, class, method, interface, type, enum, constant, trait, variable"),
    }),
    async run(args: { name: string; kind?: string }, { workspace }): Promise<ToolOutcome> {
      const c = await intel(workspace);
      const filter = (ds: Definition[]) => (args.kind ? ds.filter((d) => d.kind === args.kind) : ds);
      const exact = filter(c.index.definitions(args.name));
      if (exact.length) {
        // Point at the next step: text search can't tell same-named definitions apart, find_references can.
        const first = exact[0]!;
        const next =
          exact.length > 1
            ? `\n${exact.length} definitions share this name. For the uses of one, call find_references with its path and line, e.g. {"name": "${args.name}", "path": "${first.path}", "line": ${first.line}}.`
            : `\nFor its uses, call find_references {"name": "${args.name}", "path": "${first.path}", "line": ${first.line}}.`;
        return { ok: true, content: exact.slice(0, MAX_LIST).map(describeDef).join("\n") + more(exact.length, MAX_LIST, "definitions") + next };
      }
      const near = filter(c.index.similar(args.name, MAX_LIST));
      if (near.length) return { ok: true, content: `No definition named ${args.name}. Similar names:\n${near.map(describeDef).join("\n")}` };
      return {
        ok: true,
        content: `No definition of ${args.name} in the project's ${c.index.files().size} indexed files (${INDEXED_LANGUAGES.join(", ")}). It may come from a dependency or another language; try search.`,
      };
    },
  } as AgentTool,
  {
    name: "find_references",
    description:
      "Where a symbol is used. For TypeScript/JavaScript give path and line of the definition (from find_symbol) for exact, type-aware results; otherwise uses are matched by name (calls, `new`, types, WordPress hook callbacks).",
    schema: z.object({
      name: z.string().min(1),
      path: z.string().optional().describe("File of the definition, for exact TS/JS references"),
      line: z.number().int().positive().optional().describe("Line of the definition in that file"),
    }),
    async run(args: { name: string; path?: string; line?: number }, { workspace }): Promise<ToolOutcome> {
      const c = await intel(workspace);
      // Exact, type-aware references for TS/JS: at the given definition, or the only one there is.
      const defs = c.index.definitions(args.name).filter((d) => isTsFile(d.path));
      const at = args.path && args.line ? defs.find((d) => d.path === args.path && d.line === args.line) ?? (isTsFile(args.path) ? { path: args.path, line: args.line, column: 0 } : undefined) : defs.length === 1 ? defs[0] : undefined;
      if (at) {
        const ts = tsFor(c, workspace);
        if (ts) {
          workspace.resolve(at.path); // inside the project, not a secrets file
          let column = at.column;
          if (!column) {
            // A line without a column: point at the name on that line.
            const text = workspace.readText(at.path).split("\n")[at.line - 1] ?? "";
            column = Math.max(1, text.indexOf(args.name) + 1);
          }
          const refs = ts.references(at.path, at.line, column);
          if (refs) {
            const lines = refs.map((r) => `${r.path}:${r.line}: ${r.text}`);
            return {
              ok: true,
              content: `${refs.length} reference${refs.length === 1 ? "" : "s"} to ${args.name} (TypeScript ${ts.version}, type-aware):\n${lines.slice(0, MAX_LIST * 2).join("\n")}${more(lines.length, MAX_LIST * 2, "references")}`,
            };
          }
        }
      }
      // Asked for an exact location that has no such symbol: say so, then fall back to names.
      const missed =
        args.path && args.line && at ? `No ${args.name} at ${args.path}:${args.line}${defs.length ? `; it is defined at ${defs.map((d) => `${d.path}:${d.line}`).join(", ")}` : ""}. Matching by name instead.\n` : "";
      const refs = c.index.references(args.name);
      const allDefs = c.index.definitions(args.name);
      if (!refs.length && !allDefs.length) return { ok: true, content: `No uses of ${args.name} found by name. Try search for other spellings.` };
      const head = defs.length > 1 && !args.path ? `${defs.length} TS/JS definitions share this name; give path and line for exact results.\n` : "";
      const lines = refs.map((r) => `${r.path}:${r.line}: ${r.text}`);
      return {
        ok: true,
        content: `${missed}${head}Defined at: ${allDefs.map((d) => `${d.path}:${d.line}`).join(", ") || "not in the project"}\n${refs.length} use${refs.length === 1 ? "" : "s"} by name (may include other symbols with the same name):\n${lines.slice(0, MAX_LIST * 2).join("\n")}${more(lines.length, MAX_LIST * 2, "uses")}`,
      };
    },
  } as AgentTool,
  {
    name: "diagnostics",
    description:
      "Type and syntax errors in files, in about a second: TypeScript's own checker for TS/JS, syntax errors for the other indexed languages. Use it right after an edit; run_checks is still the final word.",
    schema: z.object({
      paths: z.array(z.string()).max(20).optional().describe("Files to check; default: files changed in the last 30 minutes"),
    }),
    async run(args: { paths?: string[] }, { workspace }): Promise<ToolOutcome> {
      const c = await intel(workspace);
      let paths = args.paths;
      if (!paths?.length) {
        const since = Date.now() - 30 * 60_000;
        paths = [...c.index.files()]
          .filter(([, m]) => m >= since)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([p]) => p);
        if (!paths.length) return { ok: true, content: "No recently changed files to check; give paths." };
      }
      const out: string[] = [];
      let errors = 0;
      for (const p of paths) {
        workspace.resolve(p);
        try {
          statSync(join(workspace.root, p));
        } catch {
          out.push(`${p}: not found`);
          continue;
        }
        if (isTsFile(p)) {
          const ts = tsFor(c, workspace);
          if (ts) {
            const ds = ts.diagnostics(p);
            errors += ds.filter((d) => d.category === "error").length;
            out.push(ds.length ? ds.slice(0, 20).map((d) => `${d.path}:${d.line}:${d.column} ${d.category} TS${d.code}: ${d.message}`).join("\n") : `${p}: no errors`);
            continue;
          }
        }
        if (languageFor(p)) {
          const ps = c.index.problems(p) ?? [];
          errors += ps.length;
          out.push(ps.length ? ps.map((x) => `${x.path}:${x.line}:${x.column} ${x.message}`).join("\n") : `${p}: no syntax errors`);
        } else out.push(`${p}: no checker for this file type`);
      }
      return { ok: true, content: `${errors ? `${errors} error${errors === 1 ? "" : "s"}` : "No errors"}.\n${out.join("\n")}` };
    },
  } as AgentTool,
];
