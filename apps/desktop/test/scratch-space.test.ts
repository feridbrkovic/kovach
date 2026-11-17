import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatBytes, freeScratchSpace, removeScratch, scratchUsage } from "../src/main/scratch-space";

let root: string;
const put = (rel: string, bytes: number) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), Buffer.alloc(bytes));
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kovach-scratch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("space used by sessions without a project", () => {
  it("counts what the folders hold and how much of it would come back with an install or a build", () => {
    put("ses_a/src/app.tsx", 1000);
    put("ses_a/node_modules/expo/index.js", 50_000);
    put("ses_a/ios/Pods/Pod.a", 20_000);
    put("ses_b/index.html", 3000);
    expect(scratchUsage(root)).toEqual({ sessions: 2, bytes: 74_000, regrowableBytes: 70_000 });
    expect(scratchUsage(join(root, "missing"))).toEqual({ sessions: 0, bytes: 0, regrowableBytes: 0 });
  });

  it("removes packages and build output, keeps the files, and leaves the running session alone", () => {
    put("ses_a/src/app.tsx", 1000);
    put("ses_a/node_modules/expo/index.js", 50_000);
    put("ses_a/dist/index.html", 2000);
    put("ses_live/node_modules/x.js", 9000);
    const freed = freeScratchSpace(root, "ses_live");
    expect(freed).toEqual({ freedBytes: 52_000, folders: 2 });
    expect(existsSync(join(root, "ses_a/src/app.tsx"))).toBe(true);
    expect(existsSync(join(root, "ses_a/node_modules"))).toBe(false);
    expect(existsSync(join(root, "ses_live/node_modules/x.js"))).toBe(true);
  });

  it("removes a deleted session's folder, and nothing outside the scratch root", () => {
    put("ses_a/src/app.tsx", 10);
    put("keep.txt", 10);
    removeScratch(root, "../");
    removeScratch(root, "ses_a");
    expect(existsSync(join(root, "ses_a"))).toBe(false);
    expect(existsSync(join(root, "keep.txt"))).toBe(true);
  });

  it("writes sizes the way people read them", () => {
    expect([formatBytes(900), formatBytes(4_400_000), formatBytes(3_700_000_000)]).toEqual(["1 KB", "4 MB", "3.7 GB"]);
  });
});
