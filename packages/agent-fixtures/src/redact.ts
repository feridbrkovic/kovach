/**
 * Deterministic secret redaction for fixtures.
 *
 * Fixtures may be committed to a public repository, so every string a
 * recorder writes goes through `redact`. The rules are deliberately narrow,
 * well-known token formats plus `.env`-style assignments, and replace each
 * match with `[REDACTED:<kind>]`. Redaction is idempotent.
 */

export type RedactionKind =
  | "private_key"
  | "url_credentials"
  | "github_token"
  | "aws_access_key"
  | "stripe_key"
  | "jwt"
  | "secret_assignment";

const marker = (kind: RedactionKind) => `[REDACTED:${kind}]`;
const MARKER_ONLY = /^\[REDACTED:[a-z_]+\]$/;

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

/** Keys that name a secret, e.g. DB_PASSWORD, GITHUB_TOKEN, NEXT_PUBLIC_API_KEY. Upper case only. */
const SECRET_KEY = String.raw`[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*`;

const RULES: Rule[] = [
  {
    // A whole PEM / PGP private key block. A block cut off before its END line
    // (e.g. truncated output) is redacted to the end of the text.
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
    replace: () => marker("private_key"),
  },
  {
    // scheme://user:password@host keeps the scheme and host.
    kind: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}${marker("url_credentials")}@`,
  },
  {
    // No word boundaries: the prefixes are distinctive, and output often glues
    // a token to the text before it.
    kind: "github_token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g,
    replace: () => marker("github_token"),
  },
  {
    kind: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => marker("aws_access_key"),
  },
  {
    kind: "stripe_key",
    pattern: /[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
    replace: () => marker("stripe_key"),
  },
  {
    // header.payload.signature, both JSON parts base64url-encoded ("eyJ" = '{"').
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g,
    replace: () => marker("jwt"),
  },
  {
    // KEY=value on its own line (.env, shell export, constant declaration).
    kind: "secret_assignment",
    pattern: new RegExp(
      String.raw`^([ \t]*(?:-[ \t]+)?(?:export[ \t]+)?(?:(?:const|let|var|readonly)[ \t]+)?${SECRET_KEY}[ \t]*=(?!=)[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\n]*?)([ \t]*;?[ \t]*)$`,
      "gm",
    ),
    replace: (match, prefix, value, suffix) =>
      isSecretValue(value ?? "") ? `${prefix}${marker("secret_assignment")}${suffix}` : match,
  },
];

/**
 * Values that are clearly not literal secrets: empty, numbers, booleans,
 * variable references and code expressions (`process.env.X`, `getToken()`).
 * Anything else, including a bare word, is treated as a secret.
 */
function isSecretValue(raw: string): boolean {
  const quoted = /^(["']).*\1$/.test(raw);
  const value = quoted ? raw.slice(1, -1) : raw;
  if (value.trim() === "") return false;
  if (MARKER_ONLY.test(value)) return false;
  if (quoted) return true;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return false;
  if (/^(?:true|false|null|none|undefined)$/i.test(value)) return false;
  // Shell / template references: $VAR, ${VAR}
  if (value.startsWith("$")) return false;
  // Environment lookups: process.env.X, import.meta.env.X, os.environ["X"]
  if (/^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv)\b/.test(value)) return false;
  // Call or index expression: getToken(), readSecret("x"), env["X"]
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*[([]/.test(value)) return false;
  return true;
}

/** Masks known secret formats in `text`. Deterministic and idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

/** Applies `redact` to every string inside a JSON-like value. Object keys are kept as is. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
