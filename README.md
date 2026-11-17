<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/wordmark-dark.svg">
    <img src="docs/assets/brand/wordmark-light.svg" alt="Local Kovach" height="64">
  </picture>
</p>

# Local Kovach

**Local Kovach** is a desktop coding agent for macOS that runs entirely on your own machine and gets better at your work over time, without retraining the model.

> Status: **planning / Phase 0.** Nothing here is usable yet. The full design is in [MASTER_PLAN.md](MASTER_PLAN.md) and progress is tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

Local Kovach comes from the Bosnian *kovač*, a smith: the one who forges and reshapes tools. "Local" because everything runs on your own machine. Local Kovach is shaped by the work you do with it.

## What it will do

- **Code with real tools.** Reads your projects, runs commands in the terminal, and checks its own work against your typecheck, lint and tests before calling a task done.
- **Remember.** Keeps every conversation, your stated preferences, each project's decisions, and fixes that were verified by a passing build or test. Each task gets a small, ranked slice of that memory, and you can see, edit or delete any of it.
- **Research.** Searches the web through a self-hosted SearXNG instance and reads version-matched official documentation for the libraries your projects use.
- **Learn skills on request.** `/learn <topic>` runs a research job and drafts a skill in the open Agent Skills format, which you review before it is ever used.
- **Later:** browser and simulator control, connectors and automations over MCP, and optional image and video generation.

## What stays on your machine

Everything by default: models, conversations, memory, search queries and connector tokens (in the macOS Keychain). There is no telemetry. A cloud model is never used unless you switch that on for a single task and approve exactly what is sent.

## Requirements

| | |
| --- | --- |
| Reference machine | MacBook Pro, M4 Pro, 48 GB |
| Minimum | Apple Silicon with 32 GB unified memory |
| Main model | Qwen3.6-35B-A3B, 4-bit (~20–22 GB) |
| Hard-task model (optional) | Ternary Bonsai 2 27B, MLX 2-bit (~9 GB), kept loaded next to the main model |
| Model server | [oMLX](https://omlx.ai) (Ollama supported as a fallback) |
| Search | SearXNG in Docker (see [`infra/searxng`](infra/searxng)) |

## Repository layout

```
apps/desktop/              Electron app: main process, preload bridge, React UI
packages/agent/            Agent loop: model client, project tools, verify loop
packages/memory-contract/  Shared types and zod schemas for the memory API
packages/memory-service/   SQLite storage, migrations, retrieval
packages/agent-fixtures/   Record agent sessions as fixtures; replay them with a scripted model
infra/searxng/             Local SearXNG for web search
evals/                     Eval tasks (public fixtures only)
docs/                      Roadmap and assets
```

## Development

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @kovach-dev/desktop dev   # run the desktop app
```

Node 22 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE). Models, SearXNG and documentation packs are downloaded on your machine under their own licenses and are not part of this repository.
