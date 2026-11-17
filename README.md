<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/wordmark-dark.svg">
    <img src="docs/assets/brand/wordmark-light.svg" alt="Local Kovach" height="64">
  </picture>
</p>

<p align="center">
  A coding agent for macOS that runs entirely on your own machine<br>
  and gets better at your work over time, without retraining the model.
</p>

<p align="center">
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-E8642C">
  <img alt="Platform: macOS on Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-17181C">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early-8A8F98">
</p>

Local Kovach is a desktop app that plans a task, edits your project in small steps, runs your checks, reviews its own diff and only then says it is done. The model, your code, the conversation history and everything it learns stay on your Mac.

The name comes from the Bosnian *kovač*, a smith: the one who forges and reshapes tools. "Local" because nothing leaves your machine.

<p align="center">
  <img src="docs/assets/readme/app-home.png" alt="Local Kovach: the start screen with the session history and the composer" width="900">
</p>

> **Status: early.** It is used daily by its author on one machine and is built from source. There is no signed release yet, and the interfaces still change. The design is in [MASTER_PLAN.md](MASTER_PLAN.md); progress is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Built for software engineering

Local Kovach is not a general chat assistant with a terminal attached. Every part of it is shaped by how software gets built:

- **Done means the checks pass.** The project's own typecheck, lint and tests decide when a task is finished, not the model's opinion of its work.
- **It knows the stack it is in.** Playbooks for React Native and Expo, native iOS and Android, web pages, search-engine work and store releases are part of the plan for the matching kind of project and change.
- **It reads the docs for your versions**, not the ones it remembers: packs are built from each library's own repository for the versions in your lockfile.
- **It learns from fixed errors.** A fix is stored under the normalised error it resolved and comes back when that error appears again, in this project or another.
- **It follows your conventions.** Rules from `AGENTS.md`, editor rule files and your own stated preferences are retrieved for the task at hand.
- **It navigates code like an IDE**: definitions, references and outlines from the TypeScript language service and Tree-sitter.
- **It starts projects the way the ecosystem does**: Expo's generator for apps, then a kit for the architecture, instead of files written from memory.

## What it does

### Works in your project
- **Brief, plan, small steps.** Every task is first restated as a short ticket (goal, deliverables, acceptance checks, assumptions) and a plan you can read before anything is changed.
- **Checks decide when it is done.** After editing it runs your typecheck, lint and tests. A failing check goes back to the model with the error and, when it has seen that error before, the fix that worked.
- **A second look.** Before finishing, a fresh pass reads only the task, the diff and the check results, and sends real problems back once.
- **Precise context.** The TypeScript language service and Tree-sitter give it definitions, references and outlines instead of whole files.

### Remembers, and shows you what it remembers
- **Preferences, decisions and conventions** you stated, per project or for all projects. Nothing is saved without your approval: proposals wait in a review inbox with the messages they came from.
- **Verified fixes.** When a check fails, files change and the same check passes, the problem, the fix and the lesson are kept and offered the next time that error shows up.
- **Every session**, searchable, resumable, and yours to rename or delete.
- **Version-matched docs.** It indexes the official documentation for the library versions your project actually uses (React Native, Expo, React, Next.js, Node.js, TypeScript, Laravel, PHP, WordPress, WooCommerce and any npm library with docs in its repo).

| What it remembers | The docs it reads |
| --- | --- |
| <img src="docs/assets/readme/app-memory.png" alt="The Memory view: preferences, decisions, conventions and research, each with its scope and source" width="440"> | <img src="docs/assets/readme/app-docs.png" alt="The Docs tab: documentation packs built for the exact library versions of a project" width="440"> |

### Builds things that hold up
- **Web pages and landing pages.** The model supplies the content; a page builder renders a full page in one of four design directions, with a logo mark, motion, form validation and search-engine tags. With web access on, it finds stock photos under public-domain or attribution licences and writes the credits. The page is then opened in a headless browser at phone and desktop widths, and measured problems go back to the model. Facts only the owner knows are left as `[placeholders]`, never invented.
- **React Native apps.** A new app is created with Expo's own generator, then an app kit adds the architecture: one API client with zod validation, TanStack Query, design tokens, accessible UI primitives, a folder per feature with list and detail screens, optional sign-in with the token in secure storage, navigation and EAS build profiles. Playbooks cover React Native, native iOS and Android, and building, signing and store submission. It prepares a release; you publish it.

**An app from the app kit.** One request ("a barber booking app with sign-in, barbers and my bookings"): a look chosen from the kind of business, icons, rows that fade in and lean under the finger, stock photos for the sample data, and a detail screen with a hero image.

<p align="center">
  <img src="docs/assets/readme/result-app.png" alt="Generated app screens in a dark look: sign-in, a list of barbers with photos, a barber's detail screen with a hero image and facts, and the bookings list" width="900">
</p>

**A landing page from the page builder**, top to bottom as it was generated. Square brackets mark the facts only the owner knows.

<p align="center">
  <img src="docs/assets/readme/result-page.jpg" alt="A generated bakery landing page, full length: hero, product list, story, ordering steps, gallery, quote placeholder, questions, call to action and contact form" width="560">
</p>

The photos in both were found by the app itself; all are public domain (CC0) and listed in each project's `CREDITS.md`.

### Uses tools, with your say
- **Terminal commands ask first.** "Allow for this session" covers commands of the same kind (`npx tsc …`) and says so on the button; anything that installs, deletes or publishes is asked about every time.
- **Web search and page fetching**, switched on per run: through your own SearXNG instance when one is configured, otherwise a keyless fallback.
- **Images in and out.** Paste a screenshot into a task; generate images locally with FLUX.2 [klein] through MLX.
- **Computer use, opt-in per run**: reads the front window through the accessibility tree and clicks controls by id.

## How it works

<p align="center">
  <img src="docs/assets/readme/how-it-works.svg" alt="A task goes through understand, work and verify to an answer. A failing check or review finding goes back to work. After the session, what was learned goes into the knowledge kept on your Mac, which is retrieved for the next plan and searched again while working." width="900">
</p>

The retrieval step is what makes a mid-sized local model useful on a real project. Before planning, the task is matched against four stores (memories, past sessions, documentation packs and verified fixes) by keyword search and by meaning, the two rankings are merged, and only a small ranked slice goes into the prompt, each item with a citation. While working, the model can search the same stores again with `search_memory`, `search_docs` and `search_history`, and a failing command is answered together with the fix that worked for that error before.

<details>
<summary><b>The specifics, stage by stage</b></summary>

| Stage | What happens |
| --- | --- |
| Context | Memory is found by hybrid search (BM25 and vectors, merged by reciprocal rank fusion) and each task gets a small ranked slice of it. Docs come from packs built for the library versions in your lockfile. The always-on part of the prompt is built once per session so the model's prompt cache holds. |
| Plan | The plan is strict JSON with a brief (goal, deliverables, requirements, acceptance checks, assumptions). Built-in playbooks for the kind of project and change are part of the planning prompt. |
| Model | Sampling follows the model card for precise coding (temperature 0.6, top_p 0.95, top_k 20); review and extraction run greedy. |
| Loop guards | A tool call the server could not parse is retried. A reply that repeats itself is thrown away. The same call with the same arguments gets a note, then stops the run. Old tool output is trimmed once the conversation is long. A task has at most 40 turns and 3 rounds of failing checks. |
| Forced steps | For a new page only the page builder is offered until the page exists; for a new app the loop runs Expo's generator itself and offers only the app kit until the architecture is in. |
| Approvals | Commands, web access, screen control and image generation ask first. Memory saves are asked about one by one, always. |
| Verify | Checks come from the project (typecheck, lint, tests). The review is a separate pass that sees only the task, the diff and the results, answers in strict JSON, and can send the work back once. |
| Learn | When a session is finished or idle for ten minutes, at most five proposals are extracted, each with the message it rests on. A fix is kept only when the same check failed, files changed, and it passed in one session. |

</details>

## Architecture

<p align="center">
  <img src="docs/assets/readme/architecture.svg" alt="The desktop app holds the interface, the agent and the memory. The agent talks to a local model server and your project; memory uses SQLite. The web is reached only when you switch it on." width="900">
</p>

A pnpm monorepo. The four packages that make up the app depend on each other in one direction only:

- **`memory-contract`** is the shared language: zod schemas and the `MemoryApi` type. The interface and the storage are built against it and never against each other, so either can be replaced or mocked.
- **`memory-service`** owns the data. One SQLite database holds sessions, messages and tool calls (searchable with FTS5), memories with their history, documentation chunks and fixes; `sqlite-vec` adds vector search in the same file. It also runs the background jobs (proposing memories, summarising fixes, building docs packs), which pause while the agent works so one model is enough.
- **`agent`** is the loop and everything it can do: the model client (any OpenAI-compatible server), tools, playbooks, the page builder and the app kit. It has no dependency on Electron, which is why the same loop runs in tests and evals against a scripted model.
- **`desktop`** is the Electron shell. The main process hosts the agent and the memory, asks for approvals and renders pages off-screen for the visual check. The React interface runs without Node access and talks to the main process over a typed bridge.

Design choices that follow from running locally:

- **The model is a separate process** reached over HTTP on `127.0.0.1`, so it can be swapped or restarted without touching the app.
- **Tools do the work the model is unreliable at.** Pages are rendered from structured content; project scaffolding comes from generators; edits are exact-match replacements that fail loudly.
- **Trust boundaries are in code.** Commands, web access and screen control go through one approval path; secrets are found by a deterministic scanner before anything is stored; `.env` files are never read.
- **Everything is testable without a model.** Recorded sessions replay against a scripted model, and the eval runner measures retrieval and extraction on public fixtures.

## What stays on your machine

Everything, by default: models, conversations, memory, documentation packs and search queries. There is no telemetry. Secrets are scanned for and removed before anything is written to memory or history, by a deterministic scanner rather than by the model.

## Why it is built this way

A local 35B model is not a frontier model, and the app is designed around that. Whatever must happen is done by a tool or enforced by the loop, not asked for in a prompt: the page builder renders pages from data, the loop runs the project generator itself, repeated or empty replies are caught and sent back. Each failure seen in real runs and the safeguard for it is listed in [docs/MODEL_NOTES.md](docs/MODEL_NOTES.md).

## Requirements

| | |
| --- | --- |
| Machine | Apple Silicon Mac with 32 GB unified memory or more (developed on an M4 Pro, 48 GB) |
| Main model | Qwen3.6-35B-A3B, 4-bit (about 20–22 GB) |
| Embeddings | embeddinggemma-300m |
| Model server | [oMLX](https://omlx.ai) on `127.0.0.1:8000`, or another OpenAI-compatible local server |
| Web search (optional) | SearXNG in Docker, see [`infra/searxng`](infra/searxng) |
| Image generation (optional) | installed on demand by the app |

## Getting started

```sh
git clone https://github.com/feridbrkovic/kovach.git
cd kovach
corepack enable
pnpm install
pnpm --filter @kovach-dev/desktop dev   # or double-click scripts/start-mac.command
```

Start oMLX with the model loaded first. Node 22 or newer.

To build an unsigned DMG for your own Mac, run `scripts/build-dmg.command`.

```sh
pnpm typecheck
pnpm test
pnpm eval        # retrieval and extraction evals against the public fixtures
```

## Repository layout

```
apps/desktop/              Electron app: main process, preload bridge, React UI
packages/agent/            Agent loop, tools, playbooks, page builder, app kit
packages/memory-contract/  Shared types and zod schemas for the memory API
packages/memory-service/   SQLite storage, retrieval, docs packs, fixes, extraction
packages/agent-fixtures/   Record agent sessions as fixtures; replay them with a scripted model
packages/evals/            Eval runner
evals/                     Public eval fixtures
infra/searxng/             Local SearXNG for web search
docs/                      Roadmap, model notes, assets
```

## What is next

Skills learned by research (`/learn <topic>`), connectors and automations over MCP, a stronger second model for hard tasks, simulator and device control, and a phone companion app. See the [roadmap](docs/ROADMAP.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Models, SearXNG and documentation packs are downloaded on your machine under their own licences and are not part of this repository.
