/**
 * Docs chunking (MASTER_PLAN › Write path, "Docs packs"): a Markdown or MDX
 * page becomes one chunk per section, with the heading path as context
 * ("Page › Section › Subsection"). Code blocks are never split. No LLM.
 */

export interface DocChunk {
  /** "Page title › Section › Subsection". */
  heading: string;
  text: string;
  /** Page URL plus the section anchor. */
  url: string;
}

const MAX_CHARS = 1800;
const MIN_CHARS = 60;

/** GitHub-style heading anchor. */
export function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Title from frontmatter, the first H1, or the file name. */
function titleOf(front: Record<string, string>, body: string, path: string): string {
  if (front.title) return front.title;
  if (front.sidebar_label) return front.sidebar_label;
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return cleanInline(h1[1]!);
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(mdx?|markdown)$/i, "").replace(/^\d+[-_]/, "").replace(/[-_]/g, " ");
}

const cleanInline = (s: string) => s.replace(/\{#[^}]*\}\s*$/, "").replace(/<[^>]+>/g, "").replace(/`/g, "").trim();

function parseFrontmatter(text: string): { front: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { front: {}, body: text };
  const front: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return { front, body: text.slice(m[0].length) };
}

/**
 * Remove what only renders on the docs site: MDX imports/exports, JSX wrapper
 * tags on their own lines, HTML comments and admonition markers. Text inside
 * components is kept; code blocks are left exactly as they are.
 */
function cleanBody(body: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!.slice(0, 3);
      else if (line.trim().startsWith(fence)) fence = undefined;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    if (/^\s*(import|export)\s.+(from\s+['"].+['"]|=)/.test(line)) continue;
    if (/^\s*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/.test(line)) continue; // <Tabs>, </TabItem>, <ConfigReactNative />
    if (/^\s*<\/?(div|details|summary|br|hr|img|figure|figcaption|span|p)(\s[^>]*)?\/?>\s*$/i.test(line)) continue;
    if (/^\s*:::\s*\w*/.test(line)) {
      const label = line.replace(/^\s*:::\s*/, "").trim();
      if (label) out.push(`**${label.charAt(0).toUpperCase()}${label.slice(1)}:**`);
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split a long section at paragraph breaks outside code blocks. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    cur.push(line);
    if (!inFence && line.trim() === "") {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur.join("\n"));
  const parts: string[] = [];
  let acc = "";
  for (const b of blocks) {
    if (acc && acc.length + b.length > MAX_CHARS) {
      parts.push(acc.trim());
      acc = "";
    }
    acc += b.endsWith("\n") ? b : `${b}\n`;
  }
  if (acc.trim()) parts.push(acc.trim());
  return parts;
}

/** Chunk one page. `pageUrl` is where a person can read it; anchors are added per section. */
export function chunkMarkdown(source: string, opts: { path: string; pageUrl: string }): DocChunk[] {
  const { front, body } = parseFrontmatter(source);
  const title = titleOf(front, body, opts.path);
  const text = cleanBody(body);

  const sections: { path: string[]; anchor?: string; lines: string[] }[] = [{ path: [title], lines: [] }];
  const stack: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      const level = h[1]!.length;
      const name = cleanInline(h[2]!);
      if (level === 1) continue; // the page title
      stack.length = Math.max(0, level - 2);
      stack[level - 2] = name;
      sections.push({ path: [title, ...stack.filter(Boolean)], anchor: anchorOf(name), lines: [] });
      continue;
    }
    sections.at(-1)!.lines.push(line);
  }

  const chunks: DocChunk[] = [];
  for (const s of sections) {
    const body = s.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body.replace(/\s+/g, " ").length < MIN_CHARS) continue;
    const url = s.anchor ? `${opts.pageUrl}#${s.anchor}` : opts.pageUrl;
    for (const part of splitLong(body)) {
      if (part.replace(/\s+/g, " ").length < MIN_CHARS) continue;
      chunks.push({ heading: s.path.join(" › "), text: part, url });
    }
  }
  return chunks;
}
