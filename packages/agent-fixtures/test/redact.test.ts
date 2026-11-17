import { describe, expect, it } from "vitest";
import { redact, redactDeep } from "../src/index.js";
import { FAKE } from "./helpers.js";

describe("redact: token formats", () => {
  it.each([
    ["GitHub classic token", FAKE.githubClassic, "github_token"],
    ["GitHub OAuth token", FAKE.githubOauth, "github_token"],
    ["GitHub fine-grained token", FAKE.githubPat, "github_token"],
    ["AWS access key id", FAKE.aws, "aws_access_key"],
    ["Stripe live key", FAKE.stripeLive, "stripe_key"],
    ["Stripe test key", FAKE.stripeTest, "stripe_key"],
    ["JWT", FAKE.jwt, "jwt"],
  ])("masks a %s and keeps the surrounding text", (_name, secret, kind) => {
    const out = redact(`before ${secret} after`);
    expect(out).toBe(`before [REDACTED:${kind}] after`);
  });

  it("masks a token glued to the text before it", () => {
    expect(redact(`log:x${FAKE.githubClassic}`)).toBe("log:x[REDACTED:github_token]");
  });

  it("masks a token inside a header line", () => {
    expect(redact(`Authorization: Bearer ${FAKE.jwt}`)).toBe("Authorization: Bearer [REDACTED:jwt]");
  });
});

describe("redact: private keys", () => {
  it("masks a complete key block", () => {
    expect(redact(`key:\n${FAKE.privateKey}\ndone`)).toBe("key:\n[REDACTED:private_key]\ndone");
  });

  it("masks a block cut off before its END line", () => {
    const cut = FAKE.privateKey.slice(0, 80);
    expect(redact(`cat id_rsa\n${cut}`)).toBe("cat id_rsa\n[REDACTED:private_key]");
  });
});

describe("redact: URL credentials", () => {
  it("masks user:password and keeps scheme and host", () => {
    expect(redact(`DATABASE at postgres://app:${FAKE.password}@db.local:5432/app`)).toBe(
      "DATABASE at postgres://[REDACTED:url_credentials]@db.local:5432/app",
    );
  });

  it("handles https remotes with a token as password", () => {
    expect(redact(`https://x-access-token:${FAKE.password}@github.com/org/repo.git`)).toBe(
      "https://[REDACTED:url_credentials]@github.com/org/repo.git",
    );
  });
});

describe("redact: secret assignments", () => {
  it.each([
    [`DB_PASSWORD=${FAKE.password}`, "DB_PASSWORD=[REDACTED:secret_assignment]"],
    [`export GITHUB_TOKEN=${FAKE.password}`, "export GITHUB_TOKEN=[REDACTED:secret_assignment]"],
    [`OPENWEATHER_API_KEY="${FAKE.password}"`, "OPENWEATHER_API_KEY=[REDACTED:secret_assignment]"],
    [`  - APP_SECRET='${FAKE.password}'`, "  - APP_SECRET=[REDACTED:secret_assignment]"],
    [`const SESSION_SECRET = "${FAKE.password}";`, "const SESSION_SECRET = [REDACTED:secret_assignment];"],
    [`APIKEY=changeme`, "APIKEY=[REDACTED:secret_assignment]"],
  ])("masks %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("masks every matching line of a .env file and leaves the rest", () => {
    const env = [`NODE_ENV=production`, `PORT=3000`, `STRIPE_SECRET=${FAKE.password}`, `AWS_SECRET_ACCESS_KEY=${FAKE.password}`].join("\n");
    expect(redact(env)).toBe(
      ["NODE_ENV=production", "PORT=3000", "STRIPE_SECRET=[REDACTED:secret_assignment]", "AWS_SECRET_ACCESS_KEY=[REDACTED:secret_assignment]"].join("\n"),
    );
  });

  it("prefers the specific kind when an assignment holds a known token", () => {
    expect(redact(`GH_TOKEN=${FAKE.githubClassic}`)).toBe("GH_TOKEN=[REDACTED:github_token]");
  });
});

describe("redact: no false positives", () => {
  it("leaves ordinary code and tool output unchanged", () => {
    const code = [
      `import { readFileSync } from "node:fs";`,
      `const token = getToken();`,
      `const API_KEY = process.env.API_KEY;`,
      `const SECRET_KEY = readSecret("app");`,
      `API_TOKEN = os.environ["API_TOKEN"]`,
      `MAX_TOKENS=4096`,
      `PASSWORD_MIN_LENGTH = 12`,
      `USE_TOKEN_CACHE=true`,
      `GITHUB_TOKEN=$GITHUB_TOKEN`,
      `NPM_TOKEN=\${NPM_TOKEN}`,
      `ACCESS_KEY=`,
      `if (TOKEN == expected) return;`,
      `interface Config { API_TOKEN: string; password?: string }`,
      `function hashPassword(password: string) { return sha256(password); }`,
      `git clone https://github.com/kovach-dev/kovach.git`,
      `git@github.com:kovach-dev/kovach.git`,
      `commit 3f9a1c27b4e8d0f6a2c5b7e9d1f3a5c7e9b1d3f5`,
      `src/cart.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.`,
      `const sk = "sk_" + mode; // stripe prefix`,
      `const header = "eyJhbGciOi";`,
    ].join("\n");
    expect(redact(code)).toBe(code);
  });
});

describe("redact: properties", () => {
  it("is idempotent", () => {
    const text = [FAKE.githubClassic, `DB_PASSWORD=${FAKE.password}`, FAKE.privateKey, `postgres://u:${FAKE.password}@h/db`].join("\n");
    const once = redact(text);
    expect(redact(once)).toBe(once);
    expect(once).not.toContain(FAKE.password);
  });

  it("redactDeep masks nested strings and keeps keys and other values", () => {
    const value = { cmd: `curl -H "Authorization: Bearer ${FAKE.jwt}"`, n: 3, ok: true, nested: [{ env: `API_KEY=${FAKE.password}` }, null] };
    expect(redactDeep(value)).toEqual({
      cmd: `curl -H "Authorization: Bearer [REDACTED:jwt]"`,
      n: 3,
      ok: true,
      nested: [{ env: "API_KEY=[REDACTED:secret_assignment]" }, null],
    });
  });
});
