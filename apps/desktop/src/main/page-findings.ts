/**
 * What a browser can measure about a page the agent built, turned into plain findings the
 * agent reads next to the screenshots. Kept apart from the Electron code so it can be tested.
 */

/** Returned by MEASURE_SCRIPT, which runs inside the page. */
export interface PageMeasure {
  height: number;
  /** scrollWidth minus the viewport width; above zero the page scrolls sideways. */
  overflow: number;
  h1: number;
  imagesWithoutAlt: number;
  brokenImages: number;
  /** Elements with text that are still fully transparent after scrolling through the page. */
  invisibleText: number;
  title: string;
  hasDescription: boolean;
  hasOpenGraph: boolean;
  hasFavicon: boolean;
  unlabeledFields: number;
  /** Emoji shown large enough to be standing in for a picture or an icon. */
  emojiPictures?: number;
  /** Share (0 to 1) of headings and paragraphs that are centred. */
  centredShare?: number;
  /** Sections taller than most of the screen with little in them: what each is and how many empty pixels. */
  emptySections?: { name: string; empty: number }[];
  /** Length of the meta description, 0 when there is none. */
  descriptionLength?: number;
  hasCanonical?: boolean;
  hasStructuredData?: boolean;
  hasShareImage?: boolean;
  /** Headings that skip a level (an h3 right after an h1). */
  skippedHeadings?: number;
  /** Images without width and height attributes (they shift the layout as they load). */
  unsizedImages?: number;
  /** Links whose text says nothing about where they go ("click here", "read more"). */
  vagueLinks?: number;
}

/**
 * Scrolls through the page (so scroll-triggered content appears), returns to the top and measures.
 * A string, because it is evaluated in the page, not here.
 */
export const MEASURE_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = window.innerHeight || 800;
  const total = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  // Jump, don't glide: a page with scroll-behavior: smooth would never reach its lower sections in time.
  const jump = (y) => window.scrollTo({ top: y, left: 0, behavior: "instant" });
  for (let y = 0, i = 0; y < total() && i < 60; y += view * 0.8, i++) { jump(y); await wait(150); }
  jump(0);
  await wait(1400); // long enough for staggered scroll animations to finish
  const visibleText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const invisible = [...document.querySelectorAll("body *")].filter((el) => {
    if (!visibleText(el)) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) === 0;
  }).length;
  const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")];
  const unlabeled = fields.filter((f) => !(f.labels && f.labels.length) && !f.getAttribute("aria-label") && !f.getAttribute("aria-labelledby")).length;
  const imgs = [...document.images];
  const emojiOnly = /^(\\p{Extended_Pictographic}|\\u200d|\\ufe0f|\\s)+$/u;
  const emoji = [...document.querySelectorAll("body *")].filter((el) => {
    if (el.children.length || !el.textContent || !emojiOnly.test(el.textContent)) return false;
    return parseFloat(getComputedStyle(el).fontSize) >= 24;
  }).length;
  const blocks = [...document.querySelectorAll("main h1, main h2, main h3, main p")].filter((el) => el.getBoundingClientRect().height > 0 && !el.closest("form"));
  const centred = blocks.filter((el) => getComputedStyle(el).textAlign === "center").length;
  const empties = [];
  for (const sec of document.querySelectorAll("main > section, main > div, body > header, body > section")) {
    const box = sec.getBoundingClientRect();
    if (box.height < view * 0.6) continue;
    let top = Infinity, bottom = -Infinity;
    for (const el of sec.querySelectorAll("*")) {
      const leaf = el.tagName === "IMG" || el.tagName === "FIGURE" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || visibleText(el);
      if (!leaf) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
    }
    const used = bottom > top ? bottom - top : 0;
    const empty = Math.round(box.height - used);
    if (empty > view * 0.4) empties.push({ name: sec.id ? "#" + sec.id : (sec.className ? "." + String(sec.className).split(" ")[0] : sec.tagName.toLowerCase()), empty });
  }
  return {
    height: total(),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    h1: document.querySelectorAll("h1").length,
    imagesWithoutAlt: imgs.filter((i) => !i.hasAttribute("alt")).length,
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    invisibleText: invisible,
    title: document.title || "",
    hasDescription: !!document.querySelector('meta[name="description"][content]'),
    hasOpenGraph: !!document.querySelector('meta[property^="og:"]'),
    hasFavicon: !!document.querySelector('link[rel~="icon"]'),
    unlabeledFields: unlabeled,
    descriptionLength: (document.querySelector('meta[name="description"]')?.getAttribute("content") || "").trim().length,
    hasCanonical: !!document.querySelector('link[rel="canonical"][href]'),
    hasStructuredData: !!document.querySelector('script[type="application/ld+json"]'),
    hasShareImage: !!document.querySelector('meta[property="og:image"][content]'),
    skippedHeadings: [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1])).filter((level, i, all) => i > 0 && level > all[i - 1] + 1).length,
    unsizedImages: imgs.filter((i) => !i.getAttribute("width") || !i.getAttribute("height")).length,
    vagueLinks: [...document.querySelectorAll("a[href]")].filter((a) => /^(click here|here|read more|learn more|more|link)$/i.test((a.textContent || "").trim())).length,
    emojiPictures: emoji,
    centredShare: blocks.length >= 4 ? centred / blocks.length : 0,
    emptySections: empties.slice(0, 3),
  };
})()`;

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Findings for one viewport. `first` adds the checks that don't depend on width (said once). */
export function pageFindings(m: PageMeasure, consoleErrors: string[], width: number, first: boolean): string[] {
  const out: string[] = [];
  if (m.overflow > 4) out.push(`At ${width} px wide the page scrolls sideways: its content is ${width + m.overflow} px wide.`);
  if (m.invisibleText > 0) out.push(`At ${width} px wide, ${n(m.invisibleText, "element with text is", "elements with text are")} still invisible (opacity 0) after scrolling through the page: an animation that never ran.`);
  for (const e of m.emptySections ?? []) out.push(`At ${width} px wide, ${e.name} has about ${e.empty} px of empty space above and below its content: remove the min-height or large padding.`);
  if (!first) return out;
  if ((m.emojiPictures ?? 0) > 0) out.push(`${n(m.emojiPictures!, "emoji is", "emoji are")} used as a picture or icon. Replace each with the user's image or a labelled photo place (figure.photo), or remove it.`);
  if ((m.centredShare ?? 0) > 0.6) out.push("Nearly all the text is centred, which reads as a template. Left-align the sections; centre at most one short statement.");
  for (const e of [...new Set(consoleErrors)].slice(0, 4)) out.push(`Console error: ${e.replace(/\s+/g, " ").slice(0, 200)}`);
  if (m.brokenImages > 0) out.push(`${n(m.brokenImages, "image doesn't", "images don't")} load.`);
  if (m.h1 !== 1) out.push(m.h1 === 0 ? "The page has no h1." : `The page has ${m.h1} h1 headings; it should have one.`);
  if (m.imagesWithoutAlt > 0) out.push(`${n(m.imagesWithoutAlt, "image has", "images have")} no alt attribute.`);
  if (m.unlabeledFields > 0) out.push(`${n(m.unlabeledFields, "form field has", "form fields have")} no label.`);
  if (!m.title.trim()) out.push("The page has no <title>.");
  if (!m.hasDescription) out.push("The page has no meta description.");
  if (!m.hasOpenGraph) out.push("The page has no Open Graph tags (og:title, og:description).");
  if (!m.hasFavicon) out.push("The page has no favicon link.");
  // Search engines and link previews. Only said when the page was measured for them.
  if (m.title.trim().length > 65) out.push(`The <title> is ${m.title.trim().length} characters; search results cut it off after about 60.`);
  if (m.hasDescription && m.descriptionLength !== undefined && (m.descriptionLength < 70 || m.descriptionLength > 165)) out.push(`The meta description is ${m.descriptionLength} characters; aim for 120 to 155 so it isn't cut off or thin.`);
  if (m.hasStructuredData === false) out.push("The page has no JSON-LD structured data (schema.org LocalBusiness, Organization or Person).");
  if ((m.skippedHeadings ?? 0) > 0) out.push(`${n(m.skippedHeadings!, "heading skips", "headings skip")} a level (for example an h3 straight after an h1).`);
  if ((m.unsizedImages ?? 0) > 0) out.push(`${n(m.unsizedImages!, "image has", "images have")} no width and height attributes, so the page jumps as they load.`);
  if ((m.vagueLinks ?? 0) > 0) out.push(`${n(m.vagueLinks!, "link says", "links say")} only "click here" or "read more"; say where the link goes.`);
  return out;
}
