import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryApiError, type MemoryChangeEvent } from "@kovach-dev/memory-contract";
import { BlobStore, createHistoryStore, createMemoryStore, type Db, migrate, openDatabase } from "@kovach-dev/memory-service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combineApi, serveHistory, type IpcHandlerHost } from "../src/main/history-ipc";
import { MIGRATIONS } from "../src/main/migrations";
import { createIpcHistoryApi } from "../src/renderer/src/api";
import { CHANNELS, type Envelope, type KovachBridge } from "../src/shared/ipc";

/** A stand-in for ipcMain + ipcRenderer: values cross through structuredClone, like Electron IPC. */
function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const listeners = new Set<(e: MemoryChangeEvent) => void>();
  const host: IpcHandlerHost = {
    handle: (channel, fn) => void handlers.set(channel, fn),
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const bridge: KovachBridge["history"] = {
    async invoke(method, args) {
      const fn = handlers.get(CHANNELS.invoke);
      if (!fn) throw new Error("no handler");
      return structuredClone((await fn({}, method, structuredClone(args))) as Envelope);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  const broadcast = (e: MemoryChangeEvent) => {
    for (const cb of listeners) cb(structuredClone(e));
  };
  return { host, bridge, broadcast, handlers };
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-ipc-"));
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("embedded migrations", () => {
  it("bundle every migration file, in order", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init.sql", "0002_vectors.sql", "0003_memory_uses.sql", "0004_docs_packs.sql", "0005_extraction.sql", "0006_review_decisions.sql"]);
    expect(migrate(db, MIGRATIONS).applied).toHaveLength(MIGRATIONS.length);
  });
});

describe("history over IPC", () => {
  it("serves the real history store to the renderer, errors and events included", async () => {
    migrate(db, MIGRATIONS);
    const store = createHistoryStore(db, { blobs: new BlobStore(dir) });
    const ipc = fakeIpc();
    const stop = serveHistory(ipc.host, combineApi(store, createMemoryStore(db)), ipc.broadcast);
    const api = createIpcHistoryApi(ipc.bridge);

    const events: MemoryChangeEvent[] = [];
    api.onChange((e) => events.push(e));

    const s = store.createSession({ title: "Cart badge" });
    store.appendMessage(s.id, { role: "user", content: "Add a badge to the cart tab." });

    const list = await api.listSessions({});
    expect(list.items.map((x) => x.title)).toEqual(["Cart badge"]);
    expect((await api.getSession(s.id)).messages.items[0]!.content).toBe("Add a badge to the cart tab.");
    expect((await api.searchMessages({ query: "badge" })).items).toHaveLength(1);

    await api.renameSession(s.id, "Cart tab badge");
    expect((await api.listSessions({})).items[0]!.title).toBe("Cart tab badge");

    // A contract error keeps its code across the bridge.
    const missing = api.getSession("nope");
    await expect(missing).rejects.toBeInstanceOf(MemoryApiError);
    await expect(missing).rejects.toMatchObject({ code: "not_found" });

    await api.deleteSession(s.id);
    expect((await api.listSessions({})).items).toEqual([]);
    expect(events.map((e) => e.type === "session" && e.action)).toEqual(["created", "updated", "updated", "deleted"]);

    stop();
    expect(ipc.handlers.size).toBe(0);
  });

  it("refuses methods outside the history API", async () => {
    const store = createHistoryStore((migrate(db, MIGRATIONS), db), { blobs: new BlobStore(dir) });
    const ipc = fakeIpc();
    serveHistory(ipc.host, combineApi(store, createMemoryStore(db)), ipc.broadcast);
    const result = await ipc.bridge.invoke("vacuum" as never, []);
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "unknown history call: vacuum" } });
  });
});

describe("memory over IPC", () => {
  it("serves the memory store through the same channel, with events", async () => {
    migrate(db, MIGRATIONS);
    const ipc = fakeIpc();
    serveHistory(ipc.host, combineApi(createHistoryStore(db, { blobs: new BlobStore(dir) }), createMemoryStore(db)), ipc.broadcast);
    const api = createIpcHistoryApi(ipc.bridge);
    const events: MemoryChangeEvent[] = [];
    api.onChange((e) => events.push(e));
    const m = await api.createMemory({ kind: "preference", scope: "global", key: "style.quotes", body: "Single quotes" });
    expect((await api.listMemories({})).items.map((x) => x.id)).toEqual([m.id]);
    const edited = await api.updateMemory(m.id, { body: "Double quotes" });
    expect((await api.getMemory(edited.id)).history.map((x) => x.body)).toEqual(["Single quotes"]);
    await expect(api.createMemory({ kind: "preference", scope: "global", key: "k", body: "AKIAABCDEFGHIJKLMNOP" })).rejects.toBeInstanceOf(MemoryApiError);
    expect((await api.retrieve({ text: "quotes" })).items.map((i) => i.text)).toEqual(["style.quotes: Double quotes"]);
    expect(events.filter((e) => e.type === "memory").map((e) => ("action" in e ? e.action : ""))).toEqual(["created", "edited", "superseded"]);
  });
});
