import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** Largest tool-output excerpt kept in the database, in UTF-8 bytes (matches the schema CHECK). */
export const EXCERPT_MAX_BYTES = 8192;

/**
 * Cut `text` to at most `maxBytes` of UTF-8 without splitting a character.
 * Returns the text unchanged when it already fits.
 */
export function utf8Prefix(text: string, maxBytes: number = EXCERPT_MAX_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so we stop on a character boundary.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Full tool output that is too long for the database lives in files:
 * `<root>/<aa>/<sha256>`. Paths stored in the database are relative to the
 * data directory (`blobs/aa/<sha256>`), so the folder can move.
 * Identical output is stored once.
 */
export class BlobStore {
  /** Absolute folder that holds the blobs. */
  readonly root: string;

  constructor(
    /** Data directory; blobs go in `<dataDir>/blobs`. */
    readonly dataDir: string,
  ) {
    this.root = join(dataDir, "blobs");
  }

  /** Store text and return its path relative to the data directory. */
  put(text: string): string {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const rel = join("blobs", hash.slice(0, 2), hash);
    const abs = join(this.dataDir, rel);
    if (!existsSync(abs)) {
      mkdirSync(dirname(abs), { recursive: true });
      // Write to a temp file and rename, so a crash never leaves a half-written blob.
      const tmp = `${abs}.${process.pid}.tmp`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, abs);
    }
    return rel.split(sep).join("/");
  }

  read(relPath: string): string {
    return readFileSync(this.resolve(relPath), "utf8");
  }

  exists(relPath: string): boolean {
    return existsSync(this.resolve(relPath));
  }

  /** Remove a blob. Missing files are ignored. */
  delete(relPath: string): void {
    rmSync(this.resolve(relPath), { force: true });
  }

  /** Map a stored relative path to a file inside the blob folder, refusing anything outside it. */
  private resolve(relPath: string): string {
    const clean = normalize(relPath);
    const abs = join(this.dataDir, clean);
    if (isAbsolute(relPath) || !abs.startsWith(this.root + sep)) {
      throw new Error(`blob path outside the blob store: ${relPath}`);
    }
    return abs;
  }
}
