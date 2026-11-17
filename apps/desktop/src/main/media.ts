import { type ChildProcess, execFile as execFileCb, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as nodeExistsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GenerateImageRequest, MediaProvider } from "@kovach-dev/agent";

/**
 * Local image generation for the desktop app: FLUX.2 [klein] 4B (Apache-2.0) run
 * by mflux (MLX) in a Python environment the app owns under `<dataDir>/media/venv`.
 * The weights are a pre-quantized 4-bit copy (~4.3 GB) from Hugging Face; mflux
 * fetches them into the Hugging Face cache on the first generation.
 */

/** Pre-quantized 4-bit weights; mflux takes a Hugging Face repo as `--model`. */
export const MODEL_REPO = "Runpod/FLUX.2-klein-4B-mflux-4bit";
/** The built-in mflux model the repo is a quantized copy of (sets the geometry). */
export const BASE_MODEL = "flux2-klein-4b";
/** The first mflux release that runs that repo is 0.16.0. */
export const MFLUX_REQUIREMENT = "mflux>=0.16.0";
/** Current mflux releases need Python 3.11 or newer. */
export const MIN_PYTHON: readonly [number, number] = [3, 11];
/** The Python uv creates the environment with (it downloads one if needed). */
const UV_PYTHON = "3.12";
const STDERR_TAIL = 20;

const PYTHON_CANDIDATES = ["python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
/** An app started from the Finder has a short PATH, so look in the usual install places too. */
const uvCandidates = (home: string) => ["uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv", join(home, ".local/bin/uv"), join(home, ".cargo/bin/uv")];

export type ExecFileFn = (file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface MediaDeps {
  spawn?: SpawnFn;
  execFile?: ExecFileFn;
  existsSync?: (path: string) => boolean;
  homeDir?: string;
  /** Hugging Face hub cache root. Defaults to HF_HUB_CACHE, then HF_HOME/hub, then ~/.cache/huggingface/hub. */
  hfCache?: string;
}

interface ResolvedDeps {
  spawn: SpawnFn;
  execFile: ExecFileFn;
  existsSync: (path: string) => boolean;
  homeDir: string;
  hfCache: string;
}

const execFileAsync = promisify(execFileCb);

function resolveDeps(deps: MediaDeps = {}): ResolvedDeps {
  const homeDir = deps.homeDir ?? homedir();
  const env = process.env;
  return {
    spawn: deps.spawn ?? nodeSpawn,
    execFile: deps.execFile ?? ((file, args, options) => execFileAsync(file, [...args], { encoding: "utf8", ...options })),
    existsSync: deps.existsSync ?? nodeExistsSync,
    homeDir,
    hfCache: deps.hfCache ?? env.HF_HUB_CACHE ?? (env.HF_HOME ? join(env.HF_HOME, "hub") : join(homeDir, ".cache", "huggingface", "hub")),
  };
}

export interface MediaPaths {
  venv: string;
  python: string;
  mfluxBin: string;
  outDir: string;
}

export function mediaPaths(dataDir: string): MediaPaths {
  const venv = join(dataDir, "media", "venv");
  return {
    venv,
    python: join(venv, "bin", "python"),
    mfluxBin: join(venv, "bin", "mflux-generate-flux2"),
    outDir: join(dataDir, "media", "out"),
  };
}

export interface MediaStatus {
  state: "not_installed" | "installed";
  /** A Python the installer can use (or uv, which brings its own) is on this Mac. */
  pythonFound: boolean;
  mfluxVersion?: string;
  modelDownloaded?: boolean;
}

/** The Hugging Face cache folder for the model, e.g. `models--Runpod--FLUX.2-klein-4B-mflux-4bit`. */
export const modelCacheDir = (hfCache: string) => join(hfCache, `models--${MODEL_REPO.replace("/", "--")}`);

export async function mediaStatus(dataDir: string, deps?: MediaDeps): Promise<MediaStatus> {
  const d = resolveDeps(deps);
  const paths = mediaPaths(dataDir);
  const modelDownloaded = d.existsSync(modelCacheDir(d.hfCache));
  const installed = d.existsSync(paths.mfluxBin) && d.existsSync(paths.python);
  const pythonFound = installed || (await findPythonTool(deps)) !== undefined;
  if (!installed) return { state: "not_installed", pythonFound, modelDownloaded };
  const status: MediaStatus = { state: "installed", pythonFound, modelDownloaded };
  try {
    const { stdout } = await d.execFile(paths.python, ["-c", "import importlib.metadata as m; print(m.version('mflux'))"], { timeout: 15_000 });
    const version = stdout.trim();
    if (version) status.mfluxVersion = version;
  } catch {
    // An environment that can't report its mflux version still has the binary; leave the version out.
  }
  return status;
}

export type PythonTool = { kind: "uv"; uv: string } | { kind: "python"; python: string; version: string };

/** uv first (much faster, and it can fetch a Python itself), then a system Python ≥ 3.11 in a fixed order. */
export async function findPythonTool(deps?: MediaDeps): Promise<PythonTool | undefined> {
  const d = resolveDeps(deps);
  for (const uv of uvCandidates(d.homeDir)) {
    try {
      await d.execFile(uv, ["--version"], { timeout: 10_000 });
      return { kind: "uv", uv };
    } catch {
      // Not here; try the next place.
    }
  }
  for (const python of PYTHON_CANDIDATES) {
    let out: string;
    try {
      out = (await d.execFile(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { timeout: 10_000 })).stdout.trim();
    } catch {
      continue;
    }
    const [major, minor] = out.split(".").map(Number);
    if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) continue;
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return { kind: "python", python, version: out };
  }
  return undefined;
}

/** The commands that set up the environment, in order. */
export function installCommands(tool: PythonTool, paths: MediaPaths, venvExists: boolean): { command: string; args: string[] }[] {
  const steps: { command: string; args: string[] }[] = [];
  if (tool.kind === "uv") {
    if (!venvExists) steps.push({ command: tool.uv, args: ["venv", "--python", UV_PYTHON, paths.venv] });
    steps.push({ command: tool.uv, args: ["pip", "install", "--python", paths.python, "--upgrade", MFLUX_REQUIREMENT] });
  } else {
    if (!venvExists) steps.push({ command: tool.python, args: ["-m", "venv", paths.venv] });
    steps.push({ command: paths.python, args: ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", MFLUX_REQUIREMENT] });
  }
  return steps;
}

/** Create (or update) the media environment and install mflux, streaming the tools' output. */
export async function installMedia(dataDir: string, onProgress: (line: string) => void, signal?: AbortSignal, deps?: MediaDeps): Promise<void> {
  const d = resolveDeps(deps);
  const paths = mediaPaths(dataDir);
  const tool = await findPythonTool(deps);
  if (!tool) {
    throw new Error(
      `Image generation needs Python ${MIN_PYTHON.join(".")} or newer, and none was found. Install it (for example \`brew install python@3.12\`) or install uv, then try again.`,
    );
  }
  onProgress(tool.kind === "uv" ? `Using uv (${tool.uv})` : `Using Python ${tool.version} (${tool.python})`);
  mkdirSync(join(dataDir, "media"), { recursive: true });
  for (const step of installCommands(tool, paths, d.existsSync(paths.python))) {
    if (signal?.aborted) throw new Error("The install was stopped.");
    onProgress(`$ ${[step.command, ...step.args].join(" ")}`);
    const { code, stderrTail } = await run(d, paths, step.command, step.args, { onLine: onProgress, ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw new Error("The install was stopped.");
    if (code !== 0) throw new Error(`${step.command} ${step.args[0]} failed (exit ${code}).${tail(stderrTail)}`);
  }
  if (!d.existsSync(paths.mfluxBin)) throw new Error(`mflux installed, but ${paths.mfluxBin} is missing. Is the installed mflux older than 0.16?`);
  onProgress("Image generation is installed. The model (~4.3 GB) downloads on the first image.");
}

/**
 * A MediaProvider backed by `mflux-generate-flux2`. Generations run one at a time:
 * the image model shares the Mac's memory with the chat model.
 */
export function createMfluxProvider(dataDir: string, deps?: MediaDeps): MediaProvider {
  const d = resolveDeps(deps);
  const paths = mediaPaths(dataDir);
  let queue: Promise<unknown> = Promise.resolve();

  async function generateOnce(req: GenerateImageRequest, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw new Error("Image generation was stopped.");
    if (!d.existsSync(paths.mfluxBin)) throw new Error("Image generation isn't installed yet. Install it first, then try again.");
    mkdirSync(paths.outDir, { recursive: true });
    const out = join(paths.outDir, `${randomUUID()}.png`);
    // The first run also downloads the model into the Hugging Face cache; that can take a while.
    const { code, killedBy, stderrTail } = await run(d, paths, paths.mfluxBin, generateArgs(req, out), signal ? { signal } : {});
    try {
      if (signal?.aborted) throw new Error("Image generation was stopped.");
      if (code !== 0) {
        const why = killedBy ? `was killed (${killedBy}); the Mac may be out of memory` : `exited with code ${code}`;
        throw new Error(`mflux ${why}.${tail(stderrTail)}`);
      }
      if (!d.existsSync(out)) throw new Error(`mflux finished but wrote no image.${tail(stderrTail)}`);
      return readFileSync(out);
    } finally {
      rmSync(out, { force: true });
    }
  }

  return {
    generateImage(req, signal) {
      const job = queue.then(() => generateOnce(req, signal));
      queue = job.catch(() => undefined);
      return job;
    },
  };
}

/** Arguments for one `mflux-generate-flux2` run writing to `output`. */
export function generateArgs(req: GenerateImageRequest, output: string): string[] {
  return [
    "--model",
    MODEL_REPO,
    "--base-model",
    BASE_MODEL,
    // `=` keeps a prompt that starts with "-" from being read as a flag.
    `--prompt=${req.prompt}`,
    "--width",
    String(req.width),
    "--height",
    String(req.height),
    "--steps",
    String(req.steps),
    ...(req.seed !== undefined ? ["--seed", String(req.seed)] : []),
    "--output",
    output,
  ];
}

const tail = (lines: string[]) => (lines.length ? `\n${lines.join("\n")}` : "");

interface RunResult {
  code: number | null;
  killedBy?: string;
  stderrTail: string[];
}

/** Run a process, report its output line by line, keep the last lines of stderr, and kill it on abort. */
function run(
  d: ResolvedDeps,
  paths: MediaPaths,
  command: string,
  args: string[],
  opts: { onLine?: (line: string) => void; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${join(paths.venv, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HF_HUB_CACHE: d.hfCache,
      HF_HUB_DISABLE_TELEMETRY: "1",
      PYTHONUNBUFFERED: "1",
    };
    let child: ChildProcess;
    try {
      child = d.spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const stderrTail: string[] = [];
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    lines(child.stdout, (l) => opts.onLine?.(l));
    lines(child.stderr, (l) => {
      stderrTail.push(l);
      if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
      opts.onLine?.(l);
    });
    child.once("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Couldn't start ${command}: ${err.message}`));
    });
    child.once("close", (code: number | null, sig: NodeJS.Signals | null) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, ...(sig ? { killedBy: sig } : {}), stderrTail });
    });
  });
}

/** Split a stream into lines; progress bars redraw with \r, so that ends a line too. */
function lines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split(/\r\n|\r|\n/);
    buf = parts.pop() ?? "";
    for (const p of parts) if (p.trim()) onLine(p.trimEnd());
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf.trimEnd());
    buf = "";
  });
}
