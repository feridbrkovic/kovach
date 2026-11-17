import { isIP } from "node:net";

/** Only public web pages are opened as design references: no local files, hosts or private addresses. */
export function isPublicPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") && isIP(host) === 0) return false; // localhost, intranet names
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return false;
  if (isIP(host) === 6) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  return true;
}

/** Runs in the reference page: its background, text and accent colours, fonts and button corners. */
export const REFERENCE_SCRIPT = `(() => {
  const hex = (c) => {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c || "");
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return undefined;
    return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
  };
  const style = (el) => getComputedStyle(el);
  const first = (family) => (family || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  let background;
  for (const el of [...document.elementsFromPoint(innerWidth / 2, 200), document.body, document.documentElement]) {
    background = el && hex(style(el).backgroundColor);
    if (background) break;
  }
  background = background || "#ffffff";
  const heading = document.querySelector("h1, h2") || document.body;
  const saturation = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
  const counts = new Map();
  for (const el of document.querySelectorAll("a, button, [role=button], input[type=submit]")) {
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 20) continue;
    const bg = hex(style(el).backgroundColor);
    if (!bg || bg === background || saturation(bg) < 40) continue;
    const entry = counts.get(bg) || { n: 0, on: hex(style(el).color), radius: parseFloat(style(el).borderTopLeftRadius) || 0 };
    entry.n++;
    counts.set(bg, entry);
  }
  let accent, on, radius;
  for (const [colour, entry] of [...counts].sort((x, y) => y[1].n - x[1].n).slice(0, 1)) { accent = colour; on = entry.on; radius = entry.radius; }
  if (!accent) { const link = document.querySelector("a[href]"); accent = (link && hex(style(link).color)) || hex(style(heading).color) || "#333333"; }
  return { background, text: hex(style(document.body).color) || hex(style(heading).color) || "#111111", accent, onAccent: on, fontDisplay: first(style(heading).fontFamily), fontBody: first(style(document.body).fontFamily), radius };
})()`;
