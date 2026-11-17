/**
 * Project seeding (MASTER_PLAN › Docs packs and project seeding): once per
 * project, conventions written down in agent and contributor files become
 * proposals in the review inbox. Deterministic, no LLM; nothing is trusted
 * until the user accepts it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanSecrets } from "./secrets.js";

export interface SeedItem {
  /** File the item came from, relative to the project root. */
  file: string;
  heading: string;
  text: string;
}

/** Files written for agents: every bullet counts. */
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md", "CONVENTIONS.md", "docs/CONVENTIONS.md", ".clinerules"];
/** Files written for people: only sections about how to write code. */
const HUMAN_FILES = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "README.md"];
const RELEVANT_HEADING = /convention|style|guideline|coding|code (standards?|quality)|rules|best practice|development|contribut|naming|testing|commit/i;
const SKIP_HEADING = /licen[cs]e|sponsor|acknowledg|changelog|credits|badges|screenshots|table of contents|support|contact|authors?/i;
const MAX_ITEMS = 40;
const MAX_FILE_BYTES = 200_000;

const clean = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

function readSmall(path: string): string | undefined {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Bullet and numbered items, nested ones folded into their parent. */
export function extractItems(text: string, file: string, onlyRelevant: boolean): SeedItem[] {
  const out: SeedItem[] = [];
  const headings: string[] = [];
  let inFence = false;
  let frontmatter = text.startsWith("---");
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    if (frontmatter) {
      if (lineNo > 1 && raw.trim() === "---") frontmatter = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(raw);
    if (h) {
      headings.length = h[1]!.length - 1;
      headings[h[1]!.length - 1] = clean(h[2]!);
      continue;
    }
    const b = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!b) continue;
    const heading = headings.filter(Boolean).join(" › ");
    if (onlyRelevant && !RELEVANT_HEADING.test(heading)) continue;
    if (SKIP_HEADING.test(heading)) continue;
    const textPart = clean(b[2]!.replace(/^\[[ xX]\]\s*/, ""));
    const nested = b[1]!.replace(/\t/g, "  ").length >= 2;
    if (nested && out.length && out.at(-1)!.file === file && out.at(-1)!.heading === heading) {
      const prev = out.at(-1)!;
      if (prev.text.length + textPart.length < 300) prev.text = `${prev.text.replace(/[.:;]$/, "")}; ${textPart}`;
      continue;
    }
    out.push({ file, heading, text: textPart });
  }
  return out.filter((i) => i.text.length >= 12 && i.text.length <= 300 && /[a-z]{3}/i.test(i.text) && scanSecrets(i.text).length === 0);
}

/** Everything worth proposing from a project's own files, agent files first. */
export function findConventions(root: string): SeedItem[] {
  const items: SeedItem[] = [];
  const cursorRules = join(root, ".cursor", "rules");
  const ruleFiles = existsSync(cursorRules)
    ? readdirSync(cursorRules)
        .filter((f) => /\.(mdc|md)$/.test(f))
        .map((f) => `.cursor/rules/${f}`)
    : [];
  for (const f of [...AGENT_FILES, ...ruleFiles]) {
    const text = readSmall(join(root, f));
    if (text) items.push(...extractItems(text, f, false));
  }
  for (const f of HUMAN_FILES) {
    const text = readSmall(join(root, f));
    if (text) items.push(...extractItems(text, f, true));
  }
  const seen = new Set<string>();
  return items
    .filter((i) => {
      const k = i.text.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_ITEMS);
}

const slug = (s: string, words: number) =>
  s
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.replace(/[^a-z0-9]+/gi, " "))
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, words)
    .join("-");
const STOP = new Set(["the", "and", "for", "with", "use", "always", "never", "not", "don", "you", "your", "are", "this", "that", "from", "when", "should", "must", "all", "any", "only", "into", "over", "than", "then", "make", "sure"]);
const SOURCE: Record<string, string> = { "AGENTS.md": "agents", "CLAUDE.md": "claude", ".cursorrules": "cursor", ".windsurfrules": "windsurf", ".clinerules": "cline", "README.md": "readme" };

/** A readable subject for an item, e.g. "claude.testing.run-pnpm-test". */
export function seedKey(item: SeedItem): string {
  const source = SOURCE[item.file] ?? (item.file.includes("copilot") ? "copilot" : item.file.includes("cursor") ? "cursor" : item.file.toLowerCase().includes("contributing") ? "contributing" : "conventions");
  const section = slug(item.heading.split(" › ").at(-1) ?? "", 2);
  const subject = slug(item.text, 4) || "item";
  return [source, section, subject].filter(Boolean).join(".");
}
