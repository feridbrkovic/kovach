import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CheckKind = "typecheck" | "lint" | "test";

export interface Check {
  kind: CheckKind;
  /** Shell command run from the project root. */
  command: string;
}

/** The placeholder `npm init` writes; it is not a real test script. */
const NPM_PLACEHOLDER = /no test specified/;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function packageRunner(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun run";
  return "npm run";
}

/**
 * Find the project's own checks (MASTER_PLAN.md › Agent quality, item 1):
 * typecheck, lint and test from package.json scripts, a bare `tsc` when there
 * is a tsconfig but no script, and composer scripts or phpunit for PHP.
 * Order: typecheck, lint, test (fast to slow).
 */
export function detectChecks(root: string): Check[] {
  const checks: Check[] = [];
  const add = (kind: CheckKind, command: string) => {
    if (!checks.some((c) => c.kind === kind)) checks.push({ kind, command });
  };

  const pkg = readJson(join(root, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const runner = packageRunner(root);
    const pick = (names: string[]) => names.find((n) => typeof scripts[n] === "string" && !NPM_PLACEHOLDER.test(scripts[n]!));
    const tc = pick(["typecheck", "type-check", "check-types", "tsc"]);
    if (tc) add("typecheck", `${runner} ${tc}`);
    else if (existsSync(join(root, "tsconfig.json"))) {
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
      if (deps.typescript) add("typecheck", "npx --no-install tsc --noEmit");
    }
    const lint = pick(["lint"]);
    if (lint) add("lint", `${runner} ${lint}`);
    const test = pick(["test", "test:unit"]);
    if (test) add("test", runner === "npm run" ? "npm test" : `${runner} ${test}`);
  }

  const composer = readJson(join(root, "composer.json"));
  if (composer) {
    const scripts = (composer.scripts ?? {}) as Record<string, unknown>;
    if (scripts.phpstan || scripts.analyse) add("typecheck", `composer ${scripts.phpstan ? "phpstan" : "analyse"}`);
    if (scripts.lint) add("lint", "composer lint");
    if (scripts.test) add("test", "composer test");
    else if (existsSync(join(root, "vendor", "bin", "phpunit"))) add("test", "vendor/bin/phpunit");
  }

  const order: CheckKind[] = ["typecheck", "lint", "test"];
  return checks.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
