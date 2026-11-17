/**
 * A Tree-sitter symbol index of a project: where names are defined and where
 * they are used, for every language in ./languages. Built on first use, kept in
 * memory, and refreshed per file when its modification time changes.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { LANGUAGES, type LanguageSpec, languageFor } from "./languages.js";

export interface Definition {
  name: string;
  kind: string;
  path: string;
  /** 1-based. */
  line: number;
  column: number;
  /** The class, interface or trait it belongs to (methods). */
  container?: string;
  /** The declaration's first line, trimmed. */
  signature: string;
}

export interface Reference {
  name: string;
  path: string;
  line: number;
  column: number;
  /** The source line, trimmed. */
  text: string;
}

export interface SyntaxProblem {
  path: string;
  line: number;
  column: number;
  message: string;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  defs: Definition[];
  refs: Reference[];
  problems: SyntaxProblem[];
}

/** Files larger than this are skipped (bundles, generated code). */
const MAX_FILE_BYTES = 1_000_000;
/** At most this many files are indexed per project. */
export const MAX_INDEXED_FILES = 10_000;
const GENERATED = /(^|\/)(dist|build|out|coverage|\.next|\.expo|vendor\/bin)\/|\.min\.(js|css)$|\.bundle\.js$/;

// web-tree-sitter types are loose here on purpose: the package is loaded at runtime.
type TS = {
  Parser: { new (): TsParser; init(opts: { locateFile(f: string): string }): Promise<void> };
  Language: { load(path: string): Promise<unknown> };
  Query: new (lang: unknown, source: string) => TsQuery;
};
interface TsNode {
  type: string;
  text: string;
  isMissing: boolean;
  hasError: boolean;
  startPosition: { row: number; column: number };
  parent: TsNode | null;
  children: (TsNode | null)[];
  childForFieldName(name: string): TsNode | null;
}
interface TsParser {
  setLanguage(lang: unknown): void;
  parse(text: string): { rootNode: TsNode; delete(): void } | null;
}
interface TsQuery {
  captures(node: TsNode): { name: string; node: TsNode }[];
}

let runtime: Promise<{ ts: TS; dir: string }> | undefined;
const languages = new Map<string, Promise<{ parser: TsParser; defs: TsQuery; refs: TsQuery }>>();

/** Load the Tree-sitter runtime once per process (WASM, from @vscode/tree-sitter-wasm). */
function loadRuntime(): Promise<{ ts: TS; dir: string }> {
  runtime ??= (async () => {
    const require = createRequire(import.meta.url);
    const main = require.resolve("@vscode/tree-sitter-wasm");
    const ts = require(main) as TS;
    const dir = dirname(main);
    await ts.Parser.init({ locateFile: (f) => join(dir, f) });
    return { ts, dir };
  })();
  return runtime;
}

function loadLanguage(spec: LanguageSpec) {
  let p = languages.get(spec.grammar);
  if (!p) {
    p = (async () => {
      const { ts, dir } = await loadRuntime();
      const lang = await ts.Language.load(join(dir, `tree-sitter-${spec.grammar}.wasm`));
      const parser = new ts.Parser();
      parser.setLanguage(lang);
      return { parser, defs: new ts.Query(lang, spec.defs), refs: new ts.Query(lang, spec.refs) };
    })();
    languages.set(spec.grammar, p);
  }
  return p;
}

const CONTAINERS = new Set(["class_declaration", "abstract_class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "class_definition", "class"]);

function containerOf(node: TsNode): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (CONTAINERS.has(p.type)) return p.childForFieldName("name")?.text;
  }
  return undefined;
}

/** Syntax errors: ERROR and MISSING nodes, the outermost of each broken region. */
function problems(root: TsNode, path: string, max = 20): SyntaxProblem[] {
  const out: SyntaxProblem[] = [];
  const visit = (n: TsNode) => {
    if (out.length >= max) return;
    if (n.type === "ERROR" || n.isMissing) {
      const what = n.isMissing ? `missing ${n.type}` : `unexpected ${JSON.stringify(n.text.split("\n")[0]!.slice(0, 40))}`;
      out.push({ path, line: n.startPosition.row + 1, column: n.startPosition.column + 1, message: `syntax error: ${what}` });
      return;
    }
    if (!n.hasError) return;
    for (const c of n.children) if (c) visit(c);
  };
  visit(root);
  return out;
}

/** Parse one file's text into its definitions, uses and syntax problems. */
export async function analyze(path: string, text: string): Promise<Omit<FileEntry, "mtimeMs" | "size"> | undefined> {
  const spec = languageFor(path);
  if (!spec) return undefined;
  const { parser, defs, refs } = await loadLanguage(spec);
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    const lines = text.split("\n");
    const lineAt = (row: number) => (lines[row] ?? "").trim().slice(0, 200);
    const defOut: Definition[] = [];
    const seen = new Set<string>();
    for (const c of defs.captures(tree.rootNode)) {
      if (!c.name.startsWith("def.")) continue;
      const pos = c.node.startPosition;
      const key = `${pos.row}:${pos.column}`;
      if (seen.has(key)) continue; // an arrow-function const is both "function" and "variable": keep the first
      seen.add(key);
      const container = containerOf(c.node);
      defOut.push({
        name: c.node.text,
        kind: c.name.slice(4),
        path,
        line: pos.row + 1,
        column: pos.column + 1,
        ...(container && container !== c.node.text ? { container } : {}),
        signature: lineAt(pos.row),
      });
    }
    const refOut: Reference[] = [];
    for (const c of refs.captures(tree.rootNode)) {
      if (c.name !== "ref") continue;
      const pos = c.node.startPosition;
      if (seen.has(`${pos.row}:${pos.column}`)) continue; // the definition itself
      refOut.push({ name: c.node.text, path, line: pos.row + 1, column: pos.column + 1, text: lineAt(pos.row) });
    }
    return { defs: defOut, refs: refOut, problems: problems(tree.rootNode, path) };
  } finally {
    tree.delete();
  }
}

export interface SymbolIndex {
  /** Bring the index up to date with the given project files (relative paths). */
  update(files: string[]): Promise<{ files: number; skipped: number }>;
  definitions(name: string): Definition[];
  /** Definitions whose name contains the query, case-insensitively (for near misses). */
  similar(query: string, limit?: number): Definition[];
  references(name: string): Reference[];
  problems(path: string): SyntaxProblem[] | undefined;
  /** Indexed paths with their modification times. */
  files(): Map<string, number>;
}

export function createSymbolIndex(root: string): SymbolIndex {
  const entries = new Map<string, FileEntry>();
  return {
    async update(files) {
      const wanted = files.filter((f) => languageFor(f) && !GENERATED.test(f)).slice(0, MAX_INDEXED_FILES);
      const keep = new Set(wanted);
      for (const p of entries.keys()) if (!keep.has(p)) entries.delete(p);
      let skipped = 0;
      for (const path of wanted) {
        let st: { mtimeMs: number; size: number };
        try {
          st = statSync(join(root, path));
        } catch {
          entries.delete(path);
          continue;
        }
        const have = entries.get(path);
        if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) continue;
        if (st.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        let text: string;
        try {
          text = readFileSync(join(root, path), "utf8");
        } catch {
          continue;
        }
        const result = await analyze(path, text);
        if (result) entries.set(path, { mtimeMs: st.mtimeMs, size: st.size, ...result });
      }
      return { files: entries.size, skipped };
    },
    definitions(name) {
      const out: Definition[] = [];
      for (const e of entries.values()) for (const d of e.defs) if (d.name === name) out.push(d);
      return out;
    },
    similar(query, limit = 20) {
      const q = query.toLowerCase();
      const out: Definition[] = [];
      for (const e of entries.values()) {
        for (const d of e.defs) {
          if (d.name.toLowerCase().includes(q)) out.push(d);
          if (out.length >= limit) return out;
        }
      }
      return out;
    },
    references(name) {
      const out: Reference[] = [];
      for (const e of entries.values()) for (const r of e.refs) if (r.name === name) out.push(r);
      return out;
    },
    problems(path) {
      return entries.get(path)?.problems;
    },
    files() {
      return new Map([...entries].map(([p, e]) => [p, e.mtimeMs]));
    },
  };
}

/** Every language the index understands, for messages. */
export const INDEXED_LANGUAGES = [...new Set(LANGUAGES.map((l) => l.grammar.replace("tsx", "typescript")))];
