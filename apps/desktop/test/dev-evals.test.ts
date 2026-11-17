import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalLaunch, evalSummary, evalsRoot, runEvals } from "../src/main/dev-evals";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Developer › Run Evals", () => {
  it("runs the repo's eval CLI with the app's server and model; the key goes only into the child's environment", () => {
    const l = evalLaunch("/repo", { modelBaseUrl: "http://127.0.0.1:8000/v1", model: "Qwen3.6-35B-A3B-4bit", apiKey: "k-123" }, { PATH: "/bin", KOVACH_API_KEY: "stale" });
    expect(l.command).toBe("/repo/packages/evals/node_modules/.bin/tsx");
    expect(l.args).toEqual([
      "--tsconfig",
      "/repo/packages/evals/tsconfig.json",
      "/repo/packages/evals/src/cli.ts",
      "--base-url",
      "http://127.0.0.1:8000/v1",
      "--model",
      "Qwen3.6-35B-A3B-4bit",
    ]);
    expect(l.args.join(" ")).not.toContain("k-123");
    expect(l.env).toEqual({ PATH: "/bin", KOVACH_API_KEY: "k-123" });
    expect(l.report).toBe("/repo/logs/evals/latest.md");
    // Without a key in Settings, none is passed on (not even one from the app's own environment).
    expect(evalLaunch("/repo", { modelBaseUrl: "u", model: "m" }, { KOVACH_API_KEY: "stale" }).env).toEqual({});
  });

  it("is offered only from a checkout that has the eval runner installed", () => {
    dir = mkdtempSync(join(tmpdir(), "kovach-dev-evals-"));
    const app = join(dir, "apps", "desktop");
    mkdirSync(app, { recursive: true });
    expect(evalsRoot(app)).toBeUndefined();
    mkdirSync(join(dir, "packages", "evals", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "evals", "src", "cli.ts"), "");
    expect(evalsRoot(app)).toBeUndefined(); // not installed yet
    mkdirSync(join(dir, "packages", "evals", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "packages", "evals", "node_modules", ".bin", "tsx"), "");
    expect(evalsRoot(app)).toBe(join(app, "..", ".."));
  });

  it("keeps only the result lines for the summary", () => {
    const out = "Loaded 2 suites: 48 questions, 16 sessions.\nServer x: 5 models.\nRetrieval with embeddinggemma…\n  recall@6 84%, MRR 0.70, leaks 0\nExtraction with Qwen…\n  rn-coupon-fix: 0 right, 0 wrong, 0 missed (9 s)\n  precision 88%, recall 73%\n\nReport: /r/latest.md\n";
    expect(evalSummary(out)).toEqual(["Retrieval with embeddinggemma…", "recall@6 84%, MRR 0.70, leaks 0", "Extraction with Qwen…", "precision 88%, recall 73%"]);
  });

  it("logs the run and reports the result once, with the failure line when it fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "kovach-dev-evals-"));
    const script = join(dir, "fake-cli.sh");
    writeFileSync(script, '#!/bin/sh\necho "Retrieval with m…"\necho "  recall@6 90%, MRR 0.80, leaks 0"\necho "key=$KOVACH_API_KEY" >&2\n[ "$1" = fail ] && { echo "Eval failed: server down"; exit 1; }\nexit 0\n');
    chmodSync(script, 0o755);
    const launch = (args: string[]) => ({ command: script, args, env: { PATH: process.env.PATH, KOVACH_API_KEY: "k" }, cwd: dir!, log: join(dir!, "logs", "evals.log"), report: "" });
    const ok = await new Promise<{ code: number; summary: string[]; error?: string }>((res) => runEvals(launch([]), res));
    expect(ok).toEqual({ code: 0, summary: ["Retrieval with m…", "recall@6 90%, MRR 0.80, leaks 0"] });
    expect(readFileSync(join(dir, "logs", "evals.log"), "utf8")).toContain("key=k");
    const bad = await new Promise<{ code: number; summary: string[]; error?: string }>((res) => runEvals(launch(["fail"]), res));
    expect(bad).toMatchObject({ code: 1, error: "Eval failed: server down" });
    let calls = 0;
    await new Promise<void>((res) =>
      runEvals({ ...launch([]), command: join(dir!, "missing") }, (r) => {
        calls++;
        expect(r.code).toBe(1);
        setTimeout(res, 100);
      }),
    );
    expect(calls).toBe(1);
  });
});
