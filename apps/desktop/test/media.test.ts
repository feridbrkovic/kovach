import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMfluxProvider,
  type ExecFileFn,
  findPythonTool,
  installMedia,
  type MediaDeps,
  mediaPaths,
  mediaStatus,
  MFLUX_REQUIREMENT,
  MODEL_REPO,
} from "../src/main/media";

const HOME = "/Users/test";
const HF = "/hf-cache";

/** A child process the test drives: write to its streams, then `exit(code)`. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
  ) {
    super();
  }
  kill(signal: string = "SIGTERM") {
    this.killed.push(signal);
    this.finish(null, signal);
    return true;
  }
  exit(code: number) {
    this.finish(code, null);
  }
  private finish(code: number | null, signal: string | null) {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

function fakeSpawn(onSpawn: (child: FakeChild) => void = (c) => c.exit(0)) {
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild(command, args, options);
    children.push(child);
    queueMicrotask(() => onSpawn(child));
    return child as unknown as ChildProcess;
  };
  return { spawn, children };
}

/** execFile that answers per command; anything not listed fails like a missing binary. */
function fakeExecFile(answers: Record<string, string>) {
  const calls: string[] = [];
  const execFile: ExecFileFn = async (file, args) => {
    calls.push(file);
    const key = Object.keys(answers).find((k) => k === file || k === `${file} ${args[0]}`);
    if (key === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
    return { stdout: `${answers[key]}\n`, stderr: "" };
  };
  return { execFile, calls };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kovach-media-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mediaPaths", () => {
  it("keeps the environment and output under the app's data dir", () => {
    expect(mediaPaths("/data")).toEqual({
      venv: "/data/media/venv",
      python: "/data/media/venv/bin/python",
      mfluxBin: "/data/media/venv/bin/mflux-generate-flux2",
      outDir: "/data/media/out",
    });
  });
});

describe("mediaStatus", () => {
  it("reports not installed and no Python on a bare Mac", async () => {
    const { execFile } = fakeExecFile({});
    const status = await mediaStatus("/data", { execFile, existsSync: () => false, homeDir: HOME, hfCache: HF });
    expect(status).toEqual({ state: "not_installed", pythonFound: false, modelDownloaded: false });
  });

  it("finds a usable Python before anything is installed", async () => {
    const { execFile } = fakeExecFile({ python3: "3.12" });
    const status = await mediaStatus("/data", { execFile, existsSync: () => false, homeDir: HOME, hfCache: HF });
    expect(status).toMatchObject({ state: "not_installed", pythonFound: true });
  });

  it("reports the mflux version and whether the model is in the Hugging Face cache", async () => {
    const p = mediaPaths("/data");
    const present = new Set([p.python, p.mfluxBin, `${HF}/models--Runpod--FLUX.2-klein-4B-mflux-4bit`]);
    const { execFile } = fakeExecFile({ [p.python]: "0.24.0" });
    const deps: MediaDeps = { execFile, existsSync: (x) => present.has(x), homeDir: HOME, hfCache: HF };
    expect(await mediaStatus("/data", deps)).toEqual({ state: "installed", pythonFound: true, mfluxVersion: "0.24.0", modelDownloaded: true });

    present.delete(`${HF}/models--Runpod--FLUX.2-klein-4B-mflux-4bit`);
    expect(await mediaStatus("/data", deps)).toMatchObject({ state: "installed", modelDownloaded: false });
  });

  it("defaults the Hugging Face cache to ~/.cache/huggingface/hub", async () => {
    const seen: string[] = [];
    const saved = { cache: process.env.HF_HUB_CACHE, home: process.env.HF_HOME };
    delete process.env.HF_HUB_CACHE;
    delete process.env.HF_HOME;
    try {
      const { execFile } = fakeExecFile({});
      await mediaStatus("/data", { execFile, existsSync: (x) => (seen.push(x), false), homeDir: HOME });
    } finally {
      if (saved.cache !== undefined) process.env.HF_HUB_CACHE = saved.cache;
      if (saved.home !== undefined) process.env.HF_HOME = saved.home;
    }
    expect(seen).toContain(`${HOME}/.cache/huggingface/hub/models--Runpod--FLUX.2-klein-4B-mflux-4bit`);
  });
});

describe("findPythonTool", () => {
  const UVS = ["uv", "/opt/homebrew/bin/uv", "/usr/local/bin/uv", `${HOME}/.local/bin/uv`, `${HOME}/.cargo/bin/uv`];

  it("prefers uv when it is installed", async () => {
    const { execFile, calls } = fakeExecFile({ "/opt/homebrew/bin/uv": "uv 0.9.0" });
    expect(await findPythonTool({ execFile, homeDir: HOME })).toEqual({ kind: "uv", uv: "/opt/homebrew/bin/uv" });
    expect(calls).toEqual(["uv", "/opt/homebrew/bin/uv"]);
  });

  it("tries python3, Homebrew, then /usr/local, skipping a Python that is too old", async () => {
    const { execFile, calls } = fakeExecFile({ python3: "3.9", "/opt/homebrew/bin/python3": "3.12", "/usr/local/bin/python3": "3.13" });
    expect(await findPythonTool({ execFile, homeDir: HOME })).toEqual({ kind: "python", python: "/opt/homebrew/bin/python3", version: "3.12" });
    expect(calls).toEqual([...UVS, "python3", "/opt/homebrew/bin/python3"]);
  });

  it("accepts Python 3.11 and rejects 3.10", async () => {
    expect(await findPythonTool({ execFile: fakeExecFile({ python3: "3.11" }).execFile, homeDir: HOME })).toMatchObject({ python: "python3" });
    expect(await findPythonTool({ execFile: fakeExecFile({ python3: "3.10" }).execFile, homeDir: HOME })).toBeUndefined();
  });

  it("finds nothing when neither uv nor a Python is around", async () => {
    const { execFile, calls } = fakeExecFile({});
    expect(await findPythonTool({ execFile, homeDir: HOME })).toBeUndefined();
    expect(calls).toEqual([...UVS, "python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]);
  });
});

describe("installMedia", () => {
  /** Deps where the install "creates" files the way the real tools would. */
  function installDeps(answers: Record<string, string>, onSpawn?: (c: FakeChild) => void) {
    const p = mediaPaths(dataDir);
    const present = new Set<string>();
    const { spawn, children } = fakeSpawn(
      onSpawn ??
        ((c) => {
          if (c.args.includes("venv")) present.add(p.python);
          if (c.args.includes("install")) present.add(p.mfluxBin);
          c.stdout.write(`ran ${c.args[0]}\r\n`);
          c.exit(0);
        }),
    );
    const { execFile } = fakeExecFile(answers);
    const deps: MediaDeps = { spawn, execFile, existsSync: (x) => present.has(x), homeDir: HOME, hfCache: HF };
    return { p, present, children, deps };
  }

  it("tells the user to install Python when none is found", async () => {
    const { deps, children } = installDeps({});
    await expect(installMedia(dataDir, () => {}, undefined, deps)).rejects.toThrow(/Python 3\.11 or newer.*brew install python@3\.12/);
    expect(children).toHaveLength(0);
  });

  it("uses uv venv and uv pip install when uv is available", async () => {
    const { p, deps, children } = installDeps({ uv: "uv 0.9.0", python3: "3.12" });
    const progress: string[] = [];
    await installMedia(dataDir, (l) => progress.push(l), undefined, deps);
    expect(children.map((c) => [c.command, ...c.args])).toEqual([
      ["uv", "venv", "--python", "3.12", p.venv],
      ["uv", "pip", "install", "--python", p.python, "--upgrade", MFLUX_REQUIREMENT],
    ]);
    expect(MFLUX_REQUIREMENT).toBe("mflux>=0.16.0");
    expect(progress).toContain("ran venv");
    expect(progress).toContain("ran pip");
    expect(progress.at(-1)).toMatch(/installed/);
  });

  it("uses python -m venv and pip without uv", async () => {
    const { p, deps, children } = installDeps({ "/usr/local/bin/python3": "3.11" });
    await installMedia(dataDir, () => {}, undefined, deps);
    expect(children.map((c) => [c.command, ...c.args])).toEqual([
      ["/usr/local/bin/python3", "-m", "venv", p.venv],
      [p.python, "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", MFLUX_REQUIREMENT],
    ]);
    expect(children[1]!.options.env?.PATH?.startsWith(`${p.venv}/bin:`)).toBe(true);
  });

  it("reuses an existing environment and only upgrades mflux", async () => {
    const { p, present, deps, children } = installDeps({ python3: "3.12" });
    present.add(p.python);
    await installMedia(dataDir, () => {}, undefined, deps);
    expect(children.map((c) => c.args.slice(0, 2))).toEqual([["-m", "pip"]]);
  });

  it("fails with the tool's error output", async () => {
    const { deps } = installDeps({ python3: "3.12" }, (c) => {
      c.stderr.write("ERROR: No matching distribution found for mflux>=0.16.0\n");
      c.exit(1);
    });
    await expect(installMedia(dataDir, () => {}, undefined, deps)).rejects.toThrow(/exit 1[\s\S]*No matching distribution/);
  });

  it("stops the running step on abort", async () => {
    const ac = new AbortController();
    const { deps, children } = installDeps({ python3: "3.12" }, () => {});
    const done = installMedia(dataDir, () => {}, ac.signal, deps);
    await until(() => children.length === 1);
    ac.abort();
    await expect(done).rejects.toThrow(/stopped/);
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
  });
});

describe("createMfluxProvider", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  function providerDeps(onSpawn: (c: FakeChild) => void) {
    const p = mediaPaths(dataDir);
    const { spawn, children } = fakeSpawn(onSpawn);
    const deps: MediaDeps = { spawn, existsSync: (x) => x === p.mfluxBin || existsSync(x), homeDir: HOME, hfCache: HF };
    return { p, children, provider: createMfluxProvider(dataDir, deps) };
  }

  /** Behaves like mflux: writes the PNG to --output and exits 0. */
  const writesPng = (c: FakeChild) => {
    const out = c.args[c.args.indexOf("--output") + 1]!;
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, PNG);
    c.exit(0);
  };

  it("runs mflux with the model, size, steps, seed and a temp output, and returns the PNG", async () => {
    const { p, children, provider } = providerDeps(writesPng);
    const png = await provider.generateImage({ prompt: "a red fox", width: 1024, height: 768, steps: 4, seed: 7 });
    expect(png.equals(PNG)).toBe(true);
    const c = children[0]!;
    expect(c.command).toBe(p.mfluxBin);
    const out = c.args.at(-1)!;
    expect(out.startsWith(`${p.outDir}/`) && out.endsWith(".png")).toBe(true);
    expect(c.args).toEqual([
      "--model",
      MODEL_REPO,
      "--base-model",
      "flux2-klein-4b",
      "--prompt=a red fox",
      "--width",
      "1024",
      "--height",
      "768",
      "--steps",
      "4",
      "--seed",
      "7",
      "--output",
      out,
    ]);
    expect(c.options.env?.HF_HUB_CACHE).toBe(HF);
    expect(existsSync(out)).toBe(false); // the temp file is gone
  });

  it("leaves the seed to mflux when none is given", async () => {
    const { children, provider } = providerDeps(writesPng);
    await provider.generateImage({ prompt: "-dash first", width: 512, height: 512, steps: 2 });
    expect(children[0]!.args).not.toContain("--seed");
    expect(children[0]!.args).toContain("--prompt=-dash first");
  });

  it("kills mflux when the signal aborts", async () => {
    const ac = new AbortController();
    const { children, provider } = providerDeps(() => {});
    const job = provider.generateImage({ prompt: "x", width: 512, height: 512, steps: 4 }, ac.signal);
    await until(() => children.length === 1);
    ac.abort();
    await expect(job).rejects.toThrow(/stopped/);
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
  });

  it("does not start when already aborted", async () => {
    const { children, provider } = providerDeps(writesPng);
    await expect(provider.generateImage({ prompt: "x", width: 512, height: 512, steps: 4 }, AbortSignal.abort())).rejects.toThrow(/stopped/);
    expect(children).toHaveLength(0);
  });

  it("puts the last 20 lines of stderr in the error", async () => {
    const { provider } = providerDeps((c) => {
      for (let i = 1; i <= 30; i++) c.stderr.write(`line ${i}\n`);
      c.exit(1);
    });
    const err = (await provider.generateImage({ prompt: "x", width: 512, height: 512, steps: 4 }).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/exited with code 1/);
    expect(err.message).toContain("line 11");
    expect(err.message).toContain("line 30");
    expect(err.message).not.toMatch(/line 10\b/);
  });

  it("says so when mflux isn't installed", async () => {
    const { spawn } = fakeSpawn();
    const provider = createMfluxProvider(dataDir, { spawn, existsSync: () => false, homeDir: HOME, hfCache: HF });
    await expect(provider.generateImage({ prompt: "x", width: 512, height: 512, steps: 4 })).rejects.toThrow(/isn't installed/);
  });

  it("runs one generation at a time, even after a failure", async () => {
    const { children, provider } = providerDeps(() => {});
    const req = { prompt: "x", width: 512, height: 512, steps: 4 };
    const first = provider.generateImage(req);
    const second = provider.generateImage(req);
    const third = provider.generateImage(req);
    await until(() => children.length === 1);
    await tick();
    expect(children).toHaveLength(1);

    children[0]!.exit(1); // the first fails
    await expect(first).rejects.toThrow(/code 1/);
    await until(() => children.length === 2);
    await tick();
    expect(children).toHaveLength(2);

    writesPng(children[1]!);
    expect((await second).equals(PNG)).toBe(true);
    await until(() => children.length === 3);
    writesPng(children[2]!);
    expect((await third).equals(PNG)).toBe(true);
  });
});
