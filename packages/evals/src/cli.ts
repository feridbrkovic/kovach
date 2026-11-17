/**
 * Run the evals against the local model server the app uses.
 *
 *   pnpm eval                      # retrieval (embedding comparison) + extraction
 *   pnpm eval retrieval            # recall@6 with each embedding model, and keywords only
 *   pnpm eval extraction           # precision of proposals with the chat model
 *   pnpm eval --offline            # no server: keywords-only retrieval, fixtures check
 *
 * Options: --base-url URL, --model ID, --embed a,b (models to compare; the first is
 * the current one), --public (skip evals/private), --out DIR.
 * The server and chat model default to the app's settings. An API key, if the
 * server needs one, comes from KOVACH_API_KEY (the app keeps its own encrypted).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAiCompatibleModel } from "@kovach-dev/agent";
import { createOpenAiEmbedder, EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, EXTRACTION_TEMPERATURE, type Extractor } from "@kovach-dev/memory-service";
import { type ExtractionReport, runExtraction } from "./extraction.js";
import { type ExtractionSuite, loadSuites, type RetrievalSuite } from "./format.js";
import { renderReport } from "./report.js";
import { type RetrievalReport, runRetrieval } from "./retrieval.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_EMBEDDINGS = ["embeddinggemma-300m-6bit", "qwen3-embedding-0.6b"];

interface Args {
  what: "all" | "retrieval" | "extraction";
  baseUrl?: string;
  model?: string;
  embed?: string[];
  offline: boolean;
  publicOnly: boolean;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { what: "all", offline: false, publicOnly: false, out: join(ROOT, "logs", "evals") };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => {
      const n = argv[++i];
      if (!n) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === "retrieval" || v === "extraction" || v === "all") a.what = v;
    else if (v === "--base-url") a.baseUrl = next();
    else if (v === "--model") a.model = next();
    else if (v === "--embed") a.embed = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--offline") a.offline = true;
    else if (v === "--public") a.publicOnly = true;
    else if (v === "--out") a.out = resolve(next());
    else if (v !== "--") throw new Error(`unknown argument ${v}`);
  }
  return a;
}

/** The app's model settings (server and chat model), when it has saved any. */
function appSettings(): { modelBaseUrl?: string; model?: string } {
  const file = join(homedir(), "Library", "Application Support", "Local Kovach", "settings.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      ...(typeof raw.modelBaseUrl === "string" ? { modelBaseUrl: raw.modelBaseUrl } : {}),
      ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    };
  } catch {
    return {};
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The server's id for a model name: exact, then ignoring case and punctuation, then by prefix. */
export function pickModel(ids: string[], wanted: string): string | undefined {
  return ids.find((i) => i === wanted) ?? ids.find((i) => squash(i) === squash(wanted)) ?? ids.find((i) => squash(i).includes(squash(wanted)));
}

async function serverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`${baseUrl} needs an API key: set KOVACH_API_KEY`);
  if (!res.ok) throw new Error(`${baseUrl}/models returned ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = [join(ROOT, "evals", "fixtures"), ...(args.publicOnly ? [] : [join(ROOT, "evals", "private")])];
  const suites = loadSuites(dirs, ROOT);
  const retrievalSuites = suites.filter((s): s is RetrievalSuite => s.kind === "retrieval");
  const extractionSuites = suites.filter((s): s is ExtractionSuite => s.kind === "extraction");
  console.log(`Loaded ${suites.length} suites: ${retrievalSuites.reduce((n, s) => n + s.questions.length, 0)} questions, ${extractionSuites.reduce((n, s) => n + s.sessions.length, 0)} sessions.`);

  const settings = appSettings();
  const baseUrl = args.baseUrl ?? settings.modelBaseUrl ?? "http://127.0.0.1:8000/v1";
  const apiKey = process.env.KOVACH_API_KEY || undefined;
  let ids: string[] = [];
  if (!args.offline) {
    ids = await serverModels(baseUrl, apiKey);
    console.log(`Server ${baseUrl}: ${ids.length} models.`);
  }

  const retrieval: RetrievalReport[] = [];
  if (args.what !== "extraction") {
    const wanted = args.offline ? [] : (args.embed ?? DEFAULT_EMBEDDINGS);
    for (const name of wanted) {
      const id = pickModel(ids, name);
      if (!id) {
        console.log(`Embedding model ${name}: not on the server, skipped.`);
        continue;
      }
      console.log(`Retrieval with ${id}…`);
      const embedder = createOpenAiEmbedder({ baseUrl, model: id, ...(apiKey ? { apiKey } : {}) });
      const r = await runRetrieval(retrievalSuites, { embedder });
      console.log(`  recall@6 ${Math.round(r.recall * 100)}%, MRR ${r.mrr.toFixed(2)}, leaks ${r.leaks}`);
      retrieval.push(r);
    }
    console.log("Retrieval with keywords only…");
    const kw = await runRetrieval(retrievalSuites);
    console.log(`  recall@6 ${Math.round(kw.recall * 100)}%, MRR ${kw.mrr.toFixed(2)}, leaks ${kw.leaks}`);
    retrieval.push(kw);
  }

  let extraction: ExtractionReport | undefined;
  let chatModel: string | undefined;
  if (args.what !== "retrieval" && !args.offline) {
    const name = args.model ?? settings.model ?? "Qwen3.6-35B-A3B-4bit";
    chatModel = pickModel(ids, name);
    if (!chatModel) console.log(`Chat model ${name}: not on the server, extraction skipped.`);
    else {
      const model = createOpenAiCompatibleModel({ baseUrl, model: chatModel, ...(apiKey ? { apiKey } : {}) });
      const extractor: Extractor = async (prompt, signal) =>
        (
          await model.complete({
            messages: [
              { role: "system", content: EXTRACTION_SYSTEM },
              { role: "user", content: prompt },
            ],
            jsonSchema: { name: "memory_candidates", schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> },
            temperature: EXTRACTION_TEMPERATURE,
            ...(signal ? { signal } : {}),
          })
        ).content;
      console.log(`Extraction with ${chatModel}…`);
      extraction = await runExtraction(extractionSuites, extractor, {
        model: chatModel,
        onSession: (s) =>
          console.log(`  ${s.id}: ${s.error ? `error ${s.error}` : `${s.proposals.filter((p) => p.matched !== undefined).length} right, ${s.proposals.filter((p) => p.matched === undefined).length} wrong, ${s.missed.length} missed`} (${Math.round(s.ms / 1000)} s)`),
      });
      console.log(`  precision ${Math.round(extraction.precision * 100)}%, recall ${Math.round(extraction.recall * 100)}%`);
    }
  }

  const when = new Date();
  const md = renderReport(
    { when, ...(args.offline ? {} : { server: baseUrl }), ...(chatModel ? { chatModel } : {}), suites: suites.map((s) => s.file) },
    retrieval,
    extraction,
  );
  mkdirSync(args.out, { recursive: true });
  const stamp = when.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  writeFileSync(join(args.out, `${stamp}.md`), md);
  writeFileSync(join(args.out, `${stamp}.json`), JSON.stringify({ retrieval, extraction }, null, 2));
  writeFileSync(join(args.out, "latest.md"), md);
  console.log(`\nReport: ${join(args.out, "latest.md")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`Eval failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
