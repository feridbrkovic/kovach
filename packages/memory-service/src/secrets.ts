/**
 * Deterministic secret scanner (MASTER_PLAN › Privacy and trust boundaries).
 * Runs before every memory write; any hit refuses the write. The model is never
 * the secret detector.
 */

export interface SecretFinding {
  /** What kind of secret it looks like, e.g. "GitHub token". */
  kind: string;
  /** The match with most of it masked, safe to show. */
  preview: string;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Stripe key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: "API key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { kind: "connection string with a password", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s]+/i },
];

/** KEY=value pairs (any case) whose value looks random enough to be a credential. */
const ENV_PAIR = /\b([A-Za-z][A-Za-z0-9_.-]{2,})\s*[=:]\s*["']?([^\s"'`]{12,})/g;
const SECRETISH_NAME = /(KEY|TOKEN|SECRET|PASS(WORD)?|PWD|CREDENTIAL|AUTH|PRIVATE|SESSION)/i;
/** Plain language: "the prod db password: Xk9…", "api key is 7f3…". */
const SPOKEN = /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[ _-]?key|credentials?)\b[^\n]{0,24}?(?:\bis\b|[:=])\s*["'`]?([^\s"'`,;]{8,})/gi;
/** Random-looking: mixed case or digits mixed with letters, and enough entropy. */
const looksRandom = (v: string, min: number) => entropy(v) >= min && (/\d/.test(v) && /[a-z]/i.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v) && /[^a-zA-Z]/.test(v)));

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const mask = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)}`);

export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) found.push({ kind, preview: mask(m[0]) });
  }
  for (const m of text.matchAll(ENV_PAIR)) {
    const [, name, value] = m;
    if (!name || !value) continue;
    if (SECRETISH_NAME.test(name) && entropy(value) >= 3.3) found.push({ kind: `${name} value`, preview: mask(value) });
  }
  for (const m of text.matchAll(SPOKEN)) {
    const [, what, value] = m;
    if (!what || !value) continue;
    if (looksRandom(value, 3.0) && !found.some((f) => f.preview === mask(value))) found.push({ kind: `${what.toLowerCase()}`, preview: mask(value) });
  }
  return found;
}

/**
 * Mask every secret the scanner finds, keeping the text around it. Used on
 * tool output before it is stored and on anything memory sends to the model.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const ranges: [number, number, string][] = [];
  const add = (start: number, end: number, kind: string) => ranges.push([start, end, kind]);
  for (const { kind, re } of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) add(m.index!, m.index! + m[0].length, kind);
  }
  for (const m of text.matchAll(ENV_PAIR)) {
    const [, name, value] = m;
    if (!name || !value || !SECRETISH_NAME.test(name) || entropy(value) < 3.3) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    add(start, start + value.length, `${name} value`);
  }
  for (const m of text.matchAll(SPOKEN)) {
    const [, what, value] = m;
    if (!what || !value || !looksRandom(value, 3.0)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    add(start, start + value.length, what.toLowerCase());
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let pos = 0;
  for (const [s, e, kind] of ranges) {
    if (s < pos) continue; // overlaps a range already masked
    out += `${text.slice(pos, s)}[redacted ${kind}]`;
    pos = e;
  }
  return out + text.slice(pos);
}
