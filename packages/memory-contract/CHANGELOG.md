# @kovach-dev/memory-contract changelog

Breaking changes bump the major version of `CONTRACT_VERSION` and need a migration note here. Additions bump the minor version.

## 1.4.0 (16 Nov 2026)

- **Added:** `getSession(id, { latest: true })`: the first page holds the newest messages (in order) and `nextCursor` pages back to earlier ones, so a long session opens on its latest exchange. Without `latest` paging is unchanged (oldest first).
- **Added:** `getEvidence(memoryId)` and the `EvidenceItem` schema: a memory's or proposal's evidence resolved to a short excerpt (the message, the command and its output, the page or file) and where to open it in history. Deleted evidence comes back as `missing`.
- **Mock:** implements `latest` and `getEvidence`.

## 1.3.0 (16 Nov 2026)

- **Added:** `reviewStats()` and the `ReviewStats` / `ReviewTally` schemas: proposals accepted (and how many after an edit) and rejected over the last 90 days, split into those from sessions and those imported from project files. This is the plan's extraction precision measured on real review decisions.
- **Mock:** counts the resolutions made through it.

## 1.2.0 (16 Nov 2026)

- **Added:** `listEpisodes({ projectId?, query?, cursor? })`, `getEpisode(id)` and `deleteEpisode(id)` for verified fixes (experience memory).
- **Added:** the `{ type: "episode", action: "created" | "deleted", id }` change event.
- **Mock:** implements the three methods over its seeded episodes.

## 1.1.0 (16 Nov 2026)

- **Added:** `suggestDocPacks(projectId)` and the `DocSuggestion` schema: libraries a project uses that can have a docs pack, with this project's pack status.
- **Added:** `seedProject(projectId, { again? })` and `SeedResult`: conventions from AGENTS.md, CLAUDE.md, editor rule files and README guideline sections become review-inbox candidates.
- **Added:** optional `DocPack` fields `label`, `docsVersion`, `note`, `error`, `progress`.
- **Mock:** implements both new methods.

## 1.0.0 (7 Nov 2026)

- **Frozen.** Same surface as `1.0.0-draft.3`. The memory service and the UI build against this version.

## 1.0.0-draft.3

- **Breaking:** `buildDocPack(projectId, library, version)` now takes the project that asked. Older ready packs of the same library become `stale` for that project only.
- **Added:** `MemoryApiError` with `code: MemoryErrorCode` (`not_found`, `invalid`, `conflict`, `project_mode`, `unavailable`), its wire shape `MemoryApiErrorData`, `MemoryApiError.from()` to rebuild it after a transport, and `isMemoryApiError()`.
- **Mock:** throws `MemoryApiError`; writes to `read_only` / `off` projects reject with `project_mode` instead of `conflict`.

## 1.0.0-draft.2

- **Added:** `NewMemoryInput` (the schema's input type). `createMemory` accepts it, so defaulted fields such as `pinned` can be omitted.
- **Added:** in-memory mock at `@kovach-dev/memory-contract/mock` (`createMockMemoryApi`, `demoSeed`).

## 1.0.0-draft.1

- First draft: zod schemas for history, memories, episodes, candidates, retrieval, docs packs, jobs, settings and events, plus the `MemoryApi` interface.
