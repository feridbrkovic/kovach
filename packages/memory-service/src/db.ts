import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type Db = Database.Database;

const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface OpenOptions {
  /**
   * Path to a better-sqlite3 binary built for the current runtime. The desktop
   * app passes an Electron build here, so the Node build stays usable for tests.
   */
  nativeBinding?: string;
  /** Path to the sqlite-vec extension, when it can't be found next to the package (e.g. a packaged app). */
  vecExtension?: string;
}

/**
 * Open (or create) the Local Kovach database with the settings the plan assumes:
 * WAL journal, foreign keys on, sqlite-vec loaded.
 * Use ":memory:" in tests.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const db = new Database(path, options.nativeBinding ? { nativeBinding: options.nativeBinding } : {});
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (options.vecExtension) db.loadExtension(options.vecExtension);
  else sqliteVec.load(db);
  return db;
}

export interface Migration {
  /** File name, NNNN_description.sql. */
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  current: string | undefined;
}

/** Read the migration files from a folder (the package's own `migrations/` by default). */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => MIGRATION_NAME.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Apply pending migrations in name order, each in its own transaction.
 * Files are named NNNN_description.sql and are never edited once committed.
 *
 * Pass a folder, or the migrations themselves (a bundled app embeds the SQL).
 */
export function migrate(db: Db, source: string | Migration[] = DEFAULT_MIGRATIONS_DIR): MigrationResult {
  const migrations = (typeof source === "string" ? loadMigrations(source) : [...source])
    .filter((m) => MIGRATION_NAME.test(m.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const done = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );

  const applied: string[] = [];
  for (const { name, sql } of migrations) {
    if (done.has(name)) continue;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
    applied.push(name);
  }
  return { applied, current: migrations.at(-1)?.name };
}
