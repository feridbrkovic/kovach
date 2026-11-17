/**
 * TypeScript's language service for TS/JS projects: semantic references and
 * type errors, the same engine editors use. It loads the project's own
 * TypeScript when it has one (so results match its compiler), else the one
 * bundled with the app. One service per tsconfig/jsconfig, so monorepos work.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import type * as TS from "typescript";

type Ts = typeof TS;

export interface TsLocation {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface TsDiagnostic {
  path: string;
  line: number;
  column: number;
  code: number;
  message: string;
  category: "error" | "warning";
}

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
export const isTsFile = (path: string) => TS_FILE.test(path) && !path.endsWith(".d.ts.map");

/**
 * Where TypeScript's own lib.*.d.ts files are (Array, Promise, the DOM…). Normally next to
 * typescript.js; the packaged app ships them as a resources folder instead, because the
 * packager strips .d.ts files from node_modules.
 */
export function defaultLibPath(ts: Pick<Ts, "getDefaultLibFilePath">, options: TS.CompilerOptions, fallbackDir = libFallbackDir()): string {
  const path = ts.getDefaultLibFilePath(options);
  if (existsSync(path) || !fallbackDir) return path;
  const moved = join(fallbackDir, basename(path));
  return existsSync(moved) ? moved : path;
}

function libFallbackDir(): string | undefined {
  if (process.env.KOVACH_TS_LIB_DIR) return process.env.KOVACH_TS_LIB_DIR;
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  return resources ? join(resources, "typescript-lib") : undefined;
}

/** The project's TypeScript (4.x/5.x, which have the language service API), else the bundled one. */
export function loadTypescript(root: string): { ts: Ts; source: "project" | "bundled" } {
  try {
    const ts = createRequire(join(root, "package.json"))("typescript") as Ts;
    if (typeof ts.createLanguageService === "function" && /^[45]\./.test(ts.version)) return { ts, source: "project" };
  } catch {
    // not installed in the project
  }
  return { ts: createRequire(import.meta.url)("typescript") as Ts, source: "bundled" };
}

interface Service {
  ls: TS.LanguageService;
  files: Set<string>;
}

export interface TsProject {
  readonly version: string;
  readonly source: "project" | "bundled";
  /** Semantic references to the symbol at a position (1-based line and column). */
  references(path: string, line: number, column: number): TsLocation[] | undefined;
  /** Syntax and type errors of one file. */
  diagnostics(path: string): TsDiagnostic[];
}

export function createTsProject(root: string, listFiles: () => string[]): TsProject {
  const { ts, source } = loadTypescript(root);
  const services = new Map<string, Service>();
  const abs = (p: string) => join(root, p);
  const rel = (p: string) => relative(root, p).split(sep).join("/");

  /** The nearest tsconfig.json or jsconfig.json above a file, inside the project. */
  const configFor = (path: string): string | undefined => {
    for (let dir = dirname(abs(path)); dir.length >= root.length; dir = dirname(dir)) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) if (existsSync(join(dir, name))) return join(dir, name);
      if (dir === root) break;
    }
    return undefined;
  };

  const serviceFor = (path: string): Service => {
    const config = configFor(path) ?? "";
    let s = services.get(config);
    if (s) {
      // A file the config doesn't list (new, or outside "include") is still checked on its own.
      if (!s.files.has(abs(path))) s.files.add(abs(path));
      return s;
    }
    let options: TS.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    };
    let fileNames: string[] = [];
    if (config) {
      const read = ts.readConfigFile(config, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dirname(config));
      options = { ...parsed.options, noEmit: true };
      fileNames = parsed.fileNames;
    }
    if (fileNames.length === 0) {
      // No config, or a solution-style one that only references others: the files around this one.
      const base = config ? rel(dirname(config)) : "";
      fileNames = listFiles()
        .filter((f) => isTsFile(f) && (!base || f.startsWith(`${base}/`)))
        .slice(0, 3000)
        .map(abs);
    }
    const files = new Set(fileNames.slice(0, 5000));
    files.add(abs(path));
    const version = (f: string) => {
      try {
        return String(statSync(f).mtimeMs);
      } catch {
        return "0";
      }
    };
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...files],
      getScriptVersion: version,
      getScriptSnapshot: (f) => {
        if (!existsSync(f)) return undefined;
        try {
          return ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"));
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => (config ? dirname(config) : root),
      // The directory of this file is also where `/// <reference lib>` files are looked up.
      getDefaultLibFileName: (o) => defaultLibPath(ts, o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    s = { ls: ts.createLanguageService(host, ts.createDocumentRegistry()), files };
    services.set(config, s);
    return s;
  };

  const position = (file: string, line: number, column: number): number | undefined => {
    try {
      const text = readFileSync(abs(file), "utf8");
      const lines = text.split("\n");
      if (line < 1 || line > lines.length) return undefined;
      let pos = 0;
      for (let i = 0; i < line - 1; i++) pos += lines[i]!.length + 1;
      return pos + Math.max(0, column - 1);
    } catch {
      return undefined;
    }
  };

  const locate = (fileName: string, start: number): TsLocation | undefined => {
    try {
      const text = readFileSync(fileName, "utf8");
      const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
      const lc = sf.getLineAndCharacterOfPosition(start);
      return { path: rel(fileName), line: lc.line + 1, column: lc.character + 1, text: (text.split("\n")[lc.line] ?? "").trim().slice(0, 200) };
    } catch {
      return undefined;
    }
  };

  return {
    version: ts.version,
    source,
    references(path, line, column) {
      const pos = position(path, line, column);
      if (pos === undefined) return undefined;
      const s = serviceFor(path);
      const groups = s.ls.findReferences(abs(path), pos);
      if (!groups) return undefined;
      const out: TsLocation[] = [];
      for (const g of groups) {
        for (const r of g.references) {
          // Library and node_modules uses aren't the project's.
          if (r.fileName.includes(`${sep}node_modules${sep}`) || !r.fileName.startsWith(root)) continue;
          const l = locate(r.fileName, r.textSpan.start);
          if (l) out.push(l);
        }
      }
      return out;
    },
    diagnostics(path) {
      const s = serviceFor(path);
      const f = abs(path);
      const all = [...s.ls.getSyntacticDiagnostics(f), ...s.ls.getSemanticDiagnostics(f)];
      return all
        .filter((d) => d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning)
        .map((d) => {
          const lc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
          return {
            path,
            line: lc.line + 1,
            column: lc.character + 1,
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, " "),
            category: d.category === ts.DiagnosticCategory.Error ? ("error" as const) : ("warning" as const),
          };
        });
    },
  };
}
