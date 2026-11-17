/**
 * Web search and page fetch for the agent (MASTER_PLAN › Web search).
 *
 * `webTools` exposes `web_search` and `fetch_page` to the model. The HTTP work
 * is `webSearch`/`webFetch` against a SearXNG instance when the user runs one,
 * otherwise a keyless DuckDuckGo HTML fallback. These tools are NOT in the
 * default TOOLS list; the desktop app adds them only when web access is on.
 */
import { z } from "zod";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebConfig {
  /** SearXNG base URL, e.g. "http://127.0.0.1:8888". Empty = keyless fallback. */
  searxngUrl?: string;
  maxResults?: number;
  maxPageChars?: number;
  fetch?: typeof fetch;
}

/** Block localhost, link-local and private ranges (SSRF guard for fetch_page). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

const entities = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");

/** Strip tags to readable text: <br> and block closers become newlines; blank lines dropped. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol)>/gi, "\n");
  return entities(withBreaks.replace(/<[^>]+>/g, ""))
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Parse a DuckDuckGo HTML results page, unwrapping the /l/?uddg= redirect links. */
export function parseDuckDuckGo(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  for (let m = re.exec(html); m && out.length < 20; m = re.exec(html)) {
    let url = entities(m[1]!);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    out.push({ title: htmlToText(m[2]!), url, snippet: "" });
  }
  const sre = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gis;
  let i = 0;
  for (let m = sre.exec(html); m && i < out.length; m = sre.exec(html)) out[i++]!.snippet = htmlToText(m[1]!);
  return out;
}

async function searxng(cfg: WebConfig, query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const doFetch = cfg.fetch ?? fetch;
  const res = await doFetch(`${cfg.searxngUrl!.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`, {
    ...(signal ? { signal } : {}),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).filter((r) => r.url).map((r) => ({ title: r.title ?? r.url!, url: r.url!, snippet: r.content ?? "" }));
}

export async function webSearch(query: string, cfg: WebConfig = {}, signal?: AbortSignal): Promise<WebSearchResult[]> {
  let results: WebSearchResult[];
  if (cfg.searxngUrl) {
    results = await searxng(cfg, query, signal);
  } else {
    const doFetch = cfg.fetch ?? fetch;
    const res = await doFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      ...(signal ? { signal } : {}),
      headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
    });
    if (!res.ok) throw new Error(`search returned ${res.status}`);
    results = parseDuckDuckGo(await res.text());
  }
  const seen = new Set<string>();
  const unique = results.filter((r) => !seen.has(r.url) && seen.add(r.url));
  // Official sources first, in the engine's own order within each group.
  return [...unique.filter((r) => isOfficialSource(r.url)), ...unique.filter((r) => !isOfficialSource(r.url))].slice(0, cfg.maxResults ?? 6);
}

/** Sites that are the primary source for a language, platform or widely used library, or a standards body. */
const OFFICIAL_HOSTS = [
  "developer.mozilla.org", "w3.org", "whatwg.org", "web.dev", "tc39.es", "ecma-international.org",
  "nodejs.org", "npmjs.com", "typescriptlang.org", "react.dev", "reactnative.dev", "expo.dev", "nextjs.org", "vite.dev", "vitejs.dev", "vuejs.org", "svelte.dev", "angular.dev", "tailwindcss.com", "gsap.com", "threejs.org", "electronjs.org",
  "php.net", "wordpress.org", "woocommerce.com", "woocommerce.github.io", "laravel.com", "symfony.com", "getcomposer.org",
  "python.org", "djangoproject.com", "fastapi.tiangolo.com", "palletsprojects.com", "go.dev", "rust-lang.org", "kotlinlang.org", "swift.org",
  "developer.apple.com", "developer.android.com", "learn.microsoft.com", "docs.github.com", "git-scm.com", "docker.com", "kubernetes.io", "postgresql.org", "mysql.com", "sqlite.org", "redis.io", "mongodb.com",
  "developers.google.com", "schema.org", "stripe.com", "cloudflare.com",
];

export function isOfficialSource(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return OFFICIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export async function webFetch(target: string, cfg: WebConfig = {}, signal?: AbortSignal): Promise<{ title: string; text: string }> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  if (isPrivateHost(url.hostname)) throw new Error("refusing to fetch a local or private address");
  const doFetch = cfg.fetch ?? fetch;
  const res = await doFetch(url.toString(), {
    ...(signal ? { signal } : {}),
    headers: { "user-agent": "Mozilla/5.0 (compatible; LocalKovach)", accept: "text/html,*/*" },
  });
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? htmlToText(titleMatch[1]!) : url.hostname;
  return { title, text: htmlToText(html) };
}

/** Searches one task may make. Seen live: a run spent its steps searching the same thing in new words. */
export const MAX_SEARCHES = 6;
const words = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].sort().join(" ");

export function webTools(cfg: WebConfig = {}): AgentTool[] {
  const maxChars = cfg.maxPageChars ?? 12000;
  // Per task: each run has its own tool context.
  const searched = new WeakMap<ToolContext, string[]>();
  const clamp = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}\n… [truncated]` : s);
  const search: AgentTool = {
    name: "web_search",
    description:
      "Search the web for current information (library docs, error messages, versions, how-tos). Returns a numbered list of title, URL and snippet. Use fetch_page to read a result.",
    schema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const a = args as { query: string; limit?: number };
      const done = searched.get(ctx) ?? [];
      if (done.includes(words(a.query))) {
        return { ok: false, content: "You already ran this search (same words) in this task. Use those results, fetch_page one of them, or get on with the work." };
      }
      if (done.length >= MAX_SEARCHES) {
        return { ok: false, content: `That's ${MAX_SEARCHES} searches in this task, the limit. Use what you found (fetch_page a result if you need more detail) and do the work now; say in your answer if something is still unknown.` };
      }
      searched.set(ctx, [...done, words(a.query)]);
      const results = await webSearch(a.query, { ...cfg, ...(a.limit ? { maxResults: a.limit } : {}) }, ctx.signal);
      if (results.length === 0) return { ok: true, content: `No results for "${a.query}".` };
      return { ok: true, content: results.map((r, i) => `${i + 1}. ${isOfficialSource(r.url) ? "[official] " : ""}${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n") };
    },
  } as AgentTool;
  const fetchPage: AgentTool = {
    name: "fetch_page",
    description: "Fetch a web page and return it as readable text. Use after web_search, or a URL you already have. Local and private addresses are refused.",
    schema: z.object({ url: z.string().url() }),
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const { url } = args as { url: string };
      const { title, text } = await webFetch(url, cfg, ctx.signal);
      return { ok: true, content: `# ${title}\n${url}\n\n${clamp(text)}` };
    },
  } as AgentTool;
  return [search, fetchPage];
}
