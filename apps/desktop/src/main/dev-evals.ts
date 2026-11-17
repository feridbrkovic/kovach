/**
 * Developer › Run Evals (development builds only): runs the eval CLI from the
 * repo against the model server in the app's settings. The API key, which the
 * app keeps encrypted, goes to the child process in its environment only.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EvalLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Everything the run prints, for a look afterwards. */
  log: string;
  /** The Markdown report the CLI writes. */
  report: string;
}

/** The repo checkout this development build runs from, when it has the eval runner. */
export function evalsRoot(appPath: string): string | undefined {
  const root = join(appPath, "..", "..");
  return existsSync(join(root, "packages", "evals", "src", "cli.ts")) && existsSync(join(root, "packages", "evals", "node_modules", ".bin", "tsx"))
    ? root
    : undefined;
}

export function evalLaunch(
  root: string,
  settings: { modelBaseUrl: string; model: string; apiKey?: string },
  env: NodeJS.ProcessEnv = process.env,
): EvalLaunch {
  const pkg = join(root, "packages", "evals");
  const { KOVACH_API_KEY: _ignored, ...rest } = env;
  return {
    command: join(pkg, "node_modules", ".bin", "tsx"),
    args: ["--tsconfig", join(pkg, "tsconfig.json"), join(pkg, "src", "cli.ts"), "--base-url", settings.modelBaseUrl, "--model", settings.model],
    env: { ...rest, ...(settings.apiKey ? { KOVACH_API_KEY: settings.apiKey } : {}) },
    cwd: pkg,
    log: join(root, "logs", "evals.log"),
    report: join(root, "logs", "evals", "latest.md"),
  };
}

/** The result lines the CLI prints ("  recall@6 84%, …", "  precision 88%, …"). */
export function evalSummary(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((l) => /^(Retrieval with|Extraction with|\s+(recall@6|precision) )/.test(l))
    .map((l) => l.trim());
}

/** Start a run; `done` gets the exit code, the summary lines and the last error line. */
export function runEvals(launch: EvalLaunch, done: (r: { code: number; summary: string[]; error?: string }) => void): ChildProcess {
  mkdirSync(dirname(launch.log), { recursive: true });
  const log = createWriteStream(launch.log);
  let output = "";
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["ignore", "pipe", "pipe"] });
  const take = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    log.write(text);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  let finished = false;
  const finish = (code: number, spawnError?: string) => {
    // A spawn failure fires "error" and then "close": report once.
    if (finished) return;
    finished = true;
    const error = spawnError ?? output.split(/\r?\n/).reverse().find((l) => l.startsWith("Eval failed:"));
    // Report once the log is on disk, so it can be opened right away.
    log.end(() => done({ code, summary: evalSummary(output), ...(error ? { error } : {}) }));
  };
  child.on("error", (err) => finish(1, err.message));
  child.on("close", (code) => finish(code ?? 1));
  return child;
}
