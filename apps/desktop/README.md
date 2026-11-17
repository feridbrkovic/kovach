# Local Kovach desktop app

Electron app: main process (memory service, later the agent loop), a sandboxed preload bridge, and a React renderer.

```
src/main/       Opens ~/Library/Application Support/Local Kovach/kovach.db, serves history and the agent over IPC
src/preload/    Exposes window.kovach (history calls + change events) to the renderer
src/shared/     IPC channel names and types shared by both sides
src/renderer/   React UI: history, sessions, new session, live agent progress, approvals, model settings
```

## Run it

```sh
pnpm install
pnpm --filter @kovach-dev/desktop dev      # Electron with hot reload
pnpm --filter @kovach-dev/desktop preview:web  # the UI alone in a browser, on demo data
```

`dev` and `start` first run `native`, which puts a better-sqlite3 binary built for
Electron in `native/` (prebuilt download, or a local compile with the Xcode
command line tools). The app loads it through better-sqlite3's `nativeBinding`
option, so the Node build in `node_modules` keeps working for tests. Electron is
pinned to the newest major that better-sqlite3 ships prebuilt binaries for (42).

## Using the agent

1. Start the model server (oMLX by default at `http://127.0.0.1:8000/v1`) with Qwen3.6-35B-A3B loaded.
2. In the app, open the gear at the bottom of the sidebar, check the address and model name, and press **Test connection**.
3. **New session** → add a project folder → describe the task → **Start**.

The agent plans, edits in small steps and runs the project's checks. Every
command and check asks first; **Allow for this session** stops repeat prompts
for that exact command. It can't finish while checks fail unless you tick
"Let it finish even if checks fail". **Stop** ends a run at any point.
Settings live in `settings.json` next to the database.

## How the pieces talk

- The renderer only knows the contract's history methods (`HistoryApi`) and
  the agent API (`src/shared/agent.ts`). Inside the app both go over IPC; in a
  plain browser they run on the mock `MemoryApi` and a demo agent.
- `src/main/agent-service.ts` runs one task at a time, routes approvals to the
  window and turns agent events into status updates. It has no Electron
  imports, so it is tested directly.
- Results cross IPC in an envelope, so a `MemoryApiError` keeps its `code`.
- Migrations are embedded in the main bundle at build time.

## Tests

`pnpm --filter @kovach-dev/desktop test` runs the IPC bridge against a real
in-memory database and the UI (jsdom + Testing Library) against the mock.
