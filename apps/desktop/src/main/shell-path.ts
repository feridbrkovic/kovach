import { spawn } from "node:child_process";

/**
 * Apps started from Finder or the Dock inherit launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so tools installed with Homebrew, nvm,
 * pnpm and friends are missing. This reads the PATH the user's login shell
 * would set up and merges it with the current one.
 */

/** Runs `file` with `args` and resolves with its stdout. Rejects on failure or timeout. */
export type ExecFn = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<string>;

export interface ShellPathDeps {
  exec?: ExecFn;
  /** Login shell to ask. Defaults to $SHELL, then /bin/zsh. */
  shell?: string;
  /** Environment the shell runs with and whose PATH is merged. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to 5000 ms. */
  timeoutMs?: number;
}

export const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

const START = "__KOVACH_PATH_START__";
const END = "__KOVACH_PATH_END__";
const DEFAULT_TIMEOUT_MS = 5000;

const MAX_OUTPUT = 1024 * 1024;

/**
 * Spawns the shell in its own process group so a timeout can stop anything its
 * startup files started too; otherwise a lingering child keeps stdout open.
 */
const defaultExec: ExecFn = (file, args, { timeout, env }) =>
  new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const finish = (err: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(Object.assign(err, { stdout }));
      else resolve(stdout);
    };
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(new Error(`${file} did not finish within ${timeout} ms`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code, signal) => finish(code === 0 ? undefined : new Error(`${file} exited with ${signal ?? code}`)));
  });

/** Resolves with `undefined` instead of waiting past `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The PATH printed between the markers, ignoring anything the shell's startup files print around it. */
export function parseMarkedPath(output: string): string | undefined {
  const start = output.indexOf(START);
  if (start === -1) return undefined;
  const from = start + START.length;
  const end = output.indexOf(END, from);
  if (end === -1) return undefined;
  const value = output.slice(from, end).trim();
  return value === "" ? undefined : value;
}

/** Join PATH strings in order, dropping empty and repeated entries. */
export function mergePaths(...paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  for (const path of paths) {
    for (const entry of (path ?? "").split(":")) {
      const dir = entry.trim();
      if (dir !== "") seen.add(dir);
    }
  }
  return [...seen].join(":");
}

/**
 * The login shell's PATH first, then the current PATH, then the Homebrew
 * directories if they are still missing. Never throws: when the shell fails or
 * takes longer than the timeout, the current PATH plus the Homebrew
 * directories is returned.
 */
export async function loadLoginShellPath(deps: ShellPathDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const shell = deps.shell ?? (env.SHELL || "/bin/zsh");
  const current = env.PATH;
  const fallback = mergePaths(current, HOMEBREW_DIRS.join(":"));

  const command = `printf '%s%s%s' '${START}' "$PATH" '${END}'`;
  // Keep oh-my-zsh and similar frameworks from stopping to ask about updates.
  const shellEnv = { ...env, DISABLE_AUTO_UPDATE: "true", ZSH_DISABLE_COMPFIX: "true" };

  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let output: string | undefined;
  try {
    // The exec gets the timeout too; the race is a backstop if it ignores it.
    output = await withTimeout(exec(shell, ["-ilc", command], { timeout, env: shellEnv }), timeout + 500);
  } catch (err) {
    // A startup file that exits non-zero can still have printed the PATH.
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    if (typeof stdout !== "string") return fallback;
    output = stdout;
  }

  const shellPath = output === undefined ? undefined : parseMarkedPath(output);
  if (!shellPath) return fallback;
  return mergePaths(shellPath, current, HOMEBREW_DIRS.join(":"));
}
