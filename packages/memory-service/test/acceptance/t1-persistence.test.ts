/**
 * T1 — Conversation persistence (MASTER_PLAN.md › Evaluation and acceptance tests).
 * After a restart, messages, tool calls and exit codes of a session are
 * identical and the session resumes.
 *
 * The session is replayed from a recorded agent fixture through the same
 * write path the agent loop uses, into a database file on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixture } from "@kovach-dev/agent-fixtures";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BlobStore, createHistoryStore, type Db, EXCERPT_MAX_BYTES, migrate, openDatabase } from "../../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../agent-fixtures/test/fixtures/typecheck-fix.jsonl", import.meta.url));

let dir: string;
let dbPath: string;
let db: Db | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-t1-"));
  dbPath = join(dir, "kovach.db");
});
afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(clock: () => number) {
  db = openDatabase(dbPath);
  migrate(db);
  return createHistoryStore(db, { blobs: new BlobStore(dir), now: clock });
}

it("T1: a recorded session survives a restart unchanged and resumes", async () => {
  const fixture = loadFixture(FIXTURE);
  let at = fixture.header.recordedAt;
  const history = open(() => at);

  // Replay the fixture as the agent loop would write it.
  const projectId = history.ensureProject({ path: "/work/sample-cart", name: "sample-cart" });
  const session = history.createSession({ projectId, model: fixture.header.model, title: "Fix cart total type error" });
  const callIds = new Map<string, string>(); // recorded id → stored id
  const expectedExitCodes: (number | undefined)[] = [];
  for (const e of fixture.events) {
    at = e.at;
    if (e.type === "user") history.appendMessage(session.id, { role: "user", content: e.content });
    if (e.type === "model") {
      const m = history.appendMessage(session.id, {
        role: "assistant",
        content: e.content,
        model: fixture.header.model,
        ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
        toolCalls: e.toolCalls.map((c) => ({ name: c.name, args: c.args })),
      });
      e.toolCalls.forEach((c, i) => callIds.set(c.id, m.toolCalls[i]!.id));
    }
    if (e.type === "tool_result") {
      history.completeToolCall(callIds.get(e.toolCallId)!, {
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        output: e.outputExcerpt,
      });
      expectedExitCodes.push(e.exitCode);
    }
    if (e.type === "end") history.setStatus(session.id, "done");
  }
  // One long output, so the blob path is part of what must survive.
  at += 1;
  const long = `${"error TS2322: Type 'string' is not assignable to type 'number'.\n".repeat(200)}`;
  const extra = history.appendMessage(session.id, { role: "assistant", content: "Full log attached.", toolCalls: [{ name: "shell" }] });
  history.completeToolCall(extra.toolCalls[0]!.id, { exitCode: 2, output: long });
  expectedExitCodes.push(2);
  history.setSummary(session.id, "Fixed total() in src/cart.ts to return a number; typecheck passes.");

  const before = await history.getSession(session.id);

  // Restart: close the database and open the same file with a fresh store.
  db!.close();
  db = undefined;
  const reopened = open(() => at + 1_000);

  const after = await reopened.getSession(session.id);
  expect(after).toEqual(before);

  const calls = after.messages.items.flatMap((m) => m.toolCalls);
  expect(calls.map((c) => c.exitCode)).toEqual(expectedExitCodes);
  expect(calls.map((c) => c.name)).toEqual(["shell", "edit_file", "shell", "shell"]);
  expect(after.session).toMatchObject({ status: "done", projectId, messageCount: 6 });

  const blobCall = calls.at(-1)!;
  expect(Buffer.byteLength(blobCall.outputExcerpt!, "utf8")).toBeLessThanOrEqual(EXCERPT_MAX_BYTES);
  expect(reopened.readToolOutput(blobCall.id)).toBe(long);

  // Resume: summary plus the last messages, oldest first, and the session accepts new turns.
  const resumed = reopened.resume(session.id, { lastN: 3 });
  expect(resumed.summary).toContain("typecheck passes");
  expect(resumed.messages.map((m) => m.content)).toEqual(after.messages.items.slice(-3).map((m) => m.content));
  const next = reopened.appendMessage(session.id, { role: "user", content: "Now add a test for total()." });
  expect((await reopened.getSession(session.id)).messages.items.at(-1)!.id).toBe(next.id);
});
