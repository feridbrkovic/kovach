# Evals

Recorded tasks that check whether memory measurably helps (see *Evaluation and acceptance tests* in the plan). Run them at every phase gate.

- `fixtures/`: public suites, synthetic or from open-source code. Safe to commit.
- `private/`: suites built from client projects. **Gitignored; never commit.** The runner picks them up automatically.

## Running

```sh
pnpm eval                 # everything, against the model server the app uses
pnpm eval retrieval       # recall@6 per embedding model, plus keywords only
pnpm eval extraction      # precision of proposed memories with the chat model
pnpm eval --offline       # no server: keyword-only retrieval
pnpm eval --public        # skip evals/private
pnpm eval --embed embeddinggemma-300m-6bit,qwen3-embedding-0.6b
```

On the Mac, double-click `scripts/run-evals.command`. The server address and chat model come from the app's settings; if the server needs an API key, set `KOVACH_API_KEY`. Reports go to `logs/evals/` (`latest.md`, plus a dated Markdown and JSON copy of each run).

## Targets

| Measure | Target | Source |
| --- | --- | --- |
| Retrieval recall@6 | ≥ 80% of questions have an expected item in the top 6 | Plan, *Targets* |
| Leaks | 0 project-scoped items from another project | Plan, retrieval filters |
| Extraction precision | ≥ 85% of proposals would be accepted in review | Plan, *Targets* |
| Embedding model | switch only for ≥ 5 points more recall@6 | Plan, decision 5 |

## Suite format

One JSON file per suite, anywhere under `fixtures/` or `private/`.

**Retrieval** (`"kind": "retrieval"`): a small world and questions about it.

```json
{
  "kind": "retrieval",
  "name": "my-projects",
  "projects": [{ "id": "shop", "name": "shop", "npm": { "react-native": "0.77.1" } }],
  "memories": [
    { "id": "state", "project": "shop", "kind": "decision", "key": "state.library", "body": "Global state lives in Zustand stores." }
  ],
  "episodes": [
    {
      "id": "ep-map", "project": "shop",
      "problem": "The grid crashed while loading.",
      "error": "TypeError: Cannot read property 'map' of undefined\n    at Grid (src/Grid.tsx:18:25)",
      "fix": "Defaulted the data to [] while loading.",
      "lesson": "Default query data to an empty array before mapping it."
    }
  ],
  "questions": [
    { "id": "q1", "stack": "rn", "project": "shop", "text": "Where should the wishlist state live?", "expect": ["state"] }
  ]
}
```

- Memories without `project` are global. Projects take `npm` and/or `composer` dependencies, so the scanner sees the right stack.
- A question is a hit when any id in `expect` is among the top 6 results of `retrieve()`. Give `errorOutput` for repeat-error questions; write it as the new failure would look (other file, other line), not a copy of the episode's.
- Questions without `project` are asked outside any project.
- `stack` is one of `rn`, `php`, `js`, `web`, `general`, for the per-stack breakdown.

**Extraction** (`"kind": "extraction"`): recorded sessions and what each one is worth remembering.

```json
{
  "kind": "extraction",
  "projects": [{ "id": "api", "name": "api", "npm": { "express": "5.0.1" } }],
  "sessions": [
    {
      "id": "pgboss", "stack": "js", "project": "api",
      "steps": [
        ["user", "Use pg-boss, not BullMQ: no Redis here. Add a shipping email job."],
        ["tool", "edit_file", { "path": "src/jobs/ship.ts" }, 0, "created"],
        ["assistant", "Added the job."]
      ],
      "expect": [{ "match": "pg-?boss|redis", "scope": "project" }]
    }
  ]
}
```

- Each session runs through the real extraction job (transcript, model, gates, dedup) in a fresh database.
- `expect` lists what a reviewer would accept: a case-insensitive regular expression over `"key body"`, optionally with `scope` and `kind`. Each expectation accepts one proposal; anything else proposed counts against precision.
- An empty `expect` means nothing in the session is worth remembering. Most real sessions are like that, so include plenty: plain fixes, questions, task instructions, assistant-only suggestions.

## Writing private suites

Take real tasks from your own projects: questions you actually asked ("how did I set up push on Android?"), errors you actually hit, sessions you actually had. Paths, client names and code stay in `private/`. The plan asks for 30–40 tasks across RN, PHP, JS and web.
