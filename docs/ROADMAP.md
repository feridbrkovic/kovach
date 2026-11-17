# Roadmap

Working checklist for [MASTER_PLAN.md](../MASTER_PLAN.md). Tick items as they land; a phase is done only when its exit gate passes. Test IDs (T1–T9) are defined in the plan's *Evaluation and acceptance tests*.

**MVP = Phases 0–5 plus agent tracks A1–A2.** Phases 6–8 and A3 come after.

## Phase 0 — Foundations (~1 week)

- [x] Repository scaffold, license, CI, secret scanning
- [x] `@kovach-dev/memory-contract` v1 draft (zod schemas + `MemoryApi`)
- [x] Initial SQLite schema and migration runner
- [x] Mock `MemoryApi` implementation for UI work
- [x] Fixture recorder for agent sessions
- [x] Eval runner (`packages/evals`, `pnpm eval`, Developer › Run Evals in development builds): retrieval recall@6 per embedding model, extraction precision with the chat model, reports in `logs/evals/`
- [x] Public eval set: 48 retrieval questions over 5 synthetic projects (RN/Expo, WooCommerce, Laravel, Next.js, Node) and 16 recorded sessions (`evals/fixtures/`)
- [ ] Private eval set: real tasks from your own projects in `evals/private/` (never committed)
- [ ] Release prep: domain, `kovach-dev` GitHub org, `@kovach-dev` npm scope, trademark search
- [x] Logo: mark + wordmark (SVG, light/dark), app icon, favicon, social preview
- [x] Freeze contract v1
- **Exit gate:** contract v1 frozen; service and UI build against it.

## Phase 1 — Persistent history (1.5–2 weeks)

- [x] Sessions, messages, tool calls stored; FTS5 search over messages
- [x] Resume a session with the last N messages + summary
- [x] Blob store for long tool output (8 KB excerpt in DB)
- [x] UI: history sidebar, search, rename, delete, resume (`apps/desktop`)
- **Exit gate:** T1. Passes (`packages/memory-service/test/acceptance/t1-persistence.test.ts`); confirm on the Mac with a real model.

## Phase 2 — Explicit memory + retrieval v1 (2 weeks)

- [x] Memories CRUD with supersession and audit events
- [x] Project scanner and project card
- [x] sqlite-vec + embeddinggemma; hybrid retrieval (bm25 + vectors, RRF)
- [x] Prompt injection format, cache-friendly layout, citation tracking
- [x] On-demand tools: `search_memory`, `search_history` (`search_docs` moves to Phase 3 with the docs packs)
- [x] UI: memory browser, pin/edit/delete, "used memories" under answers, settings
- [ ] Compare embeddinggemma vs qwen3-embedding:0.6b on the eval set: the runner compares them automatically; qwen3-embedding isn't on the model server yet. embeddinggemma: recall@6 94–96%, MRR 0.85 (keywords only: 88%)
- **Exit gate:** T2, T3, T6, T7. ✅ All four pass, including across restarts.

## Phase 3 — Docs packs + seeding (1–1.5 weeks)

- [x] Pack builder (fetch, chunk by heading, index) for detected library versions: React Native, Expo, React, TypeScript, Node.js, Next.js and Laravel from their docs repos, any other npm library from its own repo at the version's tag. Fetched with a sparse git checkout (no API token, no rate limit); a persistent job queue that pauses during runs
- [x] PHP, WordPress and WooCommerce packs: the PHP manual (php/doc-en, DocBook converted to Markdown, language reference plus the common extensions, links to php.net); WordPress per x.y release (block editor handbook from its `wp/x.y` branch, plus the REST API handbook and coding standards; the Theme and Plugin handbooks aren't in a repository); WooCommerce's developer docs at the newest release of the project's major. Versions come from composer, core's version.php, the WooCommerce plugin, or theme/plugin headers ("Tested up to", "WC tested up to", "Requires PHP")
- [x] Stale detection on upgrade: packs are shared per library version, staleness is per project
- [x] Project seeding flow (AGENTS.md, CLAUDE.md, Cursor/Copilot rules, README guideline sections → review inbox)
- [x] `search_docs` tool, docs in `retrieve()` (top 3 within the budget) and in the task block only when keywords and meaning agree; `[d:…]` citations
- [x] UI: packs per project (Memory › Docs), build/rebuild, progress, seeding into the Review tab
- **Exit gate:** packs for every detected major library; T9; retrieval eval holds. ✅ T9 passes, every detected major library gets a pack (now including PHP, WordPress and WooCommerce), and the retrieval eval holds (94–96% recall@6 on the public set).

## Phase 4 — Experience memory (2–3 weeks)

- [x] Fail-to-pass detection on tool calls: the same check or command fails, files change, then it passes, in one session (`run_command`, `run_checks` per check, and the loop's own checks)
- [x] Error signature normalizer, shared by detection and retrieval (absolute and relative paths, line numbers, hashes, timestamps, ANSI codes)
- [x] Episode summarizer and project-neutral lessons: the local model writes problem, fix and lesson as strict JSON in a background job after the run; lessons with paths, file names or secrets are dropped; read-only and off projects contribute nothing
- [x] Recall mid-run: a failing check or command gets the fixes seen before for that exact error added to its result (`[e:…]`, citable)
- [x] UI: Memory › Fixes, with the lesson, attempts, files changed, versions and verification; delete
- [x] Other projects' fixes need keywords and meaning to agree before they show up in a task without an error (they were crowding out the project's own notes)
- **Exit gate:** T4; recall@6 ≥ 80% on the eval set. ✅ T4 passes; recall@6 94–96% on the public set (re-check on the private set).

## Phase 5 — Inferred + research memory (2 weeks)

- [x] Extraction job (strict JSON, max 5 candidates, evidence required): runs once a session finishes, or after 10 minutes idle; redacted transcript with message ids; paused while the agent runs
- [x] Gates: secret scan, evidence (your own message, or a fetched page for research), scope (a preference becomes global only when said as a standing wish, otherwise it stays with its project), dedup (same text or near-identical meaning), seen-twice before auto-accept, newer pending replaces older, conflicts
- [x] Research freshness and `review_after` revalidation: re-checked after 90 days against its source; changed sources mark it "Needs a re-check"
- [x] UI: review inbox, conflict questions ("Keep what I said" / "Edit" / "Use the new one"), "Still true" for stale research
- [x] Secrets redacted from saved tool output, transcripts and `search_history` results
- [x] T5 and T8 pass
- [x] Extraction precision ≥ 85%: 100% (10/10), recall 91% on the public set, with greedy sampling (temperature 0; the server default gave different proposals each run)
- [x] Review tab shows the share of proposals you accepted from sessions (last 90 days), the same measure on real decisions
- **Exit gate:** T5, T8; extraction precision ≥ 85%.

## Agent track (parallel)

- [x] **A1** (~2 weeks, with Phases 1–2): verify loop, precise context tools (TypeScript language service + Tree-sitter), plan-then-small-steps, strict edits and tool calls
  - [x] Agent loop in `packages/agent`: oMLX/OpenAI-compatible model client, plan of ≤7 steps, strict search/replace edits (≤150 changed lines per step; new content up to 400 lines, including sections added next to an unchanged line; a new file the model wrote longer than that is kept up to 2,000 lines with a note rather than thrown away; ambiguous matches report their line numbers), schema-validated tool calls (2 retries), approval for every command, verify loop that blocks "done" while checks are red, history recording
  - [x] Precise context tools: `find_symbol`, `find_references` and `diagnostics`. TypeScript's language service for type-aware references and type errors in TS/JS (the project's own TypeScript when it has one; one service per tsconfig), and a Tree-sitter index for TS/JS, PHP, Python and Go (definitions with their class, uses by name including WordPress hook callbacks, syntax errors). Indexed on first use, refreshed by modification time: ~1 s to index a few hundred files, ~20 ms after (decision 10). The model is pointed to them from `find_symbol` and from `search` on a bare name; a reply that only restates the plan (or is empty) gets one nudge to act instead of ending the run
  - [x] Wire the loop into the desktop app: new sessions in a project folder, send and resume, live plan/progress/checks, approval prompts, stop, model settings
- [ ] **A2** (~2 weeks, with Phases 3–4): escalation to Ternary Bonsai 2 27B (eval gate against Qwen3.8-27B 4-bit, known-prompt load check), self-review, browser control (Playwright)
  - [x] Request brief and standards: the planning turn restates the task as a ticket (goal, deliverables, requirements, acceptance checks, assumptions) using built-in playbooks for the project type and kind of change; shown above the plan and used by the self-review
  - [x] Source order (code, user's rules and standards, docs packs, web last with official sites first) and Settings › Standards for the user's own rules
  - [x] Page builder for new web pages (`design_kit`): content as data, rendered page in four directions, stock photos, logo mark, search-engine tags, motion; forced as the first step when the request is to make a page
  - [x] Visual check after building a page: headless render at phone and desktop widths, measured findings sent back
  - [x] Mobile: Expo generator run by the loop, `app_kit` architecture (API client, server state, tokens, UI primitives, list and detail screens, sign-in, navigation, EAS profiles), playbooks for React Native, iOS, Android and publishing
  - [x] Model safeguards recorded in `docs/MODEL_NOTES.md` (sampling, retries, repetition and identical-call guards, context trimming, read-only requests)
  - [ ] A full mobile run on the current code, launched in the iOS simulator
  - [ ] Visual check for Expo apps (web export, screenshots of each tab) so the agent sees its screens as it does web pages
  - [x] App kit: sample data per feature until a server exists (`sample.ts`, `env.sampleData`, `EXPO_PUBLIC_SAMPLE_DATA=1` for exported previews); the loop checks the server calls are still there
  - [x] App kit design: four looks chosen from the kind of business, entrance and press animations with a 3D tilt, icons, stock photos for sample rows, hero image on detail screens
  - [x] A run that reaches its step limit ends with a summary and can be continued
  - [ ] App kit: forms, pagination, an action on the detail screen, tests (jest-expo)
  - [ ] Generated pages: fonts stored with the page instead of loaded from Google
  - [x] "Allow for this session" covers commands of the same kind (`npx tsc …`, `npm run test …`), shown on the button; commands that add code, delete, publish or lean on the shell are still remembered exactly
  - [ ] Move the web and mobile start-up steps out of `loop.ts` into one recipe interface
  - [ ] End-to-end task eval set (a few real tasks scored against their briefs)
  - [x] Self-review before finishing: a fresh-context pass over only the task, the diff of what the run changed (tracked per file) and the check results; strict JSON findings, greedy sampling; must-fix findings go back to the agent once to fix or justify, suggestions are only shown; a failing reviewer never holds the run up. Shown as a "Review" step. Loop notes (failing checks, review findings) are no longer stored as the user's words
  - [ ] Escalation to the hard-task model
  - [ ] Browser control
- [ ] **A3** (~2 weeks, with Phase 5): best-of-N in worktrees, device control (simctl, adb, Maestro), optional cloud escalation

## Shipped early — desktop capabilities (parallel to Phase 2+)

Built and tested ahead of their phases so the app is useful now:

- [x] **Web search**: `web_search` + `fetch_page` tools (SearXNG when configured, keyless DuckDuckGo fallback), SSRF guard on fetch, per-run toggle.
- [x] **Image input (multimodal)**: paste, drop or attach images to a task; kept in a content-addressed store and shown in the transcript; old tool screenshots pruned from context.
- [x] **Computer use (opt-in, per run)**: `computer_read_screen` lists the frontmost window's controls from the accessibility tree with ids, and `computer_click {element}` hits them exactly; screenshots (main display, scaled to 1280 px JPEG) on a 0–1000 grid for everything else; click / double / right / drag / type / key / scroll / `computer_open_app`, all in screen points (correct on Retina); cliclick optional (CoreGraphics fallback); every action approved; Screen Recording + Accessibility gating with in-app permission prompts.
- [x] **Image generation**: `generate_image` via a managed mflux + FLUX.2 [klein] 4B (Apache-2.0) environment the app installs on demand (uv or venv); one job at a time.
- [x] **Sessions without a project folder**: a private scratch workspace for questions, research and quick scripts.
- [x] **Redesigned UI**: live transcript with collapsible tool rows, diffs, markdown and inline images; bottom composer with attachments, Enter-to-send and the computer-use switch; Tools settings tab.
- [x] **DMG installer**: unsigned/ad-hoc arm64 build via electron-builder (`scripts/build-dmg.command`), login-shell PATH so the agent finds Node/pnpm/git when launched from Finder.

## After the MVP

- [ ] **Working in a team's codebase** (next):
  - [ ] Workspace map: a compact outline of the repository (packages, entry points, key symbols) built with Tree-sitter, kept fresh, and added to the plan within a token budget instead of read file by file
  - [ ] Read first: before the first edit in an existing project the loop collects the files the change touches, their tests and callers (impact), and the commands CI runs
  - [ ] Git as tools: status, diff, branch, commit with the repository's message style, log and blame for "why is this here"; work on a branch, never on the default one; push and pull requests only on request
  - [ ] Team context: read `AGENTS.md`, `CONTRIBUTING.md`, CODEOWNERS, CI workflows and open pull requests; follow the project's review and test conventions
  - [ ] `read_files`: several files in one call (live runs spend a turn per file)
- [ ] **More playbooks and kits**:
  - [ ] Backend: REST and GraphQL APIs (Node, Laravel), database migrations, auth, background jobs, observability, twelve-factor config
  - [ ] Payments: Stripe, plus the gateways used locally; webhooks, idempotency, test mode only until the user goes live
  - [ ] Business and project flows: requirements to tickets, estimates, release checklists, handover notes
  - [ ] UI/UX: design tokens to components, motion guidelines, 3D (three.js on the web, Reanimated and Skia in apps)
- [ ] **Faster and smarter on the same Mac**:
  - [ ] Keep the prompt cache warm: stable prompt prefix, tool list fixed per run, trimmed history appended not rewritten; measure tokens per turn in the eval report
  - [ ] Speculative decoding or a draft model on oMLX if supported; 6-bit versus 4-bit quality check on the eval set
  - [ ] Second model for hard steps (A2) and best-of-N for stubborn bugs (A3)
  - [ ] End-to-end eval set of real tasks, run before and after every change to prompts or tools
- [ ] **Phase 6 — Skills (teach by research)** (~2 weeks): `/learn`, research job, draft review, skill library, Agent Skills import
- [ ] **Phase 9 — Knowledge library: your projects + quality standards** (~3 weeks, after Phase 6):
  - [ ] Opt-in project folders: Tree-sitter code chunks, docs, configs and commit messages; secret scan; file watching
  - [ ] `search_code` tool ("how did I do this before?") and convention candidates in the Review tab (global after 3+ projects)
  - [ ] Curated standards packs (code review, style guides, OWASP, WCAG 2.2, Apple HIG, Material 3, performance), distilled into sourced rules and reviewed before use
  - [ ] Per-project pack selection; matching rules loaded per task
  - [ ] Standards review before "done": linters, `axe-core`, Lighthouse, screenshot design review; quality report
  - [ ] UI: Knowledge view (projects, packs, injection preview)
  - **Exit gate:** recall@6 ≥ 80% on "how did I do X" questions; clear rubric gain on 30 blind-graded tasks; ≤ 15% slower; no secrets indexed.
- [ ] **Phase 7 — Connectors & automations** (~2.5–3 weeks): MCP client, curated connectors, Gmail (personal OAuth client), automation engine, launchd scheduling, approval inbox
- [ ] **Phase 8 — Image & video generation** (~1.5 weeks, optional): media worker, Z-Image-Turbo, Wan 2.2 / LTX-2.3
- [ ] Desktop computer use (level 3, opt-in): Qwen planner + UI-Venus-1.5-8B grounder
- [ ] **Phone companion app (React Native)**: a paired remote for the user's own Local Kovach — start and follow tasks, approve commands, read replies from the phone. Explicit device pairing, authenticated, foreground app; not covert remote access. See *Phone companion app*.
