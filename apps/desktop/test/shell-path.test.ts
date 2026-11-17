import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type ExecFn, loadLoginShellPath, mergePaths, parseMarkedPath } from "../src/main/shell-path";

const START = "__KOVACH_PATH_START__";
const END = "__KOVACH_PATH_END__";
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const marked = (path: string) => `${START}${path}${END}`;

describe("parseMarkedPath", () => {
  it("ignores startup noise around the markers", () => {
    const output = [
      "Last login: Mon Nov 16 09:12:01 on ttys003",
      "zsh: no job control in this shell",
      "Welcome back! PATH=/not/this:/either",
      `${marked("/Users/me/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/bin")}`,
      "nvm: using node v22",
    ].join("\n");
    expect(parseMarkedPath(output)).toBe("/Users/me/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/bin");
  });

  it("finds markers with no newline between noise and value", () => {
    expect(parseMarkedPath(`banner${marked("/a:/b")}trailer`)).toBe("/a:/b");
  });

  it("returns undefined when a marker is missing or the value is empty", () => {
    expect(parseMarkedPath("just noise")).toBeUndefined();
    expect(parseMarkedPath(`${START}/a:/b`)).toBeUndefined();
    expect(parseMarkedPath(`/a:/b${END}`)).toBeUndefined();
    expect(parseMarkedPath(marked("  "))).toBeUndefined();
  });
});

describe("mergePaths", () => {
  it("keeps first occurrences in order and drops empty entries", () => {
    expect(mergePaths("/a:/b::/c", "/b:/d", undefined, "/a:/e:")).toBe("/a:/b:/c:/d:/e");
  });
});

describe("loadLoginShellPath", () => {
  it("runs the login shell with -ilc and a 5 s timeout", async () => {
    const exec = vi.fn<ExecFn>(async () => marked("/x"));
    await loadLoginShellPath({ exec, env: { SHELL: "/bin/bash", PATH: FINDER_PATH } });
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0]!;
    expect(file).toBe("/bin/bash");
    expect(args[0]).toBe("-ilc");
    expect(args[1]).toContain('"$PATH"');
    expect(options.timeout).toBe(5000);
    expect(options.env.SHELL).toBe("/bin/bash");
  });

  it("defaults to /bin/zsh when SHELL is not set", async () => {
    const exec = vi.fn<ExecFn>(async () => marked("/x"));
    await loadLoginShellPath({ exec, env: { PATH: FINDER_PATH } });
    expect(exec.mock.calls[0]![0]).toBe("/bin/zsh");
  });

  it("puts the shell PATH first, then the current PATH, without duplicates", async () => {
    const exec: ExecFn = async () => `noise\n${marked("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin")}\nmore noise`;
    const path = await loadLoginShellPath({ exec, env: { PATH: `${FINDER_PATH}:/Applications/Tool.app/bin` } });
    expect(path).toBe("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Tool.app/bin:/usr/local/bin");
  });

  it("appends the Homebrew directories when the shell PATH lacks them", async () => {
    const exec: ExecFn = async () => marked("/Users/me/bin:/usr/bin:/bin");
    const path = await loadLoginShellPath({ exec, env: { PATH: FINDER_PATH } });
    const entries = path.split(":");
    expect(entries.slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
    expect(entries[0]).toBe("/Users/me/bin");
  });

  it("falls back to the current PATH plus Homebrew when the shell times out", async () => {
    const exec: ExecFn = () => Promise.reject(Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL", stdout: "" }));
    await expect(loadLoginShellPath({ exec, env: { PATH: FINDER_PATH } })).resolves.toBe(`${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`);
  });

  it("falls back when an exec ignores the timeout and never settles", async () => {
    const exec: ExecFn = () => new Promise(() => {});
    const started = Date.now();
    await expect(loadLoginShellPath({ exec, timeoutMs: 50, env: { PATH: FINDER_PATH } })).resolves.toBe(
      `${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("falls back when the shell cannot be started or prints no markers", async () => {
    const missing: ExecFn = () => Promise.reject(Object.assign(new Error("spawn /bin/nope ENOENT"), { code: "ENOENT" }));
    const silent: ExecFn = async () => "no markers here";
    const weird: ExecFn = () => Promise.reject("not an error");
    for (const exec of [missing, silent, weird]) {
      await expect(loadLoginShellPath({ exec, env: { PATH: FINDER_PATH } })).resolves.toBe(`${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`);
    }
  });

  it("falls back to just the Homebrew directories when there is no PATH at all", async () => {
    const exec: ExecFn = async () => "";
    await expect(loadLoginShellPath({ exec, env: {} })).resolves.toBe("/opt/homebrew/bin:/usr/local/bin");
  });

  it("uses the PATH from a shell that printed it and then exited non-zero", async () => {
    const exec: ExecFn = () => Promise.reject(Object.assign(new Error("exit 1"), { code: 1, stdout: `oops\n${marked("/from/shell")}` }));
    await expect(loadLoginShellPath({ exec, env: { PATH: FINDER_PATH } })).resolves.toBe(
      `/from/shell:${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`,
    );
  });

  const sh = (() => {
    try {
      execFileSync("/bin/sh", ["-c", "true"]);
      return "/bin/sh";
    } catch {
      return undefined;
    }
  })();

  it.runIf(sh)("reads the PATH from a real shell with the default exec", async () => {
    const path = await loadLoginShellPath({ shell: sh, env: { HOME: "/nonexistent", PATH: "/kovach/test/bin:/usr/bin:/bin" } });
    expect(path.split(":")).toContain("/kovach/test/bin");
    expect(path.split(":").slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("falls back with the default exec when the shell does not exist", async () => {
    await expect(loadLoginShellPath({ shell: "/nonexistent/shell", env: { PATH: FINDER_PATH } })).resolves.toBe(
      `${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`,
    );
  });

  it.runIf(sh)("falls back with the default exec when the shell outlives the timeout", async () => {
    // `sh -ilc` reads ENV as its startup file; make it hang.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "kovach-shell-"));
    const rc = join(dir, "rc");
    writeFileSync(rc, "sleep 5\nexport PATH=/from/rc:$PATH\n");
    try {
      const started = Date.now();
      const path = await loadLoginShellPath({ shell: sh, timeoutMs: 200, env: { HOME: dir, ENV: rc, PATH: FINDER_PATH } });
      expect(path).toBe(`${FINDER_PATH}:/opt/homebrew/bin:/usr/local/bin`);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
