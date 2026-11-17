import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The packaged app needs files the packager would otherwise leave out or pack where they can't be loaded.
const config = readFileSync(join(__dirname, "..", "electron-builder.yml"), "utf8");

describe("packaging", () => {
  it("ships TypeScript's lib files as a resources folder, since .d.ts files are stripped from node_modules", () => {
    expect(config).toMatch(/- from: node_modules\/typescript\/lib\n\s+to: typescript-lib\n\s+filter:\n\s+- "lib\*\.d\.ts"/);
  });

  it("keeps native code and Tree-sitter grammars on disk, outside app.asar", () => {
    expect(config).toContain('- "**/*.node"');
    expect(config).toContain('- "**/node_modules/sqlite-vec-*/**"');
    expect(config).toContain('- "**/node_modules/@vscode/tree-sitter-wasm/wasm/**"');
  });
});
