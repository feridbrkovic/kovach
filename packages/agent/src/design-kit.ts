/**
 * A design kit for web pages (MASTER_PLAN › Agent quality). A local model writes sound HTML
 * but plain, centred, look-alike CSS. So the stylesheet isn't left to it: the kit ships a
 * finished one (type scale, spacing, layout, components) in a direction that suits the
 * business, plus the HTML each component expects. The model's job becomes content and
 * composition. Everything here is written for this project; nothing is fetched.
 */

export interface DesignDirection {
  id: string;
  name: string;
  /** Kinds of business it suits; matched against what the page is for. */
  when: RegExp;
  /** Told to the model: the look and what makes it this direction. */
  look: string;
  /** Google Fonts stylesheet; the font stacks fall back to system fonts when it can't load. */
  fonts: string;
  tokens: Record<string, string>;
  /** Rules on top of the shared base that give the direction its character. */
  extra: string;
}

export const DESIGN_DIRECTIONS: DesignDirection[] = [
  {
    id: "warm-editorial",
    name: "Warm editorial",
    when: /\b(bak\w*|caf[eé]|coffee|restaurant|bistro|food|kitchen|pastry|cake|deli|farm|florist|flower|craft|handmade|ceramic|wine|brewery|chocolate|pekar\w*|restoran|kafi[cć])\b/i,
    look: "Cream paper, espresso ink, one terracotta accent. A large serif headline with an italic phrase, text set left, a price list with dotted leaders like a printed menu.",
    fonts: "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=DM+Sans:wght@400;500;700&display=swap",
    tokens: {
      "--paper": "#f7f0e4",
      "--paper-2": "#eee3d0",
      "--ink": "#2b1d13",
      "--ink-2": "#6d5b4b",
      "--line": "#d8c9b1",
      "--accent": "#b4472a",
      "--accent-ink": "#fff7ec",
      "--font-display": '"Fraunces", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
      "--font-body": '"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
      "--display-weight": "500",
      "--display-tracking": "-0.025em",
      "--radius": "3px",
    },
    extra: `.display em, .section-head h2 em { font-style: italic; color: var(--accent); }
.btn { border-radius: 999px; }`,
  },
  {
    id: "bold-modern",
    name: "Bold modern",
    when: /\b(seo|agency|marketing|startup|saas|software|app|studio|fitness|gym|tech|digital|product|platform|agencij\w*)\b/i,
    look: "Off-white and near-black with one vivid accent. A very large, tight grotesque headline, square corners, thick rules, numbered sections.",
    fonts: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Inter:wght@400;500;700&display=swap",
    tokens: {
      "--paper": "#f4f2ec",
      "--paper-2": "#e7e4da",
      "--ink": "#111110",
      "--ink-2": "#55534d",
      "--line": "#111110",
      "--accent": "#ff4f1a",
      "--accent-ink": "#111110",
      "--font-display": '"Bricolage Grotesque", "Helvetica Neue", "Arial Narrow", Arial, sans-serif',
      "--font-body": '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      "--display-weight": "700",
      "--display-tracking": "-0.045em",
      "--radius": "0px",
    },
    extra: `.display { line-height: 0.95; }
.display em, .section-head h2 em { font-style: normal; background: var(--accent); color: var(--accent-ink); padding: 0 0.12em; }
.section { border-top-width: 2px; }
.btn { border-width: 2px; text-transform: uppercase; letter-spacing: 0.04em; font-size: var(--step--1); }`,
  },
  {
    id: "calm-professional",
    name: "Calm professional",
    when: /\b(law|lawyer|legal|attorney|clinic|dental|dentist|doctor|medical|health|consult\w*|account\w*|financ\w*|insurance|real estate|architect\w*|notary|advokat\w*|ordinacij\w*|optik\w*|optic\w*)\b/i,
    look: "White paper, slate ink, a deep green accent. A quiet serif headline, thin rules, generous margins, small capital labels.",
    fonts: "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&family=Inter:wght@400;500;600&display=swap",
    tokens: {
      "--paper": "#fbfaf7",
      "--paper-2": "#f0eee8",
      "--ink": "#1c2526",
      "--ink-2": "#5b6667",
      "--line": "#d9dcd6",
      "--accent": "#1f5c4a",
      "--accent-ink": "#f6fbf8",
      "--font-display": '"Newsreader", "Iowan Old Style", Georgia, serif',
      "--font-body": '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      "--display-weight": "400",
      "--display-tracking": "-0.02em",
      "--radius": "2px",
    },
    extra: `.display em, .section-head h2 em { font-style: italic; }`,
  },
  {
    id: "dark-studio",
    name: "Dark studio",
    when: /\b(portfolio|photograph\w*|film|video|music|band|dj|game|gaming|developer|design(er)?|tattoo|barber|night|club|bar)\b/i,
    look: "Near-black with warm white text and an amber accent. A tall serif headline, hairline rules, pictures carry the page.",
    fonts: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap",
    tokens: {
      "--paper": "#121110",
      "--paper-2": "#1c1a18",
      "--ink": "#f3ede4",
      "--ink-2": "#a39a8d",
      "--line": "#35312c",
      "--accent": "#e9a23b",
      "--accent-ink": "#141210",
      "--font-display": '"Instrument Serif", "Iowan Old Style", Georgia, serif',
      "--font-body": '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      "--display-weight": "400",
      "--display-tracking": "-0.015em",
      "--radius": "2px",
    },
    extra: `.display em, .section-head h2 em { font-style: italic; color: var(--accent); }`,
  },
];

const DEFAULT_DIRECTION = "calm-professional";

/** The direction for a kind of business: the one asked for by id, else the first whose words match. */
export function pickDirection(business: string, id?: string): DesignDirection {
  return (
    DESIGN_DIRECTIONS.find((d) => d.id === id) ??
    DESIGN_DIRECTIONS.find((d) => d.when.test(business)) ??
    DESIGN_DIRECTIONS.find((d) => d.id === DEFAULT_DIRECTION)!
  );
}

/** The line in the stylesheet below which the page's own rules go. */
export const PAGE_RULES_MARKER = "/* ---- This page's own rules go below this line ---- */";

const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 var(--step-0) / 1.6 var(--font-body);
  -webkit-font-smoothing: antialiased;
}
img { display: block; max-width: 100%; height: auto; }
a { color: inherit; text-underline-offset: 0.2em; text-decoration-thickness: 1px; }
h1, h2, h3 {
  margin: 0;
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  letter-spacing: var(--display-tracking);
  line-height: 1.08;
  text-wrap: balance;
}
p, ul, ol, dl, dd, figure { margin: 0; padding: 0; }
p { text-wrap: pretty; }
ul, ol { list-style: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.wrap { width: min(100% - 2.5rem, var(--wrap)); margin-inline: auto; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 1rem; top: 1rem; background: var(--paper); padding: 0.5rem 0.75rem; z-index: 10; }

/* Small label above a heading or beside a section */
.eyebrow {
  display: flex; align-items: center; gap: 0.75rem;
  font-size: var(--step--1); font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-2);
}
.eyebrow::before { content: ""; width: 2rem; height: 1px; background: currentColor; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  min-height: 3rem; padding: 0.7rem 1.5rem;
  border: 1px solid var(--accent); border-radius: var(--radius);
  background: var(--accent); color: var(--accent-ink);
  font: 500 var(--step-0) / 1 var(--font-body); text-decoration: none; cursor: pointer;
  transition: transform 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}
.btn:hover { transform: translateY(-2px); }
.btn--ghost { background: transparent; color: var(--ink); border-color: var(--ink); }
.btn--ghost:hover { background: var(--ink); color: var(--paper); }

/* Header */
.site-header { border-bottom: 1px solid var(--line); }
.site-header .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 2rem; padding-block: 1.1rem; }
.brand { font-family: var(--font-display); font-weight: var(--display-weight); font-size: var(--step-1); letter-spacing: var(--display-tracking); text-decoration: none; }
.nav { display: flex; flex-wrap: wrap; gap: 0.25rem 1.75rem; font-size: var(--step--1); letter-spacing: 0.04em; }
.nav a { text-decoration: none; padding-block: 0.4rem; border-bottom: 1px solid transparent; }
.nav a:hover { border-bottom-color: currentColor; }

/* Hero: words on the left, a picture on the right */
.hero { padding-block: clamp(2.5rem, 6vw, 5.5rem); }
.hero .wrap { display: grid; gap: clamp(2rem, 5vw, 4.5rem); align-items: end; }
.hero__text { display: grid; gap: var(--space-3); justify-items: start; }
.display { font-size: var(--step-3); }
.lede { font-size: var(--step-1); line-height: 1.45; color: var(--ink-2); max-width: 34ch; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: var(--space-1); }
.facts { display: flex; flex-wrap: wrap; gap: 0.5rem 2.5rem; padding-top: var(--space-3); border-top: 1px solid var(--line); width: 100%; font-size: var(--step--1); }
.facts dt { color: var(--ink-2); letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.72rem; }
.facts dd { font-weight: 500; }
@media (min-width: 56rem) {
  .hero .wrap { grid-template-columns: 1.15fr 0.85fr; }
}

/* A picture, or the place where one goes */
.photo {
  position: relative; overflow: hidden;
  aspect-ratio: var(--ratio, 4 / 3);
  border: 1px solid var(--line); border-radius: var(--radius);
  background-color: var(--paper-2);
  background-image: repeating-linear-gradient(135deg, transparent 0 13px, color-mix(in srgb, var(--ink) 6%, transparent) 13px 14px);
}
.photo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.photo__label {
  position: absolute; left: 0.75rem; bottom: 0.75rem; max-width: calc(100% - 1.5rem);
  padding: 0.3rem 0.6rem; background: var(--paper); border: 1px solid var(--line);
  font-size: 0.75rem; line-height: 1.3; color: var(--ink-2);
}
@media (min-width: 56rem) {
  .hero .photo { --ratio: 4 / 5; }
}

/* Sections: a label column and a content column */
.section { padding-block: var(--space-5); border-top: 1px solid var(--line); }
.section--tint { background: var(--paper-2); }
.section-head { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.section-head h2 { font-size: var(--step-2); max-width: 18ch; }
.section-head p { color: var(--ink-2); max-width: 46ch; }
@media (min-width: 56rem) {
  .section-head { grid-template-columns: 1fr 2fr; align-items: start; }
  .section-head > :not(.eyebrow) { grid-column: 2; }
  .section-head .eyebrow { grid-row: 1 / span 2; padding-top: 0.6rem; }
  .section-body { display: grid; grid-template-columns: 1fr 2fr; column-gap: var(--space-2); }
  .section-body > * { grid-column: 2; }
  .section-body--wide > * { grid-column: 1 / -1; }
}

/* Price list: name, dotted leader, price; a line of description under it */
.menu { display: grid; gap: var(--space-3); }
.menu__row { display: flex; align-items: baseline; gap: 0.75rem; }
.menu__name { font-size: var(--step-1); }
.menu__dots { flex: 1; min-width: 1.5rem; border-bottom: 2px dotted var(--line); transform: translateY(-0.3em); }
.menu__price { font-family: var(--font-display); font-size: var(--step-1); font-variant-numeric: tabular-nums; white-space: nowrap; }
.menu__desc { margin-top: 0.3rem; color: var(--ink-2); max-width: 52ch; }

/* Two columns that stack on small screens (a picture beside a list, details beside a form) */
.split { display: grid; gap: clamp(2rem, 5vw, 4rem); align-items: start; }
@media (min-width: 56rem) {
  .split { grid-template-columns: 1fr 1fr; }
  .split--narrow-first { grid-template-columns: 0.8fr 1.2fr; }
}

/* Numbered cards for services, features or steps */
.cards { display: grid; gap: var(--space-4) var(--space-3); grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); counter-reset: card; }
.card { display: grid; gap: 0.6rem; align-content: start; padding-top: var(--space-2); border-top: 2px solid var(--ink); counter-increment: card; }
.card::before { content: counter(card, decimal-leading-zero); font-size: var(--step--1); letter-spacing: 0.1em; color: var(--ink-2); }
.card h3 { font-size: var(--step-1); }
.card p { color: var(--ink-2); }

/* A full-width statement in the accent colour */
.band { background: var(--accent); color: var(--accent-ink); padding-block: var(--space-5); }
.band .wrap { display: grid; gap: var(--space-3); justify-items: start; }
.band h2 { font-size: var(--step-2); max-width: 20ch; }
.band .btn { background: var(--accent-ink); color: var(--accent); border-color: var(--accent-ink); }
@media (min-width: 56rem) {
  .band .wrap { grid-template-columns: 1fr auto; align-items: end; }
}

/* Details as label and value (hours, address, phone) */
.info { display: grid; gap: var(--space-3); }
.info div { display: grid; gap: 0.15rem; padding-bottom: var(--space-2); border-bottom: 1px solid var(--line); }
.info dt { font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
.info dd { font-size: var(--step-1); font-family: var(--font-display); }

/* Forms: a panel of its own, two fields to a row on wide screens */
.form {
  display: grid; gap: var(--space-3) var(--space-2); grid-template-columns: 1fr;
  padding: clamp(1.5rem, 4vw, 2.75rem);
  background: var(--paper); border: 1px solid var(--line); border-radius: calc(var(--radius) * 3);
  box-shadow: 0 30px 60px -45px color-mix(in srgb, var(--ink) 55%, transparent);
}
@media (min-width: 40rem) {
  .form { grid-template-columns: 1fr 1fr; }
  .field--wide, .form__foot { grid-column: 1 / -1; }
}
.field { display: grid; gap: 0.5rem; align-content: start; }
.field label { font-size: 0.72rem; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }
.field label span { text-transform: none; letter-spacing: 0; opacity: 0.8; }
.field input, .field textarea, .field select {
  width: 100%; padding: 0.55rem 0 0.7rem;
  border: 0; border-bottom: 1px solid var(--ink-2); border-radius: 0;
  background: transparent; color: var(--ink); font: 400 var(--step-1) / 1.3 var(--font-display);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.field textarea { min-height: 7rem; resize: vertical; }
.field input:focus, .field textarea:focus, .field select:focus { outline: none; border-bottom-color: var(--accent); box-shadow: 0 1px 0 var(--accent); }
.field [aria-invalid="true"] { border-bottom-color: var(--accent); }
.field__error { min-height: 1.2em; font-size: var(--step--1); color: var(--accent); }
.form__foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.form__note { font-size: var(--step--1); color: var(--ink-2); }
.section--flush { padding-block: 0 var(--space-5); border-top: 0; }

/* Numbers with a label: years, loaves a day, clients (only real ones, or in [brackets]) */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--space-3); }
.stats div { display: grid; gap: 0.2rem; padding-top: var(--space-2); border-top: 1px solid var(--line); }
.stats dd { font-family: var(--font-display); font-size: var(--step-2); line-height: 1; letter-spacing: var(--display-tracking); order: -1; }
.stats dt { font-size: var(--step--1); color: var(--ink-2); }

/* Long-form text beside a picture: the story, the people, the method */
.prose { display: grid; gap: var(--space-2); max-width: 58ch; }
.prose p:first-child { font-size: var(--step-1); line-height: 1.45; }
.prose p + p { color: var(--ink-2); }

/* Pictures in a loose grid; the first is larger */
.gallery { display: grid; gap: var(--space-2); grid-template-columns: repeat(2, 1fr); }
.gallery .photo { --ratio: 1 / 1; }
@media (min-width: 56rem) {
  .gallery { grid-template-columns: repeat(4, 1fr); }
  .gallery .photo:first-child { grid-column: span 2; grid-row: span 2; aspect-ratio: auto; height: 100%; }
  .gallery .photo:last-child { grid-column: span 2; --ratio: 2 / 1; }
}

/* What a customer said. Only real quotes; otherwise a [bracketed] place for one. */
.quote { display: grid; gap: var(--space-2); max-width: 44ch; }
.quote blockquote { margin: 0; font-family: var(--font-display); font-size: var(--step-2); line-height: 1.15; letter-spacing: var(--display-tracking); }
.quote figcaption { font-size: var(--step--1); color: var(--ink-2); }

/* Questions that open (no script needed) */
.faq { border-top: 1px solid var(--line); }
.faq details { border-bottom: 1px solid var(--line); }
.faq summary { display: flex; justify-content: space-between; gap: 1rem; padding-block: var(--space-2); cursor: pointer; list-style: none; font-family: var(--font-display); font-size: var(--step-1); }
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after { content: "+"; color: var(--accent); transition: transform 0.2s ease; }
.faq details[open] summary::after { transform: rotate(45deg); }
.faq details p { padding-bottom: var(--space-3); color: var(--ink-2); max-width: 60ch; }

/* The logo mark beside the name */
.brand { display: inline-flex; align-items: center; gap: 0.6rem; }
.brand svg, .brand img { width: 1.75rem; height: 1.75rem; flex: none; }

/* Footer */
.site-footer { border-top: 1px solid var(--line); padding-block: var(--space-4); font-size: var(--step--1); color: var(--ink-2); }
.site-footer .wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 2rem; }

/* Motion. All of it is switched on by script.js adding "js" to <html>; without script everything is simply visible. */
.js .reveal { opacity: 0; transform: translateY(1.25rem); transition: opacity 0.7s cubic-bezier(0.2, 0.7, 0.2, 1), transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1); transition-delay: calc(var(--i, 0) * 90ms); }
.js .reveal.in { opacity: 1; transform: none; }
.js .display .word { display: inline-block; opacity: 0; transform: translateY(0.5em); animation: rise 0.8s cubic-bezier(0.2, 0.7, 0.2, 1) forwards; animation-delay: calc(var(--w) * 60ms + 100ms); }
@keyframes rise { to { opacity: 1; transform: none; } }
.js .photo img { transition: transform 0.2s linear; will-change: transform; }
.site-header { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter: blur(10px); transition: box-shadow 0.3s ease; }
.site-header.scrolled { box-shadow: 0 1px 0 var(--line), 0 12px 30px -24px color-mix(in srgb, var(--ink) 60%, transparent); }

/* A line of words that drifts sideways: specialities, services, places */
.ticker { overflow: hidden; border-block: 1px solid var(--line); padding-block: var(--space-2); }
.ticker__track { display: flex; gap: 3rem; width: max-content; font-family: var(--font-display); font-size: var(--step-2); white-space: nowrap; animation: drift 40s linear infinite; }
.ticker__track span::after { content: "◆"; margin-left: 3rem; color: var(--accent); font-size: 0.6em; vertical-align: middle; }
@keyframes drift { to { transform: translateX(-50%); } }

/* A 3D object in place of the hero picture (script.js draws it; the striped panel shows if it can't) */
.photo--scene { border: 0; background: none; }
.photo--scene canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

/* Photo credits */
.credits { font-size: 0.72rem; color: var(--ink-2); }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .js .reveal, .js .display .word { opacity: 1; transform: none; transition: none; animation: none; }
  .ticker__track { animation: none; flex-wrap: wrap; width: auto; white-space: normal; }
  .btn { transition: none; }
}`;

const SCALE = `  --step--1: clamp(0.8rem, 0.78rem + 0.1vw, 0.875rem);
  --step-0: clamp(1rem, 0.96rem + 0.2vw, 1.125rem);
  --step-1: clamp(1.2rem, 1.1rem + 0.5vw, 1.5rem);
  --step-2: clamp(1.8rem, 1.4rem + 2vw, 3rem);
  --step-3: clamp(2.6rem, 1.4rem + 5.4vw, 5.6rem);
  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 1.5rem;
  --space-4: 2.5rem;
  --space-5: clamp(3.5rem, 8vw, 7rem);
  --wrap: 72rem;`;

/** The finished stylesheet for a direction. */
export function kitCss(d: DesignDirection): string {
  const tokens = Object.entries(d.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `/* Design kit: ${d.name}. Colours, type and spacing are the variables below; change them there. */
:root {
${tokens}
${SCALE}
}

${BASE_CSS}

/* ${d.name} */
${d.extra}

${PAGE_RULES_MARKER}
`;
}

/** The HTML each component expects. CAPITALS are for the model to replace. */
export function kitMarkup(d: DesignDirection, stylesheet: string): string {
  return `<!-- <head>: search engines and link previews read this -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAIN PHRASE PEOPLE SEARCH FOR | BUSINESS NAME (under 60 characters)</title>
<meta name="description" content="WHAT IT IS, WHERE, AND WHY TO CLICK (120 to 155 characters).">
<link rel="canonical" href="[https://your-domain.example/]">
<meta property="og:type" content="website">
<meta property="og:title" content="SAME AS THE TITLE">
<meta property="og:description" content="SAME AS THE DESCRIPTION">
<meta property="og:image" content="[https://your-domain.example/assets/share.jpg]">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="assets/logo.svg" type="image/svg+xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness OR Organization OR Person","name":"BUSINESS NAME","description":"ONE SENTENCE","url":"[https://your-domain.example/]","telephone":"[PHONE]","address":{"@type":"PostalAddress","streetAddress":"[STREET]","addressLocality":"[CITY]","addressCountry":"[COUNTRY CODE]"},"openingHours":"[Mo-Sa 07:00-15:00]"}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${d.fonts.replace(/&/g, "&amp;")}" rel="stylesheet">
<link rel="stylesheet" href="${stylesheet}">
<script src="script.js" defer></script>

<!-- Header -->
<a class="skip" href="#main">Skip to content</a>
<header class="site-header"><div class="wrap">
  <a class="brand" href="#"><img src="assets/logo.svg" alt="" width="28" height="28">BUSINESS NAME</a>
  <nav class="nav" aria-label="Main"><a href="#SECTION-ID">LINK</a><a href="#contact">Contact</a></nav>
</div></header>

<!-- Hero (inside <main id="main">). One <em> phrase in the headline takes the accent. -->
<section class="hero"><div class="wrap">
  <div class="hero__text">
    <p class="eyebrow">PLACE OR KIND OF BUSINESS</p>
    <h1 class="display">HEADLINE WITH <em>ONE PHRASE</em> STRESSED</h1>
    <p class="lede">ONE OR TWO SENTENCES: WHAT IT IS AND WHO IT IS FOR.</p>
    <div class="actions"><a class="btn" href="#contact">MAIN ACTION</a><a class="btn btn--ghost" href="#SECTION-ID">SECOND ACTION</a></div>
    <dl class="facts"><div><dt>LABEL</dt><dd>SHORT FACT</dd></div><div><dt>LABEL</dt><dd>SHORT FACT</dd></div></dl>
  </div>
  <figure class="photo"><span class="photo__label">Photo: WHAT THE PICTURE SHOULD SHOW</span></figure>
  <!-- with a real picture: <figure class="photo"><img src="assets/NAME.jpg" alt="WHAT IT SHOWS" width="W" height="H" data-parallax></figure> -->
</div></section>

<!-- 3D object instead of the hero picture: only when the user asks for 3D, or for a tech or studio page -->
<figure class="photo photo--scene"><canvas data-scene aria-hidden="true"></canvas></figure>

<!-- Ticker: a drifting line of specialities; write the list twice so it loops -->
<div class="ticker" aria-hidden="true"><div class="ticker__track"><span>ITEM</span><span>ITEM</span><span>ITEM</span><span>ITEM</span><span>ITEM</span><span>ITEM</span></div></div>

<!-- Section heading (every section starts with it) -->
<section class="section" id="SECTION-ID"><div class="wrap">
  <div class="section-head">
    <p class="eyebrow">01 · SHORT LABEL</p>
    <h2>SECTION HEADLINE</h2>
    <p>ONE SENTENCE OF INTRODUCTION.</p>
  </div>
  <div class="section-body">CONTENT: A MENU, A SPLIT, OR (with class "section-body section-body--wide") CARDS</div>
</div></section>

<!-- Price list: for products or services with prices -->
<ul class="menu">
  <li><div class="menu__row"><h3 class="menu__name">ITEM</h3><span class="menu__dots" aria-hidden="true"></span><span class="menu__price">PRICE</span></div>
    <p class="menu__desc">ONE LINE ABOUT IT.</p></li>
</ul>

<!-- Cards: for services, features or steps without prices (numbered automatically) -->
<div class="cards"><article class="card"><h3>TITLE</h3><p>TWO SENTENCES.</p></article></div>

<!-- Two columns: a picture beside content, or details beside a form -->
<div class="split">
  <dl class="info"><div><dt>Hours</dt><dd>VALUE</dd></div><div><dt>Address</dt><dd>VALUE</dd></div></dl>
  <form class="form" novalidate>
    <div class="field"><label for="name">Name</label><input id="name" name="name" autocomplete="name" required><p class="field__error" id="name-error" aria-live="polite"></p></div>
    <div class="field"><label for="message">Message</label><textarea id="message" name="message" required></textarea><p class="field__error" id="message-error" aria-live="polite"></p></div>
    <button class="btn" type="submit">SEND</button>
    <p class="form__note" role="status" aria-live="polite"></p>
  </form>
</div>

<!-- Story: long-form text beside a picture (put it in a section-body--wide) -->
<div class="split"><figure class="photo"><span class="photo__label">Photo: WHO OR HOW</span></figure>
  <div class="prose"><p>THE ONE THING TO KNOW ABOUT THIS BUSINESS.</p><p>TWO OR THREE SENTENCES ON HOW THEY WORK.</p></div></div>

<!-- Stats: only numbers the user gave, or in [brackets] -->
<dl class="stats"><div><dt>LABEL</dt><dd data-count="NUMBER">NUMBER</dd></div></dl>

<!-- Gallery: four pictures, the first larger -->
<div class="gallery"><figure class="photo"><span class="photo__label">Photo: SUBJECT</span></figure></div>

<!-- Quote: a real one, or this place for one -->
<figure class="quote"><blockquote>[A sentence from a customer]</blockquote><figcaption>[Name, where they are from]</figcaption></figure>

<!-- Questions and answers: real questions customers ask about this kind of business -->
<div class="faq"><details><summary>QUESTION</summary><p>ANSWER IN TWO SENTENCES.</p></details></div>

<!-- Band: one strong statement and an action, once, near the end -->
<section class="band"><div class="wrap"><h2>STATEMENT</h2><a class="btn" href="#contact">ACTION</a></div></section>

<!-- Footer -->
<footer class="site-footer"><div class="wrap"><p>&copy; <span data-year></span> BUSINESS NAME</p><p>ADDRESS · PHONE</p><p class="credits">Photos: CREDIT LINES FROM find_photos</p></div></footer>`;
}

/** How to use the kit; returned with the markup. */
export const KIT_RULES = [
  "The stylesheet is finished: link it, and don't rewrite, restate or duplicate its rules. Build the page from the components above; they are already responsive and accessible.",
  `Rules only this page needs (rarely more than 40 lines) go at the end of the stylesheet, below the line "${PAGE_RULES_MARKER}". To change a colour or font, change its variable in :root.`,
  "Text stays left-aligned. Don't centre sections, and don't add min-height to the hero.",
  "No emoji anywhere on the page, as pictures, icons or decoration. A picture is a .photo figure: put the user's image inside as <img alt=\"…\">, or leave the label saying what photo belongs there.",
  "Things with prices go in the price list (.menu), not in cards. Use cards for services, features or steps.",
  "Write specific copy for this business. When the user gave no name or prices, choose a fitting name and plausible prices yourself, without brackets, and say in your final answer that they are placeholders. Facts only the owner knows (address, phone, email, opening hours) go in [square brackets]. Don't make claims you can't know (\"organic\", \"locally sourced\", \"48-hour fermented\", \"since 1990\"). Your final answer lists everything the user must fill in or confirm.",
  "Forms work as given: script.js checks required fields and email addresses and writes into each .field__error (id = the field's id + \"-error\"). Sending isn't connected to anything; say so in your final answer.",
  "A landing page is long enough to convince: unless the user asks for something short, build 7 to 9 sections in an order that tells the story, e.g. hero, ticker, what they offer (price list or cards), the story beside a picture, how it works or stats, gallery, a customer quote, questions and answers, the band, contact, footer. Everything the user asked for comes first; the rest supports it. Write index.html in steps of two or three sections (create_file, then insert_lines), not all at once.",
  "Vary the sections: tint every second or third with class \"section section--tint\", alternate which side the picture is on, use the band once. Number the eyebrows 01, 02, 03.",
  "script.js is finished too: it reveals content on scroll, animates the headline, moves pictures slightly as the page scrolls, validates forms and fills in the year. Switch its effects on in the HTML: class \"reveal\" on each block that should fade up as it scrolls into view (section heads, list items, cards, the form), data-parallax on <img> inside .photo, data-count=\"120\" on a number that should count up. Don't write your own animation code or load an animation library unless the user asks for something the kit doesn't do.",
  "The logo: design_kit made assets/logo.svg (an abstract mark in the accent colour, also the favicon) when you gave it the business name. Use it as given in the header; if the user has their own logo file, use that instead. Never draw or copy another company's logo; client or partner logos are [bracketed] text until the user supplies the files.",
  "Pictures: when you have find_photos, call it for the hero and for one more section (queries that name the subject, e.g. \"sourdough loaves bakery\"), put the files it saves into .photo figures with the alt, width and height it returns, and keep its credit lines in the footer. With generate_image instead, generate them. With neither, leave labelled photo places.",
  "Search engines: one topic per page; the phrase people would search for (\"bakery in [city]\") appears naturally in the <title>, the h1, the first paragraph and one h2; fill in every tag of the <head> block above including the JSON-LD (use LocalBusiness for a shop or office with an address); headings go h1, h2, h3 without skipping; link text says where it goes (not \"click here\").",
];

/** The line in the script below which the page's own code goes. */
export const PAGE_SCRIPT_MARKER = "// ---- This page's own code goes below this line ----";

/** Pinned so a page keeps working when the library moves on. */
export const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js";

/**
 * The kit's script: motion, forms and the optional 3D object. No dependencies; the 3D part
 * loads three.js only on pages that have a <canvas data-scene>. Everything degrades to a
 * plain, readable page when it can't run.
 */
export const KIT_JS = `// Design kit script. Effects are switched on from the HTML: class "reveal", data-parallax, data-count, <canvas data-scene>.
(() => {
  const root = document.documentElement;
  root.classList.add("js");
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Headline: each word rises in turn.
  for (const h of document.querySelectorAll(".display")) {
    let w = 0;
    const wrap = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\\s+)/)) {
            if (!part.trim()) { frag.append(part); continue; }
            const span = document.createElement("span");
            span.className = "word"; span.style.setProperty("--w", w++); span.textContent = part;
            frag.append(span);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1) wrap(child);
      }
    };
    wrap(h);
  }

  // Reveal on scroll; siblings follow each other.
  const reveals = [...document.querySelectorAll(".reveal")];
  for (const el of reveals) el.style.setProperty("--i", [...el.parentElement.children].filter((c) => c.classList.contains("reveal")).indexOf(el));
  if ("IntersectionObserver" in window && !calm) {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); seen.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (const el of reveals) seen.observe(el);
  } else for (const el of reveals) el.classList.add("in");

  // Numbers that count up when they come into view: <span data-count="120">120</span>
  const counters = [...document.querySelectorAll("[data-count]")];
  if ("IntersectionObserver" in window && !calm) {
    const count = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        count.unobserve(e.target);
        const end = Number(e.target.dataset.count) || 0, start = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - start) / 1200);
          e.target.textContent = Math.round(end * (1 - Math.pow(1 - t, 3))).toLocaleString();
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    }, { threshold: 0.6 });
    for (const el of counters) count.observe(el);
  }

  // Pictures drift a little as the page scrolls; the header gains a shadow.
  const drifting = [...document.querySelectorAll("img[data-parallax]")];
  const header = document.querySelector(".site-header");
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (header) header.classList.toggle("scrolled", scrollY > 8);
      if (calm) return;
      for (const img of drifting) {
        const box = img.parentElement.getBoundingClientRect();
        const mid = Math.max(-1, Math.min(1, (box.top + box.height / 2 - innerHeight / 2) / innerHeight));
        img.style.transform = "scale(1.12) translateY(" + (mid * -6).toFixed(2) + "%)";
      }
    });
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Forms: required fields and email addresses, with a message under each field.
  for (const form of document.querySelectorAll("form.form")) {
    const note = form.querySelector(".form__note");
    const errorFor = (field) => document.getElementById(field.id + "-error") || field.parentElement.querySelector(".field__error");
    const check = (field) => {
      const value = field.value.trim();
      let message = "";
      if (field.required && !value) message = "Please fill this in.";
      else if (field.type === "email" && value && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value)) message = "That email address doesn't look right.";
      const out = errorFor(field);
      if (out) out.textContent = message;
      field.setAttribute("aria-invalid", message ? "true" : "false");
      return !message;
    };
    const fields = [...form.querySelectorAll("input, textarea, select")];
    for (const f of fields) f.addEventListener("blur", () => check(f));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const bad = fields.filter((f) => !check(f));
      if (bad.length) { bad[0].focus(); if (note) note.textContent = ""; return; }
      if (note) note.textContent = form.dataset.thanks || "Thank you. Your message is ready to send; this form isn't connected to an inbox yet.";
      form.reset();
    });
  }

  for (const el of document.querySelectorAll("[data-year]")) el.textContent = new Date().getFullYear();

  // 3D object: a faceted solid inside a wireframe, in the page's accent colour. It turns slowly,
  // leans toward the pointer and rotates with the scroll. Loads three.js only when asked for.
  const canvas = document.querySelector("canvas[data-scene]");
  if (canvas && !calm) {
    import("${THREE_URL}").then((THREE) => {
      const css = getComputedStyle(root);
      const accent = new THREE.Color(css.getPropertyValue("--accent").trim() || "#888");
      const ink = new THREE.Color(css.getPropertyValue("--ink").trim() || "#111");
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
      camera.position.z = 7.5;
      const group = new THREE.Group();
      const solid = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 0), new THREE.MeshStandardMaterial({ color: accent, flatShading: true, roughness: 0.45, metalness: 0.1 }));
      const cage = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.05, 1)), new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.35 }));
      group.add(solid, cage);
      scene.add(group, new THREE.HemisphereLight(0xffffff, ink, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(3, 4, 5);
      scene.add(key);
      const size = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      size();
      addEventListener("resize", size);
      let px = 0, py = 0;
      addEventListener("pointermove", (e) => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; });
      let visible = true;
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(canvas);
      const frame = (t) => {
        requestAnimationFrame(frame);
        if (!visible) return;
        const s = t / 1000;
        group.rotation.y += (px * 0.9 + s * 0.25 + scrollY * 0.002 - group.rotation.y) * 0.06;
        group.rotation.x += (py * 0.6 + Math.sin(s * 0.4) * 0.15 - group.rotation.x) * 0.06;
        cage.rotation.z = s * -0.08;
        renderer.render(scene, camera);
      };
      requestAnimationFrame(frame);
      canvas.dataset.ready = "true";
    }).catch(() => { canvas.closest(".photo")?.classList.remove("photo--scene"); canvas.remove(); });
  }
})();

${PAGE_SCRIPT_MARKER}
`;

/** A small stable number from a name, so the same business always gets the same mark. */
function hash(text: string): number {
  let h = 2166136261;
  for (const c of text.toLowerCase().trim()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Abstract marks on a 32×32 grid: `a` is the accent colour, `b` the colour that sits on it. */
const MARKS: ((a: string, b: string) => string)[] = [
  (a, b) => `<circle cx="16" cy="16" r="15" fill="${a}"/><path d="M6 20a10 10 0 0 1 20 0z" fill="${b}"/>`,
  (a, b) => `<rect width="32" height="32" rx="7" fill="${a}"/><path d="M8 23V9h7a7 7 0 0 1 0 14z" fill="${b}"/>`,
  (a, b) => `<circle cx="16" cy="16" r="15" fill="${a}"/><circle cx="16" cy="16" r="9" fill="none" stroke="${b}" stroke-width="2.5"/><circle cx="16" cy="16" r="3" fill="${b}"/>`,
  (a, b) => `<rect width="32" height="32" rx="7" fill="${a}"/><path d="M7 22h18M7 16h18M7 10h18" stroke="${b}" stroke-width="2.5" stroke-linecap="round"/>`,
  (a, b) => `<path d="M16 1 31 16 16 31 1 16z" fill="${a}"/><path d="M16 9 23 16 16 23 9 16z" fill="${b}"/>`,
  (a, b) => `<circle cx="16" cy="16" r="15" fill="${a}"/><path d="M16 5c6 4 6 18 0 22-6-4-6-18 0-22z" fill="${b}"/>`,
  (a, b) => `<rect width="32" height="32" rx="16" fill="${a}"/><path d="M9 21 16 9l7 12z" fill="${b}"/>`,
  (a, b) => `<rect width="32" height="32" rx="7" fill="${a}"/><circle cx="12" cy="16" r="5" fill="${b}"/><circle cx="20" cy="16" r="5" fill="none" stroke="${b}" stroke-width="2.5"/>`,
];

/**
 * A logo mark for a business: an abstract shape in the direction's accent colour, the same one
 * every time for the same name. A stand-in until the business has its own logo, and its favicon.
 */
export function logoSvg(name: string, d: DesignDirection): string {
  const mark = MARKS[hash(name) % MARKS.length]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="${name.replace(/[<>&"]/g, "")} logo">${mark(d.tokens["--accent"]!, d.tokens["--accent-ink"]!)}</svg>\n`;
}
