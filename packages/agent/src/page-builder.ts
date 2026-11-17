/**
 * Builds a whole landing page from its content (MASTER_PLAN › Agent quality).
 *
 * Advice doesn't make a local model design well: told to write nine sections with photos, it
 * writes three without. So the model supplies what only it can (the words, as data) and this
 * renders the page: every section, pictures searched for and placed, the tags search engines
 * read, motion, a logo. The model then looks at the result and adjusts it with small edits.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DESIGN_DIRECTIONS, type DesignDirection, KIT_JS, kitCss, logoSvg, pickDirection } from "./design-kit.js";
import { type PhotoConfig, type SavedPhoto, savePhotos } from "./photos.js";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

const text = (max: number, what: string) => z.string().min(1).max(max).describe(what);
const BRACKETS = "Facts only the owner knows (address, phone, hours) go in [square brackets]";

export const PageContent = z.object({
  business: text(80, "The kind of business, e.g. 'neighbourhood bakery', 'SEO agency'"),
  name: text(60, "The business's name. If the user gave none, choose a fitting one"),
  direction: z.enum(DESIGN_DIRECTIONS.map((d) => d.id) as [string, ...string[]]).optional().describe("Leave out to get the look that suits the business"),
  url: z.string().url().optional().describe("The site's address, only if the user gave it"),
  seo: z.object({
    phrase: text(60, "What people type into a search engine to find this, e.g. 'bakery in Sarajevo'"),
    title: text(60, "Page title: the phrase first, the name last, under 60 characters"),
    description: text(160, "Search result text: what it is, where, why to click; 120 to 155 characters"),
  }),
  hero: z.object({
    eyebrow: text(60, "Small line above the headline: the place or kind of business"),
    headline: text(90, "The main headline, 5 to 10 words, specific to this business"),
    emphasis: z.string().max(40).optional().describe("Two or three words from the headline, copied exactly, to stress"),
    lede: text(220, "One or two sentences: what it is and who it is for"),
    action: text(30, "Main button, e.g. 'Order for tomorrow'"),
    secondAction: z.string().max(30).optional(),
    facts: z.array(z.object({ label: text(20, "e.g. Open"), value: text(50, BRACKETS) })).max(3).default([]),
    photo: text(40, "Two or three plain words for a photo search of the hero picture: 'sourdough bread', 'dentist office'"),
    scene3d: z.boolean().default(false).describe("true puts a 3D object in place of the hero picture: only when the user asks for 3D"),
  }),
  ticker: z.array(text(30, "a speciality or service")).max(8).default([]).describe("4 to 8 short words that drift across the page under the hero"),
  offer: z.object({
    label: text(30, "e.g. 'Today's bakes', 'Services'"),
    heading: text(70, "Section headline"),
    intro: text(200, "One sentence"),
    items: z
      .array(z.object({ name: text(60, "Product or service"), text: text(200, "One or two sentences about it"), price: z.string().max(20).optional().describe("With currency; leave out when there are no prices") }))
      .min(3)
      .max(8),
  }),
  story: z.object({
    label: text(30, "e.g. 'Our story', 'How we work'"),
    heading: text(70, "Section headline"),
    paragraphs: z.array(text(420, "A paragraph about how this kind of business works. No invented history, numbers, suppliers or awards; what only the owner knows goes in [square brackets]")).min(2).max(3),
    photo: text(40, "Two or three plain words for a photo search: 'baker dough'"),
  }),
  steps: z
    .object({ label: text(30, "e.g. 'How it works'"), heading: text(70, "Section headline"), items: z.array(z.object({ name: text(50, "Step"), text: text(200, "Two sentences") })).min(3).max(4) })
    .describe("How a customer gets from interest to result, in 3 or 4 steps"),
  gallery: text(40, "Two or three plain words for four more pictures: 'bakery pastries'"),
  quote: z
    .object({ text: text(220, "The customer's exact words"), by: text(60, "Who said it") })
    .optional()
    .describe("Only when the user's message contains a real customer's words. Never write one yourself: leave this out and the page keeps a place for a real quote"),
  faq: z.object({ heading: text(70, "Section headline"), items: z.array(z.object({ q: text(100, "A question customers really ask"), a: text(320, "The answer, two sentences") })).min(4).max(6) }),
  band: z.object({ statement: text(110, "One strong sentence that asks for the action"), action: text(30, "Button") }),
  contact: z.object({
    heading: text(70, "Section headline"),
    intro: text(200, "One sentence"),
    details: z.array(z.object({ label: text(20, "Hours, Address, Phone or Email"), value: text(90, BRACKETS) })).min(2).max(4),
    fields: z.array(z.enum(["name", "email", "phone", "message"])).min(2).default(["name", "email", "message"]),
    submit: text(30, "Button, e.g. 'Send message'"),
  }),
});
export type PageContent = z.output<typeof PageContent>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
const bracketed = (s: string) => /\[[^\]]*\]/.test(s);

/** Pictures the page asked for; a missing one renders as a labelled place for it. */
export interface PagePhotos {
  hero?: SavedPhoto;
  story?: SavedPhoto;
  gallery: SavedPhoto[];
}

function figure(photo: SavedPhoto | undefined, label: string, eager = false): string {
  if (!photo) return `<figure class="photo reveal"><span class="photo__label">Photo: ${esc(label)}</span></figure>`;
  return `<figure class="photo reveal"><img src="${esc(photo.path)}" alt="${esc(photo.alt)}" width="${photo.width}" height="${photo.height}"${eager ? "" : ' loading="lazy"'} data-parallax></figure>`;
}

const FIELDS = {
  name: ['<label for="name">Your name</label>', '<input id="name" name="name" autocomplete="name" required>'],
  email: ['<label for="email">Email</label>', '<input id="email" name="email" type="email" autocomplete="email" required>'],
  phone: ['<label for="phone">Phone <span>(optional)</span></label>', '<input id="phone" name="phone" type="tel" autocomplete="tel">'],
  message: ['<label for="message">How can we help?</label>', '<textarea id="message" name="message" rows="5" required></textarea>'],
} as const;

/** The finished page. Pure: the same content and photos always give the same HTML. */
export function renderPage(c: PageContent, d: DesignDirection, photos: PagePhotos = { gallery: [] }): string {
  const headline = c.hero.emphasis && c.hero.headline.includes(c.hero.emphasis) ? esc(c.hero.headline).replace(esc(c.hero.emphasis), `<em>${esc(c.hero.emphasis)}</em>`) : esc(c.hero.headline);
  const priced = c.offer.items.some((i) => i.price);
  const details = Object.fromEntries(c.contact.details.map((x) => [x.label.toLowerCase(), x.value]));
  // Structured data: only facts that are known. A bracketed placeholder is not a fact.
  const known = (v: string | undefined) => (v && !bracketed(v) ? v : undefined);
  const ld: Record<string, unknown> = { "@context": "https://schema.org", "@type": details.address ? "LocalBusiness" : "Organization", name: c.name, description: c.seo.description };
  if (c.url) ld.url = c.url;
  if (known(details.phone)) ld.telephone = details.phone;
  if (known(details.email)) ld.email = details.email;
  if (known(details.address)) ld.address = details.address;
  const faqLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: c.faq.items.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) };
  const json = (o: unknown) => JSON.stringify(o).replace(/</g, "\\u003c");
  let n = 0;
  const head = (label: string, heading: string, intro?: string) =>
    `<div class="section-head reveal">\n        <p class="eyebrow">${String(++n).padStart(2, "0")} · ${esc(label)}</p>\n        <h2>${esc(heading)}</h2>${intro ? `\n        <p>${esc(intro)}</p>` : ""}\n      </div>`;
  const offer = priced
    ? `<ul class="menu">\n${c.offer.items.map((i) => `          <li class="reveal"><div class="menu__row"><h3 class="menu__name">${esc(i.name)}</h3><span class="menu__dots" aria-hidden="true"></span><span class="menu__price">${esc(i.price ?? "")}</span></div>\n            <p class="menu__desc">${esc(i.text)}</p></li>`).join("\n")}\n        </ul>`
    : `<div class="cards">\n${c.offer.items.map((i) => `          <article class="card reveal"><h3>${esc(i.name)}</h3><p>${esc(i.text)}</p></article>`).join("\n")}\n        </div>`;
  const gallery = [0, 1, 2, 3].map((i) => `          ${figure(photos.gallery[i], c.gallery)}`).join("\n");
  const credits = [photos.hero, photos.story, ...photos.gallery].filter((p): p is SavedPhoto => !!p).map((p) => p.credit);
  const ticker = c.ticker.length >= 3 ? `\n    <div class="ticker" aria-hidden="true"><div class="ticker__track">${[...c.ticker, ...c.ticker].map((t) => `<span>${esc(t)}</span>`).join("")}</div></div>\n` : "";
  const offerId = id(c.offer.label);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(c.seo.title)}</title>
  <meta name="description" content="${esc(c.seo.description)}">${c.url ? `\n  <link rel="canonical" href="${esc(c.url)}">` : ""}
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(c.seo.title)}">
  <meta property="og:description" content="${esc(c.seo.description)}">${c.url && photos.hero ? `\n  <meta property="og:image" content="${esc(new URL(photos.hero.path, c.url).toString())}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="assets/logo.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${esc(d.fonts)}" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
  <script type="application/ld+json">${json(ld)}</script>
  <script type="application/ld+json">${json(faqLd)}</script>
  <script src="script.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header"><div class="wrap">
    <a class="brand" href="#"><img src="assets/logo.svg" alt="" width="28" height="28">${esc(c.name)}</a>
    <nav class="nav" aria-label="Main"><a href="#${offerId}">${esc(c.offer.label)}</a><a href="#story">${esc(c.story.label)}</a><a href="#questions">Questions</a><a href="#contact">Contact</a></nav>
  </div></header>

  <main id="main">
    <section class="hero"><div class="wrap">
      <div class="hero__text">
        <p class="eyebrow">${esc(c.hero.eyebrow)}</p>
        <h1 class="display">${headline}</h1>
        <p class="lede">${esc(c.hero.lede)}</p>
        <div class="actions"><a class="btn" href="#contact">${esc(c.hero.action)}</a>${c.hero.secondAction ? `<a class="btn btn--ghost" href="#${offerId}">${esc(c.hero.secondAction)}</a>` : ""}</div>${c.hero.facts.length ? `\n        <dl class="facts">${c.hero.facts.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl>` : ""}
      </div>
      ${c.hero.scene3d ? '<figure class="photo photo--scene"><canvas data-scene aria-hidden="true"></canvas></figure>' : figure(photos.hero, c.hero.photo, true).replace(' class="photo reveal"', ' class="photo"')}
    </div></section>
${ticker}
    <section class="section" id="${offerId}"><div class="wrap">
      ${head(c.offer.label, c.offer.heading, c.offer.intro)}
      <div class="section-body${priced ? "" : " section-body--wide"}">
        ${offer}
      </div>
    </div></section>

    <section class="section section--tint" id="story"><div class="wrap">
      ${head(c.story.label, c.story.heading)}
      <div class="section-body section-body--wide"><div class="split">
        ${figure(photos.story, c.story.photo)}
        <div class="prose reveal">${c.story.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
      </div></div>
    </div></section>

    <section class="section" id="${id(c.steps.label)}"><div class="wrap">
      ${head(c.steps.label, c.steps.heading)}
      <div class="section-body section-body--wide"><div class="cards">
${c.steps.items.map((i) => `        <article class="card reveal"><h3>${esc(i.name)}</h3><p>${esc(i.text)}</p></article>`).join("\n")}
      </div></div>
    </div></section>

    <section class="section section--flush" aria-label="Gallery"><div class="wrap">
      <div class="gallery">
${gallery}
      </div>
    </div></section>

    <section class="section section--tint"><div class="wrap">
      <figure class="quote reveal"><blockquote>${esc(c.quote?.text ?? "[A sentence from a real customer]")}</blockquote><figcaption>${esc(c.quote?.by ?? "[Their name]")}</figcaption></figure>
    </div></section>

    <section class="section" id="questions"><div class="wrap">
      ${head("Questions", c.faq.heading)}
      <div class="section-body"><div class="faq">
${c.faq.items.map((f) => `        <details class="reveal"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("\n")}
      </div></div>
    </div></section>

    <section class="band"><div class="wrap"><h2 class="reveal">${esc(c.band.statement)}</h2><a class="btn" href="#contact">${esc(c.band.action)}</a></div></section>

    <section class="section" id="contact"><div class="wrap">
      ${head("Contact", c.contact.heading, c.contact.intro)}
      <div class="section-body section-body--wide"><div class="split split--narrow-first">
        <dl class="info reveal">${c.contact.details.map((x) => `<div><dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd></div>`).join("")}</dl>
        <form class="form reveal" novalidate>
${c.contact.fields.map((f) => `          <div class="field${f === "message" ? " field--wide" : ""}">${FIELDS[f][0]}${FIELDS[f][1]}<p class="field__error" id="${f}-error" aria-live="polite"></p></div>`).join("\n")}
          <div class="form__foot"><button class="btn" type="submit">${esc(c.contact.submit)}</button><p class="form__note" role="status" aria-live="polite"></p></div>
        </form>
      </div></div>
    </div></section>
  </main>

  <footer class="site-footer"><div class="wrap">
    <p>&copy; <span data-year></span> ${esc(c.name)}</p>
    <p>${c.contact.details.slice(0, 2).map((x) => esc(x.value)).join(" · ")}</p>${credits.length ? `\n    <p class="credits">Photos: ${credits.map(esc).join("; ")}</p>` : ""}
  </div></footer>
</body>
</html>
`;
}

/** Everything in [square brackets] on the page: what the user still has to fill in. */
export function placeholders(html: string): string[] {
  return [...new Set([...html.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/\[[^\]<>]{2,80}\]/g)].map((m) => m[0]))];
}

export interface PageBuilderConfig {
  /** Present when the user allows web access: pictures are searched for and saved. */
  photos?: PhotoConfig;
}

export function designKitTool(cfg: PageBuilderConfig = {}): AgentTool {
  return {
    name: "design_kit",
    description:
      "Build a complete, designed landing page from its content. You give the words as data (headline, products or services, the story, steps, questions and answers, contact details); it writes index.html with every section, styles.css, script.js (scroll animations, form checks) and a logo, finds and places photos, and adds the tags search engines read. Call it first for any new web page or site, instead of writing HTML or CSS yourself; afterwards change wording or details with edit_file.",
    schema: PageContent,
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const c = args as PageContent;
      const targets = ["index.html", "styles.css", "script.js"];
      const own = targets.filter((p) => existsSync(ctx.workspace.resolve(p)) && !ctx.createdThisRun?.has(p));
      if (own.length) return { ok: false, content: `${own.join(", ")} already exist${own.length === 1 ? "s" : ""} and wasn't made in this task: this project has its own page and styles. Change those with edit_file and follow their conventions instead of the kit.` };
      const d = pickDirection(c.business, c.direction);
      const photos: PagePhotos = { gallery: [] };
      const missing: string[] = [];
      if (cfg.photos) {
        const get = async (query: string, count: number, orientation: "wide" | "tall" | "square") => {
          try {
            const got = await savePhotos(query, count, orientation, "assets", cfg.photos!, ctx);
            if (got.length < count) missing.push(`${count - got.length} of ${count} for "${query}"`);
            return got;
          } catch (e) {
            missing.push(`"${query}" (${(e as Error).message})`);
            return [];
          }
        };
        if (!c.hero.scene3d) photos.hero = (await get(c.hero.photo, 1, "tall"))[0];
        photos.story = (await get(c.story.photo, 1, "wide"))[0];
        photos.gallery = await get(c.gallery, 4, "square");
      }
      const html = renderPage(c, d, photos);
      const css = kitCss(d);
      const before = new Map<string, string | null>();
      const write = (rel: string, content: string) => {
        const abs = ctx.workspace.resolve(rel);
        before.set(rel, existsSync(abs) ? ctx.workspace.readText(rel) : null);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        ctx.createdThisRun?.add(rel);
      };
      write("styles.css", css);
      write("script.js", KIT_JS);
      if (!existsSync(ctx.workspace.resolve("assets/logo.svg")) || ctx.createdThisRun?.has("assets/logo.svg")) write("assets/logo.svg", logoSvg(c.name, d));
      write("index.html", html);
      const got = [photos.hero, photos.story, ...photos.gallery].filter(Boolean).length;
      const open = placeholders(html);
      const pictures = !cfg.photos
        ? "No photo search here (web access is off), so the pictures are labelled places for photos."
        : `${got} photo${got === 1 ? "" : "s"} found and placed${missing.length ? `; still labelled places: ${missing.join(", ")}` : ""}.`;
      return {
        ok: true,
        edited: true,
        change: { path: "index.html", before: before.get("index.html") ?? null },
        content: `Built the page in the "${d.name}" direction: index.html (${html.split("\n").length - 1} lines, 10 sections: hero, ${c.offer.label}, ${c.story.label}, ${c.steps.label}, gallery, quote, questions, call to action, contact, footer), styles.css, script.js and assets/logo.svg.\n${pictures}\n${open.length ? `Left for the user to fill in: ${open.join(", ")}.` : "Nothing was left in [brackets]."}\n\nThe page is finished: don't rewrite it or its stylesheet. You'll be shown how it looks; change wording, a picture or a detail with edit_file on index.html. Rules only this page needs go at the end of styles.css. In your final answer say what was built, that the name, prices, story and product details are draft copy you wrote for the owner to confirm, what is in [brackets], and that the form isn't connected to an inbox yet${c.url ? "" : "; and that the canonical link and share image need the site's address"}.`,
      };
    },
  } as AgentTool;
}
