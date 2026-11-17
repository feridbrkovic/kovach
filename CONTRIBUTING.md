# Contributing

Thanks for your interest. Local Kovach is early (Phase 0), so the design in [MASTER_PLAN.md](MASTER_PLAN.md) is still moving. Please open an issue to discuss anything larger than a small fix before writing code.

## Setup

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

## Pull requests

- Keep changes small and focused; one concern per PR.
- `pnpm typecheck` and `pnpm test` must pass. New behaviour needs a test.
- Database changes go in a **new** numbered migration under `packages/memory-service/migrations/`; committed migrations are never edited.
- Changes to `packages/memory-contract` bump `CONTRACT_VERSION` and explain the change in the PR.
- Use clear commit messages in English (Conventional Commits are welcome: `feat:`, `fix:`, `docs:` …).

## Never commit

- Secrets, tokens or `.env` files. CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push. Run it locally before committing:

  ```sh
  brew install gitleaks
  gitleaks git --staged    # or add it as a pre-commit hook
  ```

- Model weights, SearXNG data or downloaded documentation packs.
- Code or data from client projects, including eval tasks built from them (`evals/private/` is gitignored for this).

## Licensing

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
