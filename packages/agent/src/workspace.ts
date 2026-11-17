import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Files the agent never reads or writes (MASTER_PLAN.md › Privacy and trust boundaries). */
export function isSecretPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") || name.endsWith(".keystore")) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return true;
  return false;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "vendor", ".next", ".expo", "Pods", "coverage", ".turbo"]);

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** The project the agent works in. Every path is relative to `root` and may not leave it. */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
  }

  /** Resolve a project-relative path, refusing anything outside the project or secret-like. */
  resolve(path: string): string {
    if (!path || path.includes("\0")) throw new WorkspaceError("empty or invalid path");
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("~"))
      throw new WorkspaceError(`use a path relative to the project root, not ${path}`);
    // A backslash is a legal filename character here, but in a path it's a Windows separator by mistake.
    if (sep === "/" && path.includes("\\")) throw new WorkspaceError(`use forward slashes in paths: ${path}`);
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new WorkspaceError(`${path} is outside the project`);
    // Follow symlinks for anything that exists, so a link can't point out of the project.
    let real = abs;
    if (existsSync(abs)) real = realpathSync(abs);
    else {
      let parent = abs;
      while (!existsSync(parent)) parent = resolve(parent, "..");
      real = join(realpathSync(parent), relative(parent, abs));
    }
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new WorkspaceError(`${path} points outside the project`);
    if (isSecretPath(abs)) throw new WorkspaceError(`${path} looks like a secrets file; the agent doesn't read or write those`);
    return abs;
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  readText(path: string): string {
    const abs = this.resolve(path);
    if (!existsSync(abs)) throw new WorkspaceError(`${path} does not exist`);
    const st = statSync(abs);
    if (st.isDirectory()) throw new WorkspaceError(`${path} is a directory`);
    if (st.size > 2_000_000) throw new WorkspaceError(`${path} is ${Math.round(st.size / 1e6)} MB; too large to read`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new WorkspaceError(`${path} is a binary file`);
    return buf.toString("utf8");
  }

  private ignoredByParentCache?: Promise<boolean>;

  /**
   * True when the project sits inside a git repository whose .gitignore excludes
   * it (a scratch folder in another repo, say). git and ripgrep would then hide
   * every file, so listing and search must skip the enclosing repo's rules.
   */
  private ignoredByParent(): Promise<boolean> {
    this.ignoredByParentCache ??= run("git", ["check-ignore", "-q", "."], { cwd: this.root }).then(
      () => true,
      () => false,
    );
    return this.ignoredByParentCache;
  }

  /** Project files, honouring .gitignore when the project is a git repository. */
  async listFiles(limit = 2000): Promise<string[]> {
    let files: string[] | undefined;
    try {
      if (await this.ignoredByParent()) {
        try {
          const { stdout } = await run("rg", ["--files", "--hidden", "--no-ignore-parent", "--no-require-git", "-g", "!.git/", "-0"], {
            cwd: this.root,
            maxBuffer: 64 * 1024 * 1024,
          });
          files = stdout.split("\0").filter(Boolean);
        } catch (err) {
          if ((err as { code?: number | string }).code !== "ENOENT") throw err;
          files = await this.listStandalone(); // no ripgrep on this machine
        }
      } else {
        const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          cwd: this.root,
          maxBuffer: 64 * 1024 * 1024,
        });
        files = stdout.split("\0").filter(Boolean);
      }
    } catch (err) {
      // ripgrep exits 1 when there is nothing to list.
      files = (err as { code?: number }).code === 1 ? [] : undefined;
    }
    if (!files) files = this.walk();
    return files
      .filter((f) => !isSecretPath(f) && !f.split("/").some((part) => SKIP_DIRS.has(part)))
      .filter((f) => existsSync(join(this.root, f)))
      .sort()
      .slice(0, limit);
  }

  /**
   * The project's files by its own .gitignore files only, without ripgrep: git is pointed at an
   * empty repository with the project as its work tree, so no enclosing repository's rules apply.
   */
  private async listStandalone(): Promise<string[]> {
    const gitDir = mkdtempSync(join(tmpdir(), "kovach-list-"));
    try {
      await run("git", ["init", "-q", "--bare", gitDir]);
      const { stdout } = await run("git", ["--git-dir", gitDir, "--work-tree", this.root, "ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: this.root,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.split("\0").filter(Boolean);
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  }

  private walk(): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= 20_000) return;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name));
        } else if (entry.isFile()) out.push(this.rel(join(dir, entry.name)));
      }
    };
    visit(this.root);
    return out;
  }

  /** Regex search over project files: ripgrep when installed, a JS fallback otherwise. */
  async search(pattern: string, options: { glob?: string; limit?: number } = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 200;
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new WorkspaceError(`invalid regular expression: ${err instanceof Error ? err.message : err}`);
    }
    try {
      const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", "20", "--max-columns", "300", "-g", "!.env*"];
      // Same exclusions as listFiles, also when there is no .gitignore to tell ripgrep.
      for (const d of SKIP_DIRS) args.push("-g", `!${d}/`);
      if (await this.ignoredByParent()) args.push("--no-ignore-parent", "--no-require-git");
      if (options.glob) args.push("-g", options.glob);
      args.push("-e", pattern, ".");
      const { stdout } = await run("rg", args, { cwd: this.root, maxBuffer: 32 * 1024 * 1024 });
      return parseRg(stdout).filter((h) => !isSecretPath(h.path)).slice(0, limit);
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string };
      if (e.code === 1) return []; // ripgrep: no matches
      if (e.code !== "ENOENT") throw new WorkspaceError(`search failed: ${err instanceof Error ? err.message : err}`);
    }
    // Fallback without ripgrep.
    const re = new RegExp(pattern);
    const glob = options.glob ? globToRegExp(options.glob) : undefined;
    const hits: SearchHit[] = [];
    for (const f of await this.listFiles(20_000)) {
      if (glob && !glob.test(f) && !glob.test(basename(f))) continue;
      let text: string;
      try {
        text = this.readText(f);
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (hits.length < limit && re.test(line)) hits.push({ path: f, line: i + 1, text: line.slice(0, 300) });
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

function parseRg(stdout: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m) hits.push({ path: m[1]!.replace(/^\.\//, ""), line: Number(m[2]), text: m[3]! });
  }
  return hits;
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}
