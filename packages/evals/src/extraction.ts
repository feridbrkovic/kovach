/**
 * Extraction eval: replay each recorded session through the real extraction job
 * (transcript, model, gates, dedup) and compare what lands in the review inbox
 * with what the session is worth remembering. Precision is the share of
 * proposals a reviewer would accept (the plan's target: 85%).
 */

import type { Candidate } from "@kovach-dev/memory-contract";
import { type Extractor, parseExtraction } from "@kovach-dev/memory-service";
import type { ExpectedProposal, ExtractionSuite, MemoryFixture, SessionFixture, Stack } from "./format.js";

type MemoryFixtureKind = MemoryFixture["kind"];
import { createWorld } from "./world.js";

export interface Proposal {
  key: string;
  body: string;
  kind: string;
  scope: "global" | "project";
  /** Index into the session's expect list when a reviewer would accept it. */
  matched?: number;
}

export interface SessionResult {
  suite: string;
  id: string;
  stack: Stack;
  note?: string;
  proposals: Proposal[];
  /** How many items the session is worth (its expect list). */
  expected: number;
  /** Expected items nothing matched. */
  missed: ExpectedProposal[];
  /** How many candidates the model wrote before the gates. */
  raw: number;
  error?: string;
  ms: number;
}

export interface ExtractionReport {
  model: string;
  sessions: SessionResult[];
  proposals: number;
  accepted: number;
  /** accepted / proposals; 1 when nothing was proposed. */
  precision: number;
  expected: number;
  found: number;
  recall: number;
  /** Sessions with nothing worth remembering that still got a proposal. */
  noisySessions: number;
  failed: number;
}

export function matches(p: { key: string; body: string; kind: string; scope: string }, e: ExpectedProposal): boolean {
  if (e.scope && e.scope !== p.scope) return false;
  if (e.kind && !(Array.isArray(e.kind) ? e.kind : [e.kind]).includes(p.kind as MemoryFixtureKind)) return false;
  return new RegExp(e.match, "i").test(`${p.key} ${p.body}`);
}

/**
 * Pair proposals with expectations. Each expectation accepts at most one proposal
 * (a second one saying the same is noise), but one proposal may cover several
 * expectations at once ("short answers and comments in English").
 */
export function judge(candidates: Pick<Candidate, "key" | "body" | "kind" | "scope">[], expect: ExpectedProposal[]): { proposals: Proposal[]; missed: ExpectedProposal[] } {
  const used = new Set<number>();
  const proposals = candidates.map((c): Proposal => {
    const i = expect.findIndex((e, j) => !used.has(j) && matches(c, e));
    if (i >= 0) expect.forEach((e, j) => !used.has(j) && matches(c, e) && used.add(j));
    return { key: c.key, body: c.body, kind: c.kind, scope: c.scope, ...(i >= 0 ? { matched: i } : {}) };
  });
  return { proposals, missed: expect.filter((_, j) => !used.has(j)) };
}

async function runSession(suite: ExtractionSuite, s: SessionFixture, extractor: Extractor): Promise<SessionResult> {
  let raw = 0;
  let failure: string | undefined;
  const counting: Extractor = async (prompt, signal) => {
    try {
      const out = await extractor(prompt, signal);
      raw += parseExtraction(out).length;
      return out;
    } catch (err) {
      failure = (err as Error).message;
      throw err;
    }
  };
  const world = createWorld(suite.projects, { extractor: counting });
  const started = performance.now();
  try {
    const { history, memory, projects } = world;
    const projectId = s.project ? projects.get(s.project) : undefined;
    const session = history.createSession({ ...(projectId ? { projectId } : {}), title: s.id });
    for (const st of s.steps) {
      if (st[0] === "tool") {
        const [, name, args, exit, output] = st;
        const m = history.appendMessage(session.id, {
          role: "assistant",
          content: "",
          toolCalls: [{ name, args, ...(typeof args.command === "string" ? { command: args.command } : {}) }],
        });
        history.completeToolCall(m.toolCalls[0]!.id, { exitCode: exit, output });
      } else history.appendMessage(session.id, { role: st[0], content: st[1] });
    }
    history.setStatus(session.id, "done");
    memory.queueExtraction(session.id);
    await memory.jobs.idle();
    const candidates = await memory.listCandidates();
    const judged = judge(candidates, s.expect);
    return {
      suite: suite.name,
      id: s.id,
      stack: s.stack,
      ...(s.note ? { note: s.note } : {}),
      ...judged,
      expected: s.expect.length,
      raw,
      ...(failure ? { error: failure } : {}),
      ms: performance.now() - started,
    };
  } finally {
    world.close();
  }
}

export function summarizeExtraction(model: string, sessions: SessionResult[]): ExtractionReport {
  const ok = sessions.filter((s) => !s.error);
  const proposals = ok.reduce((n, s) => n + s.proposals.length, 0);
  const accepted = ok.reduce((n, s) => n + s.proposals.filter((p) => p.matched !== undefined).length, 0);
  const expected = ok.reduce((n, s) => n + s.expected, 0);
  const found = expected - ok.reduce((n, s) => n + s.missed.length, 0);
  return {
    model,
    sessions,
    proposals,
    accepted,
    precision: proposals ? accepted / proposals : 1,
    expected,
    found,
    recall: expected ? found / expected : 1,
    noisySessions: ok.filter((s) => s.expected === 0 && s.proposals.length > 0).length,
    failed: sessions.length - ok.length,
  };
}

export async function runExtraction(
  suites: ExtractionSuite[],
  extractor: Extractor,
  opts: { model?: string; onSession?: (r: SessionResult) => void } = {},
): Promise<ExtractionReport> {
  const all: SessionResult[] = [];
  for (const suite of suites) {
    for (const s of suite.sessions) {
      const r = await runSession(suite, s, extractor);
      opts.onSession?.(r);
      all.push(r);
    }
  }
  return summarizeExtraction(opts.model ?? "scripted", all);
}
