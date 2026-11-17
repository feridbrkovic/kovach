import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE = fileURLToPath(new URL("./fixtures/typecheck-fix.jsonl", import.meta.url));

/**
 * Fake secrets, assembled at runtime so the repository's secret scanner does
 * not flag this file. None of them is a real credential.
 */
const j = (...parts: string[]) => parts.join("");
export const FAKE = {
  githubClassic: j("gh", "p_", "a".repeat(36)),
  githubOauth: j("gh", "o_", "b".repeat(36)),
  githubPat: j("github", "_pat_", "C".repeat(22), "_", "d".repeat(59)),
  aws: j("AK", "IA", "Z".repeat(16)),
  stripeLive: j("sk", "_live_", "e".repeat(24)),
  stripeTest: j("sk", "_test_", "f".repeat(24)),
  jwt: j("ey", "J", "h".repeat(20), ".", "ey", "J", "p".repeat(30), ".", "s".repeat(43)),
  privateKey: j("-----BEGIN ", "RSA PRIVATE", " KEY-----\n", "M".repeat(64), "\n", "N".repeat(64), "\n-----END ", "RSA PRIVATE", " KEY-----"),
  password: j("pass", "word", "1".repeat(4)),
};

export function tempDir(): { dir: string; file: (name: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agent-fixtures-"));
  return { dir, file: (name) => join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic clock: 1000, 2000, 3000, ... */
export function stepClock(start = 1000, step = 1000): () => number {
  let t = start - step;
  return () => (t += step);
}
