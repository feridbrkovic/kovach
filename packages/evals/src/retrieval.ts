/**
 * Retrieval eval: seed a suite's world, ask each question through retrieve()
 * (what the agent gets for a task) and check whether an expected item is in the
 * top 6 (the plan's recall@6, target 80%).
 */

import { RETRIEVAL_BUDGET } from "@kovach-dev/memory-contract";
import { type Embedder, errorSignatureOf } from "@kovach-dev/memory-service";
import type { RetrievalSuite, Stack } from "./format.js";
import { createWorld } from "./world.js";

export const TOP_K = RETRIEVAL_BUDGET.maxTaskItems;

export interface QuestionResult {
  suite: string;
  id: string;
  stack: Stack;
  hit: boolean;
  /** 1-based rank of the first expected item, if it came back at all. */
  rank?: number;
  /** Fixture ids (or "?" for unknown rows) of what came back, best first. */
  got: string[];
  /** Project-scoped items from another project that came back (must stay 0). */
  leaks: string[];
  ms: number;
}

export interface RetrievalReport {
  embedder: string;
  vectors: boolean;
  questions: QuestionResult[];
  recall: number;
  mrr: number;
  byStack: Partial<Record<Stack, { n: number; recall: number }>>;
  leaks: number;
  p95ms: number;
}

/** Seed one suite and answer its questions. */
export async function runRetrievalSuite(suite: RetrievalSuite, opts: { embedder?: Embedder } = {}): Promise<{ results: QuestionResult[]; vectors: boolean }> {
  const world = createWorld(suite.projects, opts.embedder ? { embedder: opts.embedder } : {});
  try {
    const { memory, db, projects } = world;
    const realToFixture = new Map<string, string>();
    const ownerOf = new Map<string, string | undefined>();
    for (const m of suite.memories) {
      const projectId = m.project ? projects.get(m.project) : undefined;
      const created = await memory.createMemory({
        kind: m.kind,
        scope: projectId ? "project" : "global",
        ...(projectId ? { projectId } : {}),
        key: m.key,
        body: m.body,
      });
      realToFixture.set(`memory:${created.id}`, m.id);
      ownerOf.set(m.id, m.project);
    }
    const insert = db.prepare(
      `INSERT INTO episodes (id, project_id, session_id, problem, error_signature, env_json, attempts_json, fix_summary, files_json, verified_by, lesson, status, created_at)
       VALUES (?, ?, NULL, ?, ?, '{}', '[]', ?, '[]', ?, ?, 'active', ?)`,
    );
    for (const e of suite.episodes) {
      const id = `ep_${e.id.replace(/[^a-z0-9_]/gi, "_")}`;
      insert.run(id, projects.get(e.project) ?? null, e.problem, errorSignatureOf(e.error) || null, e.fix, e.verifiedBy ?? "test", e.lesson, Date.now());
      realToFixture.set(`episode:${id}`, e.id);
      // Episodes cross projects as lessons only, so they never count as leaks.
      ownerOf.set(e.id, undefined);
    }
    if (opts.embedder) {
      const r = await memory.reindex();
      if (r.error) throw new Error(`embedding failed: ${r.error}`);
    }
    const vectors = memory.vectorsReady();

    const results: QuestionResult[] = [];
    for (const q of suite.questions) {
      const projectId = q.project ? projects.get(q.project) : undefined;
      const started = performance.now();
      const r = await memory.retrieve({
        ...(projectId ? { projectId } : {}),
        text: q.text,
        ...(q.errorOutput ? { errorOutput: q.errorOutput } : {}),
      });
      const ms = performance.now() - started;
      const got = r.items.slice(0, TOP_K).map((i) => realToFixture.get(`${i.ref.type}:${i.ref.id}`) ?? "?");
      const idx = got.findIndex((g) => q.expect.includes(g));
      const leaks = got.filter((g) => {
        const owner = ownerOf.get(g);
        return owner !== undefined && owner !== q.project;
      });
      results.push({ suite: suite.name, id: q.id, stack: q.stack, hit: idx >= 0, ...(idx >= 0 ? { rank: idx + 1 } : {}), got, leaks, ms });
    }
    return { results, vectors };
  } finally {
    world.close();
  }
}

export function summarizeRetrieval(embedder: string, vectors: boolean, questions: QuestionResult[]): RetrievalReport {
  const n = questions.length || 1;
  const byStack: RetrievalReport["byStack"] = {};
  for (const q of questions) {
    const s = (byStack[q.stack] ??= { n: 0, recall: 0 });
    s.n++;
    if (q.hit) s.recall++;
  }
  for (const s of Object.values(byStack)) s.recall = s.recall / s.n;
  const times = questions.map((q) => q.ms).sort((a, b) => a - b);
  return {
    embedder,
    vectors,
    questions,
    recall: questions.filter((q) => q.hit).length / n,
    mrr: questions.reduce((sum, q) => sum + (q.rank ? 1 / q.rank : 0), 0) / n,
    byStack,
    leaks: questions.reduce((sum, q) => sum + q.leaks.length, 0),
    p95ms: times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)]! : 0,
  };
}

export async function runRetrieval(suites: RetrievalSuite[], opts: { embedder?: Embedder } = {}): Promise<RetrievalReport> {
  const all: QuestionResult[] = [];
  let vectors = suites.length > 0;
  for (const s of suites) {
    const r = await runRetrievalSuite(s, opts);
    all.push(...r.results);
    vectors &&= r.vectors;
  }
  return summarizeRetrieval(opts.embedder?.model ?? "none (keywords only)", vectors, all);
}
