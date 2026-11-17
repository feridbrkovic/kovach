/**
 * A throwaway world for one suite: an in-memory database, a temp folder with a
 * manifest per project (so the scanner sees the right stack), and the stores.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BlobStore,
  createHistoryStore,
  createMemoryStore,
  type Db,
  type Embedder,
  type Extractor,
  type HistoryStore,
  type MemoryStore,
  migrate,
  openDatabase,
  redactSecrets,
} from "@kovach-dev/memory-service";
import type { ProjectFixture } from "./format.js";

export interface World {
  db: Db;
  history: HistoryStore;
  memory: MemoryStore;
  /** Fixture project id → real project id. */
  projects: Map<string, string>;
  close(): void;
}

export function createWorld(projects: ProjectFixture[], opts: { embedder?: Embedder; extractor?: Extractor } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "kovach-eval-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const history = createHistoryStore(db, { blobs: new BlobStore(join(dir, "blobs")), redactOutput: redactSecrets });
  const memory = createMemoryStore(db, {
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.extractor ? { extractor: () => opts.extractor } : {}),
  });
  memory.jobs.start();
  const ids = new Map<string, string>();
  for (const p of projects) {
    const root = join(dir, "projects", p.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: p.id, dependencies: p.npm ?? {} }));
    if (p.composer) writeFileSync(join(root, "composer.json"), JSON.stringify({ name: `eval/${p.id}`, require: p.composer }));
    ids.set(p.id, history.ensureProject({ path: root, name: p.name }));
  }
  return {
    db,
    history,
    memory,
    projects: ids,
    close() {
      memory.jobs.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
