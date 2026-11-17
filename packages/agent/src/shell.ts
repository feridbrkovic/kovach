import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  /** stdout and stderr interleaved, as a terminal would show them (head and tail kept when huge). */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_CAPTURE = 1_000_000;

/**
 * Run a shell command in `cwd`. Output over 1 MB keeps its first and last
 * half megabyte. A command over the timeout is stopped (TERM, then KILL).
 */
export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout stops the whole tree
    });
    let head = "";
    let tail = "";
    let dropped = 0;
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (head.length < MAX_CAPTURE / 2) {
        const room = MAX_CAPTURE / 2 - head.length;
        head += s.slice(0, room);
        tail += s.slice(room);
      } else tail += s;
      if (tail.length > MAX_CAPTURE / 2) {
        dropped += tail.length - MAX_CAPTURE / 2;
        tail = tail.slice(tail.length - MAX_CAPTURE / 2);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    const onAbort = () => kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      let output = dropped > 0 ? `${head}\n… [${dropped} characters omitted] …\n${tail}` : head + tail;
      if (timedOut) output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`;
      resolve({ exitCode: code, output, durationMs: Date.now() - started, timedOut });
    };
    child.on("error", () => finish(127));
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
  });
}

/** Keep the start and end of long text for the model (errors usually sit at either end). */
const FAILURE_LINE = /^\s*(not ok \d+|✕|×|●|✗|FAIL\b)|\b[A-Z][A-Za-z]*(Error|Exception)\b|\berror TS\d+|\berror:/;

/**
 * Like clip, but keeps what matters in long test output: the lines around the
 * first failures and the summary at the end, instead of an arbitrary middle cut.
 */
export function focusClip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) if (FAILURE_LINE.test(lines[i]!)) hits.push(i);
  if (hits.length === 0) return clip(text, max);
  const keep = new Set<number>();
  for (const h of hits) for (let i = Math.max(0, h - 3); i <= Math.min(lines.length - 1, h + 25); i++) keep.add(i);
  for (let i = Math.max(0, lines.length - 12); i < lines.length; i++) keep.add(i);
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out.push(`… [${i - last - 1} lines omitted] …`);
    out.push(lines[i]!);
    last = i;
  }
  if (last < lines.length - 1) out.push(`… [${lines.length - 1 - last} lines omitted] …`);
  return clip(out.join("\n"), max);
}

export function clip(text: string, max = 6000): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 40) / 2);
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters omitted] …\n${text.slice(-half)}`;
}
