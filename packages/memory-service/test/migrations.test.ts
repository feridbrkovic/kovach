import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, loadMigrations, migrate, openDatabase } from "../src/index.js";

let db: Db;
const now = 1_700_000_000_000;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const vector = (seed: number) => new Float32Array(Array.from({ length: 768 }, (_, i) => Math.sin(seed + i)));

function insertMemory(id: string, key: string, body: string, status = "active") {
  db.prepare(
    `INSERT INTO memories (id, kind, scope, key, body, trust, status, created_at, updated_at)
     VALUES (?, 'preference', 'global', ?, ?, 'user', ?, ?, ?)`,
  ).run(id, key, body, status, now, now);
}

const ftsHits = (q: string) =>
  db.prepare("SELECT ref_id FROM memory_fts WHERE memory_fts MATCH ?").all(q) as { ref_id: string }[];

describe("migrations", () => {
  it("applies once and is idempotent", () => {
    expect(migrate(db).applied).toEqual([]);
    const names = db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(["0001_init.sql", "0002_vectors.sql", "0003_memory_uses.sql", "0004_docs_packs.sql", "0005_extraction.sql", "0006_review_decisions.sql"]);
  });

  it("applies embedded migrations the same way as a folder", () => {
    const fresh = openDatabase(":memory:");
    const result = migrate(fresh, loadMigrations());
    expect(result.applied).toEqual(["0001_init.sql", "0002_vectors.sql", "0003_memory_uses.sql", "0004_docs_packs.sql", "0005_extraction.sql", "0006_review_decisions.sql"]);
    expect(migrate(fresh, loadMigrations()).applied).toEqual([]);
    fresh.close();
  });

  it("indexes memories for keyword search", () => {
    insertMemory("m1", "style.semicolons", "Prefer no semicolons in TypeScript");
    expect(ftsHits("semicolons").map((h) => h.ref_id)).toEqual(["m1"]);
  });

  it("re-indexes a memory when its body changes", () => {
    insertMemory("m1", "state.library", "Use Redux Toolkit");
    db.prepare("UPDATE memories SET body = 'Use Zustand' WHERE id = 'm1'").run();
    expect(ftsHits("Redux")).toEqual([]);
    expect(ftsHits("Zustand").map((h) => h.ref_id)).toEqual(["m1"]);
  });

  it("allows only one active memory per subject (supersession)", () => {
    insertMemory("m1", "state.library", "Use Redux Toolkit");
    expect(() => insertMemory("m2", "state.library", "Use Zustand")).toThrow(/UNIQUE/);
    db.prepare("UPDATE memories SET status = 'superseded' WHERE id = 'm1'").run();
    expect(() => insertMemory("m2", "state.library", "Use Zustand")).not.toThrow();
  });

  it("enforces scope/project consistency", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, kind, scope, key, body, trust, status, created_at, updated_at)
           VALUES ('m1', 'decision', 'project', 'k', 'b', 'user', 'active', 0, 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("finds a memory by vector similarity", () => {
    insertMemory("m1", "a", "first");
    insertMemory("m2", "b", "second");
    const ins = db.prepare("INSERT INTO memory_vec (ref_key, embedding) VALUES (?, ?)");
    ins.run("memory:m1", vector(1));
    ins.run("memory:m2", vector(50));
    const top = db
      .prepare("SELECT ref_key FROM memory_vec WHERE embedding MATCH ? AND k = 1")
      .get(vector(1.01)) as { ref_key: string };
    expect(top.ref_key).toBe("memory:m1");
  });

  it("deletes a memory from keyword and vector indexes (T7 precondition)", () => {
    insertMemory("m1", "style.semicolons", "Prefer no semicolons");
    db.prepare("INSERT INTO memory_vec (ref_key, embedding) VALUES (?, ?)").run("memory:m1", vector(1));

    db.prepare("DELETE FROM memories WHERE id = 'm1'").run();

    expect(ftsHits("semicolons")).toEqual([]);
    const left = db.prepare("SELECT count(*) AS n FROM memory_vec WHERE ref_key = 'memory:m1'").get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("keeps message search in sync and cascades on session delete", () => {
    db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', 0, 0)").run();
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('x1', 's1', 'user', 'offline sync bug in RN', 0)",
    ).run();
    const hit = () => db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'offline'").all();
    expect(hit()).toHaveLength(1);
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(hit()).toHaveLength(0);
  });

  it("caps tool output excerpts at 8 KB", () => {
    db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s1', 0, 0)").run();
    db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('x1', 's1', 'tool', '', 0)").run();
    const ins = db.prepare(
      "INSERT INTO tool_calls (id, message_id, name, output_excerpt, created_at) VALUES (?, 'x1', 'bash', ?, 0)",
    );
    expect(() => ins.run("t1", "a".repeat(8192))).not.toThrow();
    expect(() => ins.run("t2", "a".repeat(8193))).toThrow(/CHECK/);
  });
});
