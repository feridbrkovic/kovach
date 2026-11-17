/** Markdown for an eval run: one section per measurement, with the plan's targets. */

import type { ExtractionReport } from "./extraction.js";
import type { RetrievalReport } from "./retrieval.js";

export const TARGETS = {
  /** MASTER_PLAN › Evaluation: expected item in the top 6 for at least 80% of tasks. */
  recall: 0.8,
  /** At least 85% of proposals accepted in review. */
  precision: 0.85,
  /** Switch the embedding model only for at least 5 points more recall@6 (decision 5). */
  embeddingSwitchPoints: 0.05,
} as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mark = (ok: boolean) => (ok ? "✅" : "❌");

export function retrievalSection(reports: RetrievalReport[]): string {
  if (reports.length === 0) return "";
  const first = reports[0]!;
  const out: string[] = [];
  out.push(`## Retrieval (${first.questions.length} questions)`, "");
  out.push(`Target: the expected item in the top 6 for at least ${pct(TARGETS.recall)} of questions; no project-scoped item from another project.`, "");
  out.push("| Embedding model | recall@6 | MRR | Leaks | p95 |", "| --- | --- | --- | --- | --- |");
  for (const r of reports) {
    const name = r.vectors ? r.embedder : `${r.embedder}${r.embedder.startsWith("none") ? "" : " (vectors unavailable: keywords only)"}`;
    out.push(`| ${name} | ${pct(r.recall)} ${mark(r.recall >= TARGETS.recall)} | ${r.mrr.toFixed(2)} | ${r.leaks} ${mark(r.leaks === 0)} | ${Math.round(r.p95ms)} ms |`);
  }
  out.push("");
  for (const r of reports) {
    const stacks = Object.entries(r.byStack)
      .map(([s, v]) => `${s} ${pct(v!.recall)} (${v!.n})`)
      .join(" · ");
    out.push(`**${r.embedder}** by stack: ${stacks}`, "");
    const misses = r.questions.filter((q) => !q.hit);
    if (misses.length) {
      out.push("<details><summary>Misses</summary>", "");
      for (const q of misses) out.push(`- \`${q.id}\`: got ${q.got.length ? q.got.map((g) => `\`${g}\``).join(", ") : "nothing"}`);
      out.push("", "</details>", "");
    }
    const leaky = r.questions.filter((q) => q.leaks.length);
    if (leaky.length) {
      out.push("Leaks:", ...leaky.map((q) => `- \`${q.id}\`: ${q.leaks.join(", ")}`), "");
    }
  }
  const decision = embeddingDecision(reports);
  if (decision) out.push(`**Embedding model:** ${decision}`, "");
  return out.join("\n");
}

/** Decision 5: keep the current model unless another is at least 5 points better. */
export function embeddingDecision(reports: RetrievalReport[]): string | undefined {
  const withVectors = reports.filter((r) => r.vectors);
  if (withVectors.length < 2) return undefined;
  const [current, ...others] = withVectors;
  const best = others.reduce((a, b) => (b.recall > a.recall ? b : a));
  // Whole points, so 85% vs 80% counts as +5 despite floating point.
  const pts = Math.round((best.recall - current!.recall) * 100);
  return pts >= Math.round(TARGETS.embeddingSwitchPoints * 100)
    ? `switch to ${best.embedder} (+${pts} points recall@6 over ${current!.embedder}).`
    : `keep ${current!.embedder} (${best.embedder} is ${pts >= 0 ? `+${pts}` : pts} points; switching needs +${Math.round(TARGETS.embeddingSwitchPoints * 100)}).`;
}

export function extractionSection(r: ExtractionReport | undefined): string {
  if (!r) return "";
  const out: string[] = [];
  out.push(`## Extraction (${r.sessions.length} sessions, model ${r.model})`, "");
  out.push(`Target: at least ${pct(TARGETS.precision)} of proposals would be accepted in review.`, "");
  out.push("| Precision | Recall | Proposals | Noisy sessions | Failed |", "| --- | --- | --- | --- | --- |");
  out.push(
    `| ${pct(r.precision)} (${r.accepted}/${r.proposals}) ${mark(r.precision >= TARGETS.precision)} | ${pct(r.recall)} (${r.found}/${r.expected}) | ${r.proposals} kept of ${r.sessions.reduce((n, s) => n + s.raw, 0)} written by the model | ${r.noisySessions} | ${r.failed} |`,
    "",
  );
  out.push("| Session | Stack | Expected | Kept | Wrong | Missed |", "| --- | --- | --- | --- | --- | --- |");
  for (const s of r.sessions) {
    const wrong = s.proposals.filter((p) => p.matched === undefined);
    const right = s.proposals.length - wrong.length;
    out.push(
      `| \`${s.id}\` | ${s.stack} | ${s.expected} | ${s.error ? `error: ${s.error.slice(0, 60)}` : right} | ${wrong.map((p) => `${p.scope === "global" ? "🌐 " : ""}\`${p.key}\`: ${p.body}`).join("<br>") || "–"} | ${s.missed.map((m) => `\`${m.match}\``).join("<br>") || "–"} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export function renderReport(meta: { when: Date; server?: string; chatModel?: string; suites: string[] }, retrieval: RetrievalReport[], extraction?: ExtractionReport): string {
  const head = [
    `# Eval run, ${meta.when.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    meta.server ? `Server: ${meta.server}${meta.chatModel ? ` · chat model ${meta.chatModel}` : ""}` : "No model server: keyword-only retrieval, extraction not run.",
    "",
    `Suites: ${meta.suites.map((s) => `\`${s}\``).join(", ")}`,
    "",
  ];
  return [head.join("\n"), retrievalSection(retrieval), extractionSection(extraction)].filter(Boolean).join("\n");
}
