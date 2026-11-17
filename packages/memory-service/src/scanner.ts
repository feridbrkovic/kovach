/**
 * Project scanner (MASTER_PLAN › Write path, "Project scan"). Reads the
 * manifests of a project and builds its card: languages, stack and versions,
 * package manager and checks. Computed, never stored as a memory; cached and
 * rebuilt only when a manifest changes.
 */
import { createHash } from "node:crypto";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface ProjectCard {
  name: string;
  languages: string[];
  /** Frameworks and key libraries with versions, most important first, e.g. "React Native 0.76". */
  stack: string[];
  /** Every dependency version the scanner saw (library → version), for version checks. "node" is the Node.js version. */
  versions: Record<string, string>;
  /** Keys of `versions` that make up the stack (frameworks and key libraries). */
  stackLibraries?: string[];
  packageManager?: string;
  /** Scripts that look like checks: typecheck, lint, test, build. */
  checks: string[];
  manifests: string[];
}

const MANIFESTS = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "tsconfig.json",
  "app.json",
  "composer.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  ".nvmrc",
  ".node-version",
];

/** WordPress core, the WooCommerce plugin, and theme/plugin readme headers, where they usually are. */
const WP_FILES = ["wp-includes/version.php", "wp-content/plugins/woocommerce/woocommerce.php", "style.css", "readme.txt"];

/** The first few KB of a file: WordPress headers sit at the top. */
function head(path: string, bytes = 8192): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** WordPress files in a project: the known ones plus a plugin's main file (a top-level .php with a "Plugin Name:" header). */
function wordpressFiles(root: string): string[] {
  const found = WP_FILES.filter((f) => existsSync(join(root, f)));
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => n.endsWith(".php")).slice(0, 30);
  } catch {
    // unreadable folder
  }
  for (const n of names) if (/^[ \t/*#@]*Plugin Name:/im.test(head(join(root, n), 4096))) found.push(n);
  return found;
}

/** A header line value, e.g. "Tested up to: 6.7" from a theme's style.css or a plugin's readme. */
const header = (text: string, name: string) => new RegExp(`^[ \\t/*#@]*${name}:[ \\t]*([\\d][\\d.]*)`, "im").exec(text)?.[1];

/**
 * WordPress, WooCommerce and PHP versions of a WordPress site, theme or plugin:
 * core's version.php, the WooCommerce plugin's own header, else what the theme or
 * plugin says it's tested with ("Tested up to", "WC tested up to", "Requires PHP").
 */
export function wordpressVersions(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const core = /\$wp_version\s*=\s*'([\d.]+)'/.exec(head(join(root, "wp-includes/version.php"), 4096))?.[1];
  if (core) out.wordpress = core;
  const woo = header(head(join(root, "wp-content/plugins/woocommerce/woocommerce.php")), "Version");
  if (woo) out.woocommerce = woo;
  for (const f of wordpressFiles(root)) {
    if (f.startsWith("wp-")) continue;
    const text = head(join(root, f));
    const found = {
      wordpress: header(text, "Tested up to") ?? header(text, "Requires at least"),
      woocommerce: header(text, "WC tested up to") ?? header(text, "WC requires at least"),
      php: header(text, "Requires PHP"),
    };
    for (const [k, v] of Object.entries(found)) if (v && !out[k]) out[k] = v;
  }
  return out;
}

/** Composer packages that are WordPress or WooCommerce themselves. */
const COMPOSER_ALIASES: Record<string, string> = {
  "johnpbloch/wordpress": "wordpress",
  "johnpbloch/wordpress-core": "wordpress",
  "roots/wordpress": "wordpress",
  "roots/wordpress-no-content": "wordpress",
  "wpackagist-plugin/woocommerce": "woocommerce",
  "woocommerce/woocommerce": "woocommerce",
};

/** Libraries worth naming on the card, in display order. */
export const KEY_LIBS: [string, string][] = [
  ["react-native", "React Native"],
  ["expo", "Expo SDK"],
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["nuxt", "Nuxt"],
  ["svelte", "Svelte"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@angular/core", "Angular"],
  ["electron", "Electron"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["typescript", "TypeScript"],
  ["vite", "Vite"],
  ["tailwindcss", "Tailwind CSS"],
  ["prisma", "Prisma"],
  ["zustand", "Zustand"],
  ["@reduxjs/toolkit", "Redux Toolkit"],
  ["@tanstack/react-query", "TanStack Query"],
  ["laravel/framework", "Laravel"],
  ["wordpress", "WordPress"],
  ["woocommerce", "WooCommerce"],
  ["symfony/framework-bundle", "Symfony"],
  ["php", "PHP"],
  ["django", "Django"],
  ["fastapi", "FastAPI"],
  ["flask", "Flask"],
];

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/^[\^~>=<v\s]+/, "").split(/\s|\|/)[0] ?? v : undefined);

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A hash of the manifest files' contents: the card is rebuilt when it changes. */
export function manifestHash(root: string): string {
  const h = createHash("sha256");
  for (const f of [...MANIFESTS, ...wordpressFiles(root)]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    h.update(f);
    try {
      // Lockfiles can be large; their size and head are enough to notice an upgrade.
      const buf = readFileSync(p);
      h.update(buf.length > 256_000 ? Buffer.concat([buf.subarray(0, 128_000), Buffer.from(String(buf.length))]) : buf);
    } catch {
      // unreadable: ignore
    }
  }
  return h.digest("hex");
}

export function scanProject(root: string, name: string): ProjectCard {
  const manifests = MANIFESTS.filter((f) => existsSync(join(root, f)));
  const versions: Record<string, string> = {};
  const languages = new Set<string>();
  const checks: string[] = [];
  let packageManager: string | undefined;

  const pkg = readJson(join(root, "package.json"));
  if (pkg) {
    languages.add("JavaScript");
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object") {
        for (const [lib, v] of Object.entries(deps as Record<string, unknown>)) {
          const c = clean(v);
          if (c && /^\d/.test(c) && !(lib in versions)) versions[lib] = c;
        }
      }
    }
    if ("typescript" in versions || manifests.includes("tsconfig.json")) languages.add("TypeScript");
    const pm = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    packageManager =
      pm ??
      (manifests.includes("pnpm-lock.yaml")
        ? "pnpm"
        : manifests.includes("yarn.lock")
          ? "yarn"
          : manifests.includes("bun.lockb")
            ? "bun"
            : manifests.includes("package-lock.json")
              ? "npm"
              : undefined);
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts as object) : [];
    for (const s of ["typecheck", "lint", "test", "build"]) if (scripts.includes(s)) checks.push(s);
    // Node.js itself: .nvmrc / .node-version, then engines, then @types/node.
    const pinned = [".nvmrc", ".node-version"].map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8").trim() : "")).find(Boolean);
    const engines = (pkg.engines as { node?: string } | undefined)?.node;
    const nodeV = [clean(pinned), clean(engines), versions["@types/node"]].find((v) => !!v && /^\d/.test(v));
    if (nodeV) versions.node = nodeV;
  }

  const app = readJson(join(root, "app.json"));
  const sdk = (app?.expo as { sdkVersion?: string } | undefined)?.sdkVersion;
  if (sdk && !versions.expo) versions.expo = sdk;

  const composer = readJson(join(root, "composer.json"));
  if (composer) {
    languages.add("PHP");
    packageManager ??= "composer";
    for (const field of ["require", "require-dev"]) {
      const deps = composer[field];
      if (deps && typeof deps === "object") {
        for (const [lib, v] of Object.entries(deps as Record<string, unknown>)) {
          const c = clean(v);
          if (c && /^\d/.test(c) && !(lib in versions)) versions[lib] = c;
          const alias = COMPOSER_ALIASES[lib];
          if (alias && c && /^\d/.test(c) && !(alias in versions)) versions[alias] = c;
        }
      }
    }
    const scripts = composer.scripts && typeof composer.scripts === "object" ? Object.keys(composer.scripts as object) : [];
    if (scripts.includes("test") && !checks.includes("test")) checks.push("test");
  }

  // A WordPress site, theme or plugin (with or without composer.json).
  const wp = wordpressVersions(root);
  for (const [lib, v] of Object.entries(wp)) if (!(lib in versions)) versions[lib] = v;
  if (Object.keys(wp).length) languages.add("PHP");

  if (manifests.includes("pyproject.toml") || manifests.includes("requirements.txt")) {
    languages.add("Python");
    const req = existsSync(join(root, "requirements.txt")) ? readFileSync(join(root, "requirements.txt"), "utf8") : "";
    for (const line of req.split("\n")) {
      const m = /^([A-Za-z0-9_.-]+)\s*[=~>]=\s*([\d.]+)/.exec(line.trim());
      if (m && !(m[1]!.toLowerCase() in versions)) versions[m[1]!.toLowerCase()] = m[2]!;
    }
  }
  if (manifests.includes("Cargo.toml")) languages.add("Rust");
  if (manifests.includes("go.mod")) languages.add("Go");
  if (manifests.includes("Gemfile")) languages.add("Ruby");

  const stackLibs = KEY_LIBS.filter(([lib]) => versions[lib]);
  const stack = stackLibs.map(([lib, label]) => `${label} ${versions[lib]}`);
  return {
    name,
    languages: [...languages],
    stack,
    versions,
    stackLibraries: stackLibs.map(([lib]) => lib),
    ...(packageManager ? { packageManager } : {}),
    checks,
    manifests,
  };
}

/** One or two lines for the always-on block. */
export function renderCard(card: ProjectCard): string {
  const parts = [`Project ${card.name}`];
  if (card.stack.length) parts.push(`stack: ${card.stack.slice(0, 8).join(", ")}`);
  else if (card.languages.length) parts.push(`languages: ${card.languages.join(", ")}`);
  if (card.packageManager) parts.push(`package manager: ${card.packageManager}`);
  if (card.checks.length) parts.push(`checks: ${card.checks.join(", ")}`);
  return `${parts.join("; ")}.`;
}

/** The part of a version that signals breaking changes: the major, or major.minor for 0.x (semver). */
const breaking = (v: string) => {
  const [maj = v, min = "0"] = v.replace(/^[^\d]*/, "").split(".");
  return maj === "0" ? `0.${min}` : maj;
};

/** True when a fact bound to library versions targets a different breaking version than the project uses. */
export function isOutdated(bound: Record<string, string> | undefined, project: Record<string, string>): { outdated: boolean; detail?: string } {
  if (!bound) return { outdated: false };
  for (const [lib, v] of Object.entries(bound)) {
    const have = project[lib];
    if (have !== undefined && breaking(have) !== breaking(v)) return { outdated: true, detail: `${lib} ${v} vs ${have} in this project` };
  }
  return { outdated: false };
}
