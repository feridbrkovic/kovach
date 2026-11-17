/**
 * Where official docs live for one library version, and how to fetch them
 * (MASTER_PLAN › Docs packs). Official docs are read straight from the
 * project's own repository at the matching version; no web search.
 *
 * Fetching uses git rather than the GitHub API: a shallow clone without file
 * contents lists every path, then a sparse checkout downloads only the docs
 * folder. That needs no token and isn't limited to 60 requests an hour.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chunkMarkdown, type DocChunk } from "./chunk.js";
import { docbookToMarkdown, parseEntities } from "./docbook.js";

const run = promisify(execFile);

export interface DocsFetcher {
  /** Every file path in a repo at a ref (default branch when undefined). */
  list(repo: string, ref: string | undefined, signal?: AbortSignal): Promise<string[]>;
  /** Tag names matching a git pattern, e.g. "v22.*". */
  tags(repo: string, pattern: string, signal?: AbortSignal): Promise<string[]>;
  /** File contents at a ref. Missing files are left out. */
  read(repo: string, ref: string | undefined, paths: string[], signal?: AbortSignal): Promise<Map<string, string>>;
  /** npm metadata: the GitHub repo ("owner/name") and its subdirectory for a package version, or the latest version. */
  npm(pkg: string, version: string, signal?: AbortSignal): Promise<{ repo?: string; directory?: string; version?: string }>;
  /** Clean up temporary clones. */
  dispose?(): void;
}

/** One repository's part of a pack. */
export interface DocsSource {
  repo: string;
  ref?: string;
  /** Path prefixes (folders or single files) to include; "" is the repo's top-level files, "/" everything. */
  include: string[];
  /** Paths to leave out even when included (build scripts, templates). */
  exclude?: RegExp;
  /** Which files are pages. Default: Markdown. */
  ext?: RegExp;
  /** At most this many pages (default 400). */
  maxFiles?: number;
  /** Files read alongside the pages but not indexed (e.g. the PHP manual's entity definitions). */
  support?: string[];
  /** Turn one page into Markdown (and its public URL) when it isn't Markdown already. */
  convert?(path: string, text: string, support: Map<string, string>): { markdown: string; url?: string } | undefined;
  /** Where a person can read a page. */
  pageUrl(path: string): string;
}

export interface DocsPlan extends DocsSource {
  /** The docs version actually used, e.g. "0.80" or "22.11.0". */
  docsVersion: string;
  /** Shown in the UI, e.g. "0.76 is no longer published; using the nearest docs (0.77)". */
  note?: string;
  /** More repositories in the same pack (WordPress: the REST API handbook, the coding standards). */
  also?: DocsSource[];
}

const DOC_EXT = /\.(md|mdx|markdown)$/i;
const MAX_FILES = 400;

/** The part of a version that signals breaking changes: major, or major.minor for 0.x. */
export function breakingVersion(v: string): string {
  const [maj = v, min = "0"] = v.replace(/^[^\d]*/, "").split(".");
  return maj === "0" ? `0.${min}` : maj;
}

const cmpVersions = (a: string, b: string) => {
  const pa = a.replace(/^[^\d]*/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^[^\d]*/, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Highest stable tag (no -canary/-rc) whose version starts with the breaking version. */
export function pickTag(tags: string[], breaking: string, prefix = "v"): string | undefined {
  const stable = tags.filter((t) => t.startsWith(prefix) && !/-/.test(t.slice(prefix.length)));
  const match = stable.filter((t) => breakingVersion(t.slice(prefix.length)) === breaking);
  return match.sort((a, b) => cmpVersions(b.slice(prefix.length), a.slice(prefix.length)))[0];
}

const blob = (repo: string, ref: string | undefined) => (path: string) => `https://github.com/${repo}/blob/${ref ?? "HEAD"}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Pick a versioned docs folder: exact match, else the nearest newer one, else the newest. */
function nearestFolder(
  folders: { name: string; version: string }[],
  breaking: string,
): { folder?: { name: string; version: string }; exact: boolean } {
  const exact = folders.find((f) => breakingVersion(f.version) === breaking);
  if (exact) return { folder: exact, exact: true };
  const sorted = [...folders].sort((a, b) => cmpVersions(a.version, b.version));
  const newer = sorted.find((f) => cmpVersions(f.version, breaking) > 0);
  return { folder: newer ?? sorted.at(-1), exact: false };
}

type Recipe = (version: string, f: DocsFetcher, signal?: AbortSignal) => Promise<DocsPlan>;

/** The PHP manual's sections in a pack: the language itself and the extensions most projects use. */
const PHP_PARTS = [
  "language/",
  ...["array", "strings", "json", "pcre", "datetime", "mbstring", "pdo", "filesystem", "var", "url", "funchand", "math", "ctype", "spl", "classobj", "errorfunc", "password", "session", "curl", "info", "outcontrol"].map(
    (e) => `reference/${e}/`,
  ),
];
/** Where doc-en defines the entities its pages use (&reftitle.description;, &return.success;…). */
const PHP_ENTITY_FILES = ["language-snippets.ent", ...["php", "title", "acronyms", "extcat", "remove", "url"].map((n) => `entities/entities.${n}.ent`)];

const phpConvert: DocsSource["convert"] = (_path, text, support) => {
  let entities = phpEntityCache.get(support);
  if (!entities) {
    entities = new Map();
    for (const f of PHP_ENTITY_FILES) parseEntities(support.get(f) ?? "", entities);
    phpEntityCache.set(support, entities);
  }
  const page = docbookToMarkdown(text, entities);
  if (!page.markdown) return undefined;
  return { markdown: page.markdown, ...(page.id ? { url: `https://www.php.net/manual/en/${page.id}.php` } : {}) };
};
const phpEntityCache = new WeakMap<Map<string, string>, Map<string, string>>();

/** Curated recipes for the libraries the plan builds packs for first. */
export const RECIPES: Record<string, { label: string; recipe: Recipe; breaking?: (version: string) => string }> = {
  "react-native": {
    label: "React Native",
    async recipe(version, f, signal) {
      const repo = "facebook/react-native-website";
      const b = breakingVersion(version);
      const files = await f.list(repo, undefined, signal);
      const folders = [...new Set(files.map((p) => /^website\/versioned_docs\/version-([\d.]+)\//.exec(p)?.[1]).filter(Boolean) as string[])].map((v) => ({
        name: `website/versioned_docs/version-${v}/`,
        version: v,
      }));
      const { folder, exact } = nearestFolder(folders, b);
      // Newer than every published version: the docs for the next release live in docs/.
      const newest = folders.map((x) => x.version).sort(cmpVersions).at(-1);
      if (!folder || (newest && cmpVersions(b, newest) > 0)) {
        return { repo, include: ["docs/"], docsVersion: "next", note: `Using the unreleased docs; ${b} isn't published as its own version`, pageUrl: blob(repo, undefined) };
      }
      return {
        repo,
        include: [folder.name],
        docsVersion: folder.version,
        ...(exact ? {} : { note: `${b} is no longer published; using the nearest docs (${folder.version})` }),
        pageUrl: blob(repo, undefined),
      };
    },
  },
  expo: {
    label: "Expo SDK",
    async recipe(version, f, signal) {
      const repo = "expo/expo";
      const b = breakingVersion(version);
      const files = await f.list(repo, undefined, signal);
      const folders = [...new Set(files.map((p) => /^docs\/pages\/versions\/(v[\d.]+)\//.exec(p)?.[1]).filter(Boolean) as string[])].map((v) => ({
        name: `docs/pages/versions/${v}/`,
        version: v.slice(1),
      }));
      const { folder, exact } = nearestFolder(folders, b);
      if (!folder) return { repo, include: ["docs/pages/versions/unversioned/"], docsVersion: "unversioned", pageUrl: blob(repo, undefined) };
      return {
        repo,
        include: [folder.name],
        docsVersion: folder.version,
        ...(exact ? {} : { note: `SDK ${b} is no longer published; using the nearest docs (SDK ${breakingVersion(folder.version)})` }),
        pageUrl: blob(repo, undefined),
      };
    },
  },
  react: {
    label: "React",
    async recipe(version, f, signal) {
      const repo = "reactjs/react.dev";
      const latest = (await f.npm("react", "latest", signal)).version ?? "";
      const b = breakingVersion(version);
      const lb = latest ? breakingVersion(latest) : "";
      return {
        repo,
        include: ["src/content/reference/", "src/content/learn/"],
        docsVersion: lb || "latest",
        ...(lb && lb !== b ? { note: `react.dev documents React ${lb}; this project uses ${b}` } : {}),
        pageUrl: blob(repo, undefined),
      };
    },
  },
  typescript: {
    label: "TypeScript",
    async recipe(version, f, signal) {
      const repo = "microsoft/TypeScript-Website";
      const latest = (await f.npm("typescript", "latest", signal)).version ?? "";
      const lb = latest ? latest.split(".").slice(0, 2).join(".") : "latest";
      const want = version.split(".").slice(0, 2).join(".");
      return {
        repo,
        include: ["packages/documentation/copy/en/"],
        docsVersion: lb,
        ...(lb !== want ? { note: `The handbook follows TypeScript ${lb}; this project uses ${want}` } : {}),
        pageUrl: blob(repo, undefined),
      };
    },
  },
  node: {
    label: "Node.js",
    async recipe(version, f, signal) {
      const repo = "nodejs/node";
      const b = breakingVersion(version);
      const tag = pickTag(await f.tags(repo, `v${b}.*`, signal), b);
      if (!tag) throw new Error(`No Node.js release found for ${b}`);
      return { repo, ref: tag, include: ["doc/api/"], docsVersion: tag.slice(1), pageUrl: blob(repo, tag) };
    },
  },
  next: {
    label: "Next.js",
    async recipe(version, f, signal) {
      const repo = "vercel/next.js";
      const b = breakingVersion(version);
      const tag = pickTag(await f.tags(repo, `v${b}.*`, signal), b);
      if (!tag) throw new Error(`No Next.js release found for ${b}`);
      return { repo, ref: tag, include: ["docs/"], docsVersion: tag.slice(1), pageUrl: blob(repo, tag) };
    },
  },
  php: {
    label: "PHP",
    async recipe(version) {
      const repo = "php/doc-en";
      return {
        repo,
        include: PHP_PARTS,
        exclude: /\/versions\.xml$/,
        ext: /\.xml$/i,
        maxFiles: 2000,
        support: PHP_ENTITY_FILES,
        convert: phpConvert,
        // One manual for every supported version; changes are marked "As of PHP x" on each page.
        docsVersion: "current",
        note: `One manual for every PHP version; what changed in which version (this project: ${version}) is marked on each page`,
        pageUrl: blob(repo, undefined),
      };
    },
  },
  wordpress: {
    label: "WordPress",
    // Every x.y release is a major release in WordPress.
    breaking: (v) => v.replace(/^[^\d]*/, "").split(".").slice(0, 2).join("."),
    async recipe(version, f, signal) {
      const repo = "WordPress/gutenberg";
      const xy = version.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
      // The block editor docs as they shipped in this WordPress release (branch wp/x.y), else the latest.
      let ref: string | undefined = `wp/${xy}`;
      try {
        await f.list(repo, ref, signal);
      } catch {
        ref = undefined;
      }
      const handbooks = "The Theme and Plugin handbooks aren't published in a repository; this pack has the Block Editor and REST API handbooks and the coding standards";
      return {
        repo,
        ...(ref ? { ref } : {}),
        include: ["docs/"],
        docsVersion: ref ? xy : "latest",
        note: ref ? handbooks : `No block editor docs for WordPress ${xy}; using the latest. ${handbooks}`,
        pageUrl: blob(repo, ref),
        also: [
          { repo: "WP-API/docs", include: ["/"], exclude: /^(bin\/|README\.md$)/, pageUrl: blob("WP-API/docs", undefined) },
          { repo: "WordPress/wpcs-docs", include: ["/"], exclude: /^README\.md$/, pageUrl: blob("WordPress/wpcs-docs", undefined) },
        ],
      };
    },
  },
  woocommerce: {
    label: "WooCommerce",
    async recipe(version, f, signal) {
      const repo = "woocommerce/woocommerce";
      const b = breakingVersion(version);
      // Release tags have no "v": 10.9.4.
      const tag = pickTag(await f.tags(repo, `${b}.*`, signal), b, "");
      const files = tag ? await f.list(repo, tag, signal) : [];
      const hasDocs = files.some((p) => p.startsWith("docs/") && DOC_EXT.test(p));
      if (tag && hasDocs) return { repo, ref: tag, include: ["docs/"], docsVersion: tag, pageUrl: blob(repo, tag) };
      return {
        repo,
        include: ["docs/"],
        docsVersion: "latest",
        note: tag ? `WooCommerce ${tag} has no developer docs in its repository; using the latest` : `No WooCommerce ${b} release found; using the latest docs`,
        pageUrl: blob(repo, undefined),
      };
    },
  },
  "laravel/framework": {
    label: "Laravel",
    async recipe(version) {
      const repo = "laravel/docs";
      const ref = `${breakingVersion(version)}.x`;
      return { repo, ref, include: [""], docsVersion: ref, pageUrl: blob(repo, ref) };
    },
  },
};

/** Libraries whose packs are built without asking, when a project uses them (decision 4 in the plan). */
export const AUTO_LIBRARIES = new Set(["react-native", "expo", "react", "typescript", "node", "next", "laravel/framework", "php", "wordpress", "woocommerce"]);

/** The version a pack is kept per: the breaking version, or the library's own notion of it (WordPress x.y). */
export function packVersion(library: string, version: string): string {
  return RECIPES[library]?.breaking?.(version) ?? breakingVersion(version);
}

/** Any other npm library: its own repo at the version's tag, docs/ folder or the README. */
async function genericNpm(library: string, version: string, f: DocsFetcher, signal?: AbortSignal): Promise<DocsPlan> {
  const meta = await f.npm(library, version, signal);
  if (!meta.repo) throw new Error(`${library} doesn't name a GitHub repository on npm`);
  const repo = meta.repo;
  const exact = meta.version ?? version;
  const short = library.split("/").pop()!;
  const tags = await f.tags(repo, "*", signal);
  const candidates = [`v${exact}`, exact, `${library}@${exact}`, `${short}@${exact}`];
  const ref = candidates.find((t) => tags.includes(t)) ?? pickTag(tags, breakingVersion(exact)) ?? pickTag(tags, breakingVersion(exact), `${library}@`);
  const files = await f.list(repo, ref, signal);
  const dir = meta.directory ? `${meta.directory.replace(/\/+$/, "")}/` : "";
  const docsDirs = [`${dir}docs/`, `${dir}documentation/`, `${dir}website/docs/`, "docs/", "website/docs/"].filter(
    (d, i, all) => all.indexOf(d) === i && files.some((p) => p.startsWith(d) && DOC_EXT.test(p)),
  );
  const readme = [`${dir}README.md`, "README.md", "readme.md"].find((p) => files.includes(p));
  const include = docsDirs.length ? [docsDirs[0]!, ...(readme ? [readme] : [])] : readme ? [readme] : [];
  if (include.length === 0) throw new Error(`${library} has no docs folder or README in ${repo}`);
  return {
    repo,
    ...(ref ? { ref } : {}),
    include,
    docsVersion: ref ? exact : "latest",
    ...(ref ? {} : { note: `No tag for ${exact} in ${repo}; using the default branch` }),
    pageUrl: blob(repo, ref),
  };
}

export function docsLabel(library: string): string {
  return RECIPES[library]?.label ?? library;
}

export async function planDocs(library: string, version: string, f: DocsFetcher, signal?: AbortSignal): Promise<DocsPlan> {
  const r = RECIPES[library];
  return r ? r.recipe(version, f, signal) : genericNpm(library, version, f, signal);
}

/** Which files of a source to read: docs pages only, no drafts, partials, translations or blog posts. */
export function selectFiles(plan: DocsSource, files: string[]): string[] {
  const ext = plan.ext ?? DOC_EXT;
  return files
    .filter((p) => ext.test(p))
    .filter((p) => plan.include.some((inc) => (inc === "/" ? true : inc === "" ? !p.includes("/") : inc.endsWith("/") ? p.startsWith(inc) : p === inc)))
    .filter((p) => !plan.exclude?.test(p))
    .filter((p) => !/(^|\/)(_[^/]*|\.[^/]*|node_modules|blog|i18n|translations?|changelog|CHANGELOG[^/]*|LICENSE[^/]*|CODE_OF_CONDUCT[^/]*)(\/|$)/i.test(p))
    .slice(0, plan.maxFiles ?? MAX_FILES);
}

export interface BuiltDocs {
  plan: DocsPlan;
  chunks: (DocChunk & { path: string })[];
  files: number;
}

/** Resolve, fetch and chunk the docs for one library version. */
export async function fetchDocs(library: string, version: string, f: DocsFetcher, signal?: AbortSignal): Promise<BuiltDocs> {
  const plan = await planDocs(library, version, f, signal);
  const chunks: BuiltDocs["chunks"] = [];
  let files = 0;
  for (const [i, source] of [plan, ...(plan.also ?? [])].entries()) {
    const all = await f.list(source.repo, source.ref, signal);
    const paths = selectFiles(source, all);
    if (paths.length === 0) {
      // The main repo must have pages; an extra one that has none just adds nothing.
      if (i === 0) throw new Error(`No documentation pages found in ${source.repo}`);
      continue;
    }
    const support = (source.support ?? []).filter((p) => all.includes(p));
    const contents = await f.read(source.repo, source.ref, [...support, ...paths], signal);
    const supportFiles = new Map(support.map((p) => [p, contents.get(p) ?? ""]));
    // Paths from other repos are kept apart, so two repos' README.md don't collide.
    const prefix = i === 0 ? "" : `${source.repo}:`;
    for (const p of paths) {
      const text = contents.get(p);
      if (!text) continue;
      files++;
      const page = source.convert ? source.convert(p, text, supportFiles) : { markdown: text };
      if (!page) continue;
      for (const c of chunkMarkdown(page.markdown, { path: p, pageUrl: page.url ?? source.pageUrl(p) })) chunks.push({ ...c, path: prefix + p });
    }
  }
  if (chunks.length === 0) throw new Error(`The documentation pages in ${plan.repo} had no readable sections`);
  return { plan, chunks, files };
}

// ---------------------------------------------------------------------------
// The real fetcher: git for repos, the npm registry for package metadata
// ---------------------------------------------------------------------------

export function parseGithubRepo(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.trim()) ?? /^github:([\w.-]+)\/([\w.-]+)$/i.exec(url.trim());
  if (m) return `${m[1]}/${m[2]}`;
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim()); // "owner/repo" shorthand
  return short ? `${short[1]}/${short[2]}` : undefined;
}

export function createGitDocsFetcher(opts: { git?: string; fetch?: typeof fetch; tmp?: string } = {}): DocsFetcher {
  const git = opts.git ?? "git";
  const http = opts.fetch ?? fetch;
  const clones = new Map<string, string>();
  const root = mkdtempSync(join(opts.tmp ?? tmpdir(), "kovach-docs-"));
  const url = (repo: string) => `https://github.com/${repo}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  const g = (args: string[], signal?: AbortSignal, input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(git, args, { env, maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).toString().split("\n").filter(Boolean).slice(-1)[0] ?? "git failed"));
        else resolve(stdout.toString());
      });
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });

  const clone = async (repo: string, ref: string | undefined, signal?: AbortSignal) => {
    const key = `${repo}@${ref ?? ""}`;
    const have = clones.get(key);
    if (have) return have;
    const dir = join(root, String(clones.size));
    await g(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", ...(ref ? ["--branch", ref] : []), url(repo), dir], signal);
    clones.set(key, dir);
    return dir;
  };

  return {
    async list(repo, ref, signal) {
      const dir = await clone(repo, ref, signal);
      return (await g(["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], signal)).split("\n").filter(Boolean);
    },
    async tags(repo, pattern, signal) {
      const out = await g(["ls-remote", "--tags", "--refs", url(repo), ...(pattern === "*" ? [] : [pattern])], signal);
      return out
        .split("\n")
        .map((l) => l.split("refs/tags/")[1])
        .filter((t): t is string => !!t);
    },
    async read(repo, ref, paths, signal) {
      const dir = await clone(repo, ref, signal);
      // Only these paths are downloaded; the rest of the repo stays as metadata.
      await g(["-C", dir, "sparse-checkout", "set", "--no-cone", "--stdin"], signal, paths.map((p) => `/${p.replace(/([*?[\]!#])/g, "\\$1")}`).join("\n") + "\n");
      await g(["-C", dir, "checkout", "--quiet", "HEAD"], signal);
      const out = new Map<string, string>();
      for (const p of paths) {
        try {
          out.set(p, readFileSync(join(dir, p), "utf8"));
        } catch {
          // left out
        }
      }
      return out;
    },
    async npm(pkg, version, signal) {
      const name = pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
      const res = await http(`https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`, { ...(signal ? { signal } : {}), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`npm has no ${pkg}@${version}`);
      const j = (await res.json()) as { version?: string; repository?: string | { url?: string; directory?: string } };
      const r = typeof j.repository === "string" ? { url: j.repository } : (j.repository ?? {});
      const repo = parseGithubRepo(r.url);
      return { ...(repo ? { repo } : {}), ...(r.directory ? { directory: r.directory } : {}), ...(j.version ? { version: j.version } : {}) };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
      clones.clear();
    },
  };
}

/** True when git can be run (the real fetcher needs it). */
export async function hasGit(git = "git"): Promise<boolean> {
  try {
    await run(git, ["--version"]);
    return true;
  } catch {
    return false;
  }
}
