/**
 * Stock photos for pages the agent builds (MASTER_PLAN › Agent quality). Searches Openverse
 * (openly licensed images, no account or key), downloads the pictures into the project and
 * returns what the page needs: the file, its size, alt text and the credit line the licence
 * asks for. Only offered when the user has turned web access on.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

export interface PhotoConfig {
  fetch?: typeof fetch;
  /** Scale a downloaded picture down and re-encode it as JPEG. Without it the original is kept. */
  resize?: (image: Buffer, maxWidth: number) => Promise<{ data: Buffer; width: number; height: number } | undefined>;
  /** Search endpoint, for tests. */
  endpoint?: string;
}

export interface FoundPhoto {
  title: string;
  creator: string;
  license: string;
  url: string;
  page: string;
  width: number;
  height: number;
  /** Where the search engine found it (stocksnap, rawpixel, flickr…). */
  source?: string;
  /** Title and tags, lower-cased words: what the picture is said to show. */
  words?: string[];
}

const ENDPOINT = "https://api.openverse.org/v1/images/";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_WIDTH = 1600;
const AGENT = "LocalKovach/1.0 (desktop coding agent; photo search)";

/** Licences that allow use on a business's page. Attribution is still owed for "by" licences. */
const licenceName = (code: string, version: string) => (code === "cc0" ? "CC0" : code === "pdm" ? "Public domain" : `CC ${code.toUpperCase()}${version ? ` ${version}` : ""}`);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const wordsOf = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2);

/** Sources in the catalogue that are stock-photo libraries (free to use, made to be used on pages). */
const STOCK_SOURCES = "stocksnap,rawpixel";
/** Archive and museum scans, artwork and portraits turn up beside stock photos; they don't belong on a business's page. */
const NOT_STOCK = /\b(vintage|museum|archives?|library ?of ?congress|smithsonian|nypl|historic(al)?|illustration|painting|drawing|engraving|portrait|inscribed|poster|1[89]\d\d)\b/i;

interface Candidate extends FoundPhoto {
  /** How many of the words asked for appear in the photo's title and tags. */
  matched: number;
  stock: boolean;
}

async function searchOnce(query: string, wanted: string[], cfg: PhotoConfig, signal?: AbortSignal): Promise<Candidate[]> {
  // Public domain and attribution-only licences: the photos are resized and cropped, which share-alike and
  // no-derivatives licences restrict.
  const params = new URLSearchParams({ q: query, license: "cc0,pdm,by", category: "photograph", source: STOCK_SOURCES, mature: "false", page_size: "20" });
  const ask = () => (cfg.fetch ?? fetch)(`${cfg.endpoint ?? ENDPOINT}?${params}`, { ...(signal ? { signal } : {}), headers: { "user-agent": AGENT, accept: "application/json" } });
  let res = await ask();
  // The search answers 5xx now and then under load; one more try usually gets through.
  if (res.status >= 500 && !signal?.aborted) res = await ask();
  if (res.status === 429) throw new Error("the photo search is rate-limited right now");
  if (!res.ok) throw new Error(`the photo search returned ${res.status}`);
  const body = (await res.json()) as { results?: Record<string, unknown>[] };
  return (body.results ?? []).map((r) => {
    const tags = Array.isArray(r.tags) ? r.tags.map((t) => str((t as { name?: unknown })?.name)).join(" ") : "";
    const described = `${str(r.title)} ${tags}`;
    // Who published it says as much as the title: a library or museum account posts scans, not stock photos.
    const origin = `${described} ${str(r.creator)}`;
    const has = new Set(wordsOf(described));
    // "loaves" asked for, "loaf" or "loaves" tagged: plurals count, look-alike words ("bakeri") don't.
    const matched = wanted.filter((w) => has.has(w) || has.has(`${w}s`) || (w.endsWith("s") && has.has(w.slice(0, -1)))).length;
    return {
      title: str(r.title),
      creator: str(r.creator),
      license: licenceName(str(r.license), str(r.license_version)),
      url: str(r.url),
      page: str(r.foreign_landing_url),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      matched,
      stock: !NOT_STOCK.test(origin),
    };
  });
}

const MAX_SEARCHES = 6;

/**
 * Photos for a query, most fitting first. The catalogue matches every word, so a long
 * description finds nothing: the query is tried whole, then as pairs of its words, then word by
 * word, within a small budget of requests. A result only counts when its title and tags name at
 * least two of the words asked for (one, for a one-word query): a shorter search must not
 * bring in something else entirely.
 */
export async function searchPhotos(query: string, orientation: "wide" | "tall" | "square", cfg: PhotoConfig = {}, signal?: AbortSignal, want = 1): Promise<FoundPhoto[]> {
  const words = wordsOf(query).slice(0, 4);
  if (words.length === 0) return [];
  const need = Math.min(2, words.length);
  const [a, b, c] = words;
  const queries = [...new Set([words.slice(0, 3).join(" "), b && `${a} ${b}`, c && `${b} ${c}`, c && `${a} ${c}`, b, a].filter((q): q is string => !!q))];
  const found: Candidate[] = [];
  let failure: unknown;
  for (const q of queries.slice(0, MAX_SEARCHES)) {
    let hits: Candidate[];
    try {
      hits = await searchOnce(q, words, cfg, signal);
    } catch (err) {
      // One wording failing must not lose the photos the other wordings would find.
      failure = err;
      continue;
    }
    for (const p of hits) {
      if (p.matched < need || p.width < 1000 || !/^https:\/\//.test(p.url) || !/\.(jpe?g|png|webp)(\?|$)/i.test(p.url)) continue;
      if (!found.some((f) => f.url === p.url || (f.title && f.title === p.title))) found.push(p);
    }
    if (found.filter((p) => p.stock).length >= want) break;
  }
  if (found.length === 0 && failure) throw failure;
  const fits = (p: Candidate) => (orientation === "tall" ? p.height > p.width : orientation === "wide" ? p.width > p.height : true);
  return found
    .filter((p) => p.stock)
    .sort((x, y) => y.matched - x.matched || Number(fits(y)) - Number(fits(x)))
    .map(({ matched: _m, stock: _s, ...photo }) => photo);
}

const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "photo";

export interface SavedPhoto {
  /** Project-relative path of the saved file. */
  path: string;
  abs: string;
  width: number;
  height: number;
  alt: string;
  credit: string;
}

/** Search, download up to `count` photos into `folder` and note their credits. Throws when the search itself fails. */
export async function savePhotos(query: string, count: number, orientation: "wide" | "tall" | "square", folder: string, cfg: PhotoConfig, ctx: ToolContext): Promise<SavedPhoto[]> {
  const dir = folder.replace(/\/+$/, "");
  // A photo already on the page isn't used twice: the credits file lists where each came from.
  const creditsFile = ctx.workspace.resolve(`${dir}/CREDITS.md`);
  const have = existsSync(creditsFile) ? readFileSync(creditsFile, "utf8") : "";
  const found = (await searchPhotos(query, orientation, cfg, ctx.signal, count + 4)).filter((p) => !p.page || !have.includes(p.page));
  const saved: SavedPhoto[] = [];
  for (const p of found) {
    if (saved.length >= count) break;
    try {
      const res = await (cfg.fetch ?? fetch)(p.url, { ...(ctx.signal ? { signal: ctx.signal } : {}), headers: { "user-agent": AGENT } });
      if (!res.ok) continue;
      let data: Buffer = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_BYTES || data.length < 2000) continue;
      let { width, height } = p;
      let ext = (/\.(jpe?g|png|webp)(\?|$)/i.exec(p.url)?.[1] ?? "jpg").toLowerCase().replace("jpeg", "jpg");
      const small = cfg.resize ? await cfg.resize(data, MAX_WIDTH) : undefined;
      if (small) {
        ({ data, width, height } = small);
        ext = "jpg";
      }
      let rel = `${dir}/${slug(query)}-${saved.length + 1}.${ext}`;
      for (let n = 2; existsSync(ctx.workspace.resolve(rel)); n++) rel = `${dir}/${slug(query)}-${saved.length + 1}-${n}.${ext}`;
      const abs = ctx.workspace.resolve(rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      ctx.createdThisRun?.add(ctx.workspace.rel(abs));
      const credit = `${p.title || "Photo"}${p.creator ? ` by ${p.creator}` : ""} (${p.license})`;
      const creditsAbs = ctx.workspace.resolve(`${dir}/CREDITS.md`);
      const before = existsSync(creditsAbs) ? readFileSync(creditsAbs, "utf8") : "# Photo credits\n\n";
      writeFileSync(creditsAbs, `${before}- ${rel}: ${credit}${p.page ? `, ${p.page}` : ""}\n`, "utf8");
      saved.push({ path: rel, abs, width, height, alt: query, credit });
    } catch {
      // this one didn't download; try the next
    }
  }
  return saved;
}

export function photoTools(cfg: PhotoConfig = {}): AgentTool[] {
  const find: AgentTool = {
    name: "find_photos",
    description:
      "Find free stock photos for a page and save them into the project (assets/). Returns each file's path, size, alt text and credit line. Use specific queries that name the subject (\"sourdough loaves on a bakery shelf\"), one call per place on the page.",
    schema: z.object({
      query: z.string().min(2).describe("What the photo shows"),
      count: z.number().int().min(1).max(4).default(1),
      orientation: z.enum(["wide", "tall", "square"]).default("wide").describe("wide for a section or gallery, tall for a hero column"),
      folder: z.string().default("assets"),
    }),
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const a = args as { query: string; count: number; orientation: "wide" | "tall" | "square"; folder: string };
      let photos: SavedPhoto[];
      try {
        photos = await savePhotos(a.query, a.count, a.orientation, a.folder, cfg, ctx);
      } catch (e) {
        return { ok: false, content: `No photos: ${(e as Error).message}. Leave a labelled photo place (figure.photo with a photo__label) and tell the user which pictures are missing.` };
      }
      if (photos.length === 0) return { ok: false, content: `No usable photos for "${a.query}". Try a simpler query (two or three words), or leave a labelled photo place.` };
      const files = photos.map((p) => p.abs);
      const saved = photos.map((p) => `- ${p.path} (${p.width}×${p.height}): alt="${p.alt.replace(/"/g, "'")}". Credit: ${p.credit}`);
      return {
        ok: true,
        edited: true,
        files,
        content: `Saved ${saved.length} photo${saved.length === 1 ? "" : "s"}:\n${saved.join("\n")}\n\nUse each as <img src="…" alt="…" width="…" height="…" loading="lazy"> inside a figure.photo (no loading="lazy" on the hero picture). Put the credits in the footer's .credits line. The search matches words, not meaning: you'll see the page before finishing, so replace a photo that doesn't fit.`,
      };
    },
  } as AgentTool;
  return [find];
}
