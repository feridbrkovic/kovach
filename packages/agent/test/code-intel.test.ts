import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLibPath } from "../src/code-intel/typescript.js";
import { CODE_TOOLS, loadTypescript, resetCodeIntel, type ToolContext, Workspace } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-ci-"));
});
afterEach(() => {
  resetCodeIntel();
  rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), c);
  }
}

const tool = (name: string) => CODE_TOOLS.find((t) => t.name === name)!;
const ctx = (): ToolContext => ({
  workspace: new Workspace(dir),
  approve: async () => true,
  checks: [],
  limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 60_000 },
});
const call = async (name: string, args: unknown) => (await tool(name).run(args as never, ctx())).content;

/** Change a file and make sure its modification time moves, as a real edit would. */
function touch(f: string, content: string, secondsLater = 5) {
  writeFileSync(join(dir, f), content);
  const t = new Date(Date.now() + secondsLater * 1000);
  utimesSync(join(dir, f), t, t);
}

describe("code navigation in a TypeScript project", () => {
  beforeEach(() =>
    write({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "preserve" }, include: ["src"] }),
      "src/cart.ts": "export interface Item { cents: number }\n\nexport function total(items: Item[]): number {\n  return items.reduce((s, i) => s + i.cents, 0);\n}\n",
      "src/checkout.ts": 'import { total } from "./cart";\n\nexport const pay = () => total([{ cents: 100 }]);\n',
      "src/report.ts": "// An unrelated function with the same name.\nfunction total(rows: number[]) {\n  return rows.length;\n}\nexport const count = total([1, 2]);\n",
      "src/Price.tsx": 'import { total } from "./cart";\n\nexport function Price() {\n  return <span>{total([])}</span>;\n}\n',
    }),
  );

  it("finds definitions by exact name, with near matches when there is none", async () => {
    const found = await call("find_symbol", { name: "total" });
    expect(found).toContain("function total — src/cart.ts:3\n    export function total(items: Item[]): number {");
    expect(found).toContain("function total — src/report.ts:2");
    expect(found).toMatch(/\n2 definitions share this name\. For the uses of one, call find_references with its path and line, e\.g\. \{"name": "total", "path": "src\/cart\.ts", "line": 3\}\.$/);
    expect(await call("find_symbol", { name: "Item", kind: "interface" })).toBe(
      'interface Item — src/cart.ts:1\n    export interface Item { cents: number }\nFor its uses, call find_references {"name": "Item", "path": "src/cart.ts", "line": 1}.',
    );
    expect(await call("find_symbol", { name: "Pric" })).toMatch(/^No definition named Pric\. Similar names:\nfunction Price — src\/Price\.tsx:3/);
    expect(await call("find_symbol", { name: "nothingLikeThis" })).toMatch(/^No definition of nothingLikeThis in the project's 4 indexed files/);
  });

  it("finds type-aware references from a definition, leaving out a same-named function elsewhere", async () => {
    const refs = await call("find_references", { name: "total", path: "src/cart.ts", line: 3 });
    expect(refs).toMatch(/^\d+ references to total \(TypeScript 5\.\d+\.\d+, type-aware\):/);
    expect(refs).toContain("src/checkout.ts:3: export const pay = () => total([{ cents: 100 }]);");
    expect(refs).toContain("src/Price.tsx:4:");
    expect(refs).not.toContain("src/report.ts");
    // Without a location, two definitions can't be told apart: uses by name, with a hint.
    const byName = await call("find_references", { name: "total" });
    expect(byName).toMatch(/^2 TS\/JS definitions share this name; give path and line/);
    expect(byName).toContain("src/report.ts:5:");
    // A wrong line is pointed out, with where the definitions really are.
    expect(await call("find_references", { name: "total", path: "src/cart.ts", line: 4 })).toMatch(/^No total at src\/cart\.ts:4; it is defined at src\/cart\.ts:3, src\/report\.ts:2\. Matching by name instead\./);
  });

  it("reports type errors in about a second, and sees an edit right away", async () => {
    expect(await call("diagnostics", { paths: ["src/checkout.ts"] })).toBe("No errors.\nsrc/checkout.ts: no errors");
    touch("src/checkout.ts", 'import { total } from "./cart";\n\nexport const pay = () => total([{ cents: "100" }]);\n');
    const broken = await call("diagnostics", { paths: ["src/checkout.ts"] });
    expect(broken).toMatch(/^1 error\.\nsrc\/checkout\.ts:3:35 error TS2322: Type 'string' is not assignable to type 'number'\./);
    // Without paths: the files changed recently.
    expect(await call("diagnostics", {})).toContain("src/checkout.ts:3:35 error TS2322");
  });

  it("indexes new files and forgets deleted ones between calls", async () => {
    touch("src/discount.ts", "export const applyDiscount = (c: number) => c * 0.9;\n");
    expect(await call("find_symbol", { name: "applyDiscount" })).toContain("function applyDiscount — src/discount.ts:1");
    rmSync(join(dir, "src/discount.ts"));
    expect(await call("find_symbol", { name: "applyDiscount" })).toMatch(/^No definition/);
  });

  it("finds TypeScript's lib files where the packaged app ships them when they aren't next to typescript.js", () => {
    const { ts } = loadTypescript(dir);
    const real = ts.getDefaultLibFilePath({});
    expect(defaultLibPath(ts, {}, join(dir, "nowhere"))).toBe(real); // the normal case: left alone

    const stripped = { getDefaultLibFilePath: () => join(dir, "asar/typescript/lib/lib.d.ts") };
    write({ "Resources/typescript-lib/lib.d.ts": "/// <reference lib=\"es5\" />\n" });
    expect(defaultLibPath(stripped, {}, join(dir, "Resources/typescript-lib"))).toBe(join(dir, "Resources/typescript-lib/lib.d.ts"));
    // Nowhere to be found: the original path, so TypeScript reports it the usual way.
    expect(defaultLibPath(stripped, {}, join(dir, "nowhere"))).toBe(join(dir, "asar/typescript/lib/lib.d.ts"));
  });

  it("uses the project's own TypeScript only when it has the language service API", () => {
    write({ "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", main: "index.js" }), "node_modules/typescript/index.js": "module.exports = { version: '7.0.2' };" });
    const { ts, source } = loadTypescript(dir);
    expect(source).toBe("bundled");
    expect(ts.version).toMatch(/^5\./);
  });
});

describe("code navigation in a WordPress plugin", () => {
  beforeEach(() =>
    write({
      "optics-core.php": "<?php\n/** Plugin Name: Optics Core */\nrequire __DIR__ . '/includes/lens.php';\nadd_action('init', 'optics_register_lens');\nadd_filter('woocommerce_cart_item_price', 'optics_lens_price', 10, 3);\n",
      "includes/lens.php":
        "<?php\nclass Optics_Lens_Pricing extends Optics_Base {\n  const VAT = 17;\n  public function price(int $index): int { return $this->with_vat($index * 100); }\n  private function with_vat($c) { return intdiv($c * (100 + self::VAT), 100); }\n}\nfunction optics_register_lens() { register_post_type('lens', []); }\nfunction optics_lens_price($price) { return (new Optics_Lens_Pricing())->price(2); }\n",
    }),
  );

  it("finds functions, methods with their class, and constants", async () => {
    expect(await call("find_symbol", { name: "price" })).toMatch(/^method Optics_Lens_Pricing\.price — includes\/lens\.php:4\n    public function price\(int \$index\): int \{ return \$this->with_vat\(\$index \* 100\); \}\nFor its uses/);
    expect(await call("find_symbol", { name: "VAT" })).toContain("constant Optics_Lens_Pricing.VAT — includes/lens.php:3");
  });

  it("finds hook callbacks registered by name, and `new` uses of a class", async () => {
    const hooks = await call("find_references", { name: "optics_lens_price" });
    expect(hooks).toContain("Defined at: includes/lens.php:8");
    expect(hooks).toContain("optics-core.php:5: add_filter('woocommerce_cart_item_price', 'optics_lens_price', 10, 3);");
    expect(await call("find_references", { name: "Optics_Lens_Pricing" })).toContain("includes/lens.php:8:");
  });

  it("reports syntax errors in PHP", async () => {
    touch("includes/lens.php", "<?php\nfunction broken( {\n  return 1;\n}\n");
    const out = await call("diagnostics", { paths: ["includes/lens.php", "readme.txt"] });
    expect(out).toMatch(/^1 error\.\nincludes\/lens\.php:2:\d+ syntax error/);
    expect(out).toContain("readme.txt: not found");
  });

  it("refuses paths outside the project or secrets files", async () => {
    await expect(call("diagnostics", { paths: ["../etc/passwd"] })).rejects.toThrow(/outside the project/);
    await expect(call("diagnostics", { paths: [".env"] })).rejects.toThrow(/secrets/);
  });
});
