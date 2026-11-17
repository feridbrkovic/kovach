# @kovach-dev/agent-fixtures

Record a real agent session once, replay it deterministically in tests. This is what lets the acceptance tests run in CI with a scripted fake model instead of a live Qwen.

## Format

A fixture is a JSONL file, one zod-validated object per line (`FORMAT_VERSION` = 1):

| Line | Fields |
| --- | --- |
| `header` (first line) | `formatVersion`, `recordedAt`, `model`, `projectId?`, `meta` |
| `user` | `at`, `content` |
| `model` | `at`, `content`, `toolCalls: [{ id, name, args? }]`, `tokens?` |
| `tool_result` | `at`, `toolCallId`, `command?`, `exitCode?`, `durationMs?`, `outputExcerpt` (≤ 8192 chars), `outputTruncated?` |
| `end` | `at`, `status` (`done` / `aborted` / `error`) |

Timestamps are Unix epoch milliseconds. A tool result answers a call from the most recent model turn. A file without an `end` line is an incomplete recording; everything before that point is still valid.

## Usage

```ts
import { createRecorder, loadFixture, createScriptedModel, toContractSession } from "@kovach-dev/agent-fixtures";

// Record
const rec = createRecorder({ path: "session.jsonl", header: { model: "qwen3.6-35b-a3b-4bit", projectId: "demo" } });
rec.user("pnpm typecheck fails, please fix it.");
rec.model({ content: "Running it.", toolCalls: [{ id: "c1", name: "shell", args: { command: "pnpm typecheck" } }] });
rec.toolResult({ toolCallId: "c1", command: "pnpm typecheck", exitCode: 2, durationMs: 2900, output: stdout });
rec.end();
rec.close();

// Replay
const fixture = loadFixture("session.jsonl");
const model = createScriptedModel(fixture, { strict: true });
model.next([{ type: "user", content: "pnpm typecheck fails, please fix it." }]); // first recorded turn

// Seed a mock MemoryApi / compare against stored history
const { session, messages } = toContractSession(fixture, { sessionId: "s1" });
```

- **Recorder.** Each event is validated, redacted and written with one synchronous write, so a crash leaves a valid prefix. Output is redacted first, then cut to the 8 KB excerpt.
- **Loader.** `loadFixture` / `parseFixture` throw a `FixtureError` with the file and line number. A torn final line (no trailing newline, not valid JSON) is dropped and the fixture is marked incomplete.
- **Scripted model.** `next(input)` returns the next recorded model turn. `input` is what the agent loop passes since the previous turn: new user messages and tool results. In strict mode it must match the recording (user content and tool call id always; `command`, `exitCode` and `output` only when given), compared after the same redaction. Divergence throws `ScriptDivergenceError`; running past the last turn throws `ScriptExhaustedError`.
- **Contract bridge.** `toContractSession` returns a `SessionSummary` and `Message[]` validated by `@kovach-dev/memory-contract`, with tool results attached to the assistant message that requested them and ids `<sessionId>-m<n>` / `<sessionId>-t<n>`.

## Redaction

Fixtures may be committed publicly. `redact` masks private key blocks, GitHub tokens, AWS access key ids, Stripe keys, JWTs, URL credentials (`scheme://user:pass@`) and `KEY=value` lines whose upper-case key names a secret (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`, ...). Matches become `[REDACTED:<kind>]`. Numbers, booleans, `$VAR` references and code expressions such as `process.env.X` or `getToken()` are left alone.

Redaction is a safety net, not a guarantee: read a fixture before committing it, and keep fixtures from client projects in `evals/private/`.

`test/fixtures/typecheck-fix.jsonl` is a small synthetic example.
