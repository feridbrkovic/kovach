import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Sessions without a project folder work in a private scratch folder. A generated app brings
 * several hundred megabytes of installed packages with it, and a day of trying things out adds up.
 * What can be had back by installing or building again is safe to remove; the files are not.
 */
const REGROWABLE = ["node_modules", ".expo", "dist", "ios/Pods", "ios/build", "android/build", "android/.gradle", "android/app/build"];

export interface ScratchUsage {
  /** Scratch folders that exist. */
  sessions: number;
  bytes: number;
  /** Of those bytes, installed packages and build output. */
  regrowableBytes: number;
}

function sizeOf(path: string): number {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name));
  return total;
}

const sessionsIn = (root: string): string[] => (existsSync(root) ? readdirSync(root).filter((name) => /^[\w-]+$/.test(name) && lstatSync(join(root, name)).isDirectory()) : []);

export function scratchUsage(root: string): ScratchUsage {
  const sessions = sessionsIn(root);
  let bytes = 0;
  let regrowableBytes = 0;
  for (const id of sessions) {
    bytes += sizeOf(join(root, id));
    for (const rel of REGROWABLE) regrowableBytes += sizeOf(join(root, id, rel));
  }
  return { sessions: sessions.length, bytes, regrowableBytes };
}

/** Removes installed packages and build output from every scratch folder except the one in use. */
export function freeScratchSpace(root: string, keepSessionId?: string): { freedBytes: number; folders: number } {
  let freedBytes = 0;
  let folders = 0;
  for (const id of sessionsIn(root)) {
    if (id === keepSessionId) continue;
    for (const rel of REGROWABLE) {
      const path = join(root, id, rel);
      const size = sizeOf(path);
      if (size === 0 && !existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
      freedBytes += size;
      folders++;
    }
  }
  return { freedBytes, folders };
}

/** A deleted session takes its scratch folder with it. */
export function removeScratch(root: string, sessionId: string): void {
  if (!/^[\w-]+$/.test(sessionId)) return;
  rmSync(join(root, sessionId), { recursive: true, force: true });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
