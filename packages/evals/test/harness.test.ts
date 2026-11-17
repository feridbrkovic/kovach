import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickModel } from "../src/cli.js";
import { judge, runExtraction } from "../src/extraction.js";
import { type ExtractionSuite, FixtureError, loadSuites, parseSuite, type RetrievalSuite } from "../src/format.js";
import { embeddingDecision, renderReport } from "../src/report.js";
import { runRetrieval, summarizeRetrieval } from "../src/retrieval.js";
import { fakeEmbedder } from "../../memory-service/test/helpers/fake-embedder.js";

const ROOT = resolve(__dirname, "../../..");
const publicSuites = () => loadSuites([join(ROOT, "evals", "fixtures")], ROOT);

describe("fixture format", () => {
  const base = { kind: "retrieval", projects: [{ id: "p", name: "p" }], memories: [{ id: "m", kind: "decision", project: "p", key: "k", body: "b" }] };

  it("rejects unknown references, bad kinds and invalid patterns with the path of the problem", () => {
    expect(() => parseSuite({ ...base, questions: [{ id: "q", stack: "rn", text: "t", expect: ["nope"] }] }, "x.json")).toThrow(/x\.json\.questions\[0\]\.expect: unknown item "nope"/);
    expect(() => parseSuite({ ...base, questions: [{ id: "q", stack: "rn", project: "zz", text: "t", expect: ["m"] }] }, "x.json")).toThrow(/unknown project "zz"/);
    expect(() => parseSuite({ ...base, memories: [{ id: "m", kind: "fact", key: "k", body: "b" }] }, "x.json")).toThrow(/unknown kind "fact"/);
    expect(() => parseSuite({ ...base, questions: [{ id: "q", stack: "ios", text: "t", expect: ["m"] }] }, "x.json")).toThrow(/stack must be one of/);
    const session = { id: "s", stack: "js", steps: [["user", "hi"]], expect: [{ match: "(" }] };
    expect(() => parseSuite({ kind: "extraction", sessions: [session] }, "y.json")).toThrow(FixtureError);
    expect(() => parseSuite({ kind: "extraction", sessions: [{ ...session, steps: [["tool", "x"]], expect: [] }] }, "y.json")).toThrow(/steps\[0\]/);
  });

  it("loads the public fixtures: every reference resolves", () => {
    const suites = publicSuites();
    const retrieval = suites.filter((s): s is RetrievalSuite => s.kind === "retrieval");
    const extraction = suites.filter((s): s is ExtractionSuite => s.kind === "extraction");
    expect(retrieval.reduce((n, s) => n + s.questions.length, 0)).toBeGreaterThanOrEqual(40);
    expect(extraction.reduce((n, s) => n + s.sessions.length, 0)).toBeGreaterThanOrEqual(12);
    // Every stack the plan names is covered.
    const stacks = new Set(retrieval.flatMap((s) => s.questions.map((q) => q.stack)));
    for (const s of ["rn", "php", "js", "web"]) expect(stacks).toContain(s);
  });

  it("skips folders that don't exist (evals/private on a fresh clone)", () => {
    expect(loadSuites([join(ROOT, "evals", "does-not-exist")], ROOT)).toEqual([]);
  });
});

describe("retrieval eval", () => {
  it("keeps keyword-only recall@6 on the public set at or above its recorded floor, with no leaks", async () => {
    const r = await runRetrieval(publicSuites().filter((s): s is RetrievalSuite => s.kind === "retrieval"));
    expect(r.vectors).toBe(false);
    expect(r.leaks).toBe(0);
    // Regression floor, not the plan's target: raise it when retrieval improves.
    expect(r.recall).toBeGreaterThanOrEqual(0.85);
    // Every repeat error with an exact signature comes back first.
    for (const id of ["rn-svg-crash", "rn-metro-alias", "wp-cart-fatal", "js-db-refused", "web-window"]) {
      expect(r.questions.find((q) => q.id === id)).toMatchObject({ hit: true, rank: 1 });
    }
  });

  it("runs with vectors when an embedder is given, and never leaks another project's items", async () => {
    const r = await runRetrieval(publicSuites().filter((s): s is RetrievalSuite => s.kind === "retrieval"), { embedder: fakeEmbedder() });
    expect(r.vectors).toBe(true);
    expect(r.embedder).toBe("fake-embed");
    expect(r.leaks).toBe(0);
    expect(r.questions).toHaveLength(48);
  });

  it("decides the embedding model by the plan's 5-point rule", () => {
    const rep = (embedder: string, hits: number, vectors = true) =>
      summarizeRetrieval(embedder, vectors, Array.from({ length: 20 }, (_, i) => ({ suite: "s", id: `q${i}`, stack: "js" as const, hit: i < hits, ...(i < hits ? { rank: 1 } : {}), got: [], leaks: [], ms: 1 })));
    expect(embeddingDecision([rep("gemma", 16), rep("qwen", 17)])).toBe("switch to qwen (+5 points recall@6 over gemma).");
    expect(embeddingDecision([rep("gemma", 16), rep("qwen", 16)])).toBe("keep gemma (qwen is +0 points; switching needs +5).");
    expect(embeddingDecision([rep("gemma", 14), rep("qwen", 16)])).toBe("switch to qwen (+10 points recall@6 over gemma).");
    expect(embeddingDecision([rep("gemma", 16), rep("qwen", 15)])).toBe("keep gemma (qwen is -5 points; switching needs +5).");
    expect(embeddingDecision([rep("gemma", 16), rep("none", 18, false)])).toBeUndefined();
  });
});

describe("extraction eval", () => {
  const suite = (): ExtractionSuite => {
    const s = publicSuites().find((x): x is ExtractionSuite => x.kind === "extraction");
    return { ...s!, sessions: s!.sessions.filter((x) => ["wp-shipping-decision", "rn-run-tests", "js-secret-and-rule"].includes(x.id)) };
  };

  it("judges proposals against what each session is worth, one proposal per expectation", () => {
    const expect_ = [{ match: "pest", scope: "global" as const }];
    const j = judge(
      [
        { key: "testing.pest", body: "Use Pest", kind: "preference", scope: "global" },
        { key: "testing.pest2", body: "Pest again", kind: "preference", scope: "global" },
        { key: "x", body: "Pest", kind: "preference", scope: "project" },
      ],
      expect_,
    );
    expect(j.proposals.map((p) => p.matched)).toEqual([0, undefined, undefined]);
    expect(judge([], expect_).missed).toEqual(expect_);
    // A list of acceptable kinds: a wish said by the user is never an "open issue".
    const wish = [{ match: "elementor", kind: ["preference", "decision", "convention"] as ("preference" | "decision" | "convention")[] }];
    const picked = judge(
      [
        { key: "migration.elementor", body: "Other Elementor pages need finding.", kind: "open_issue", scope: "project" },
        { key: "no.page_builders", body: "No page builders such as Elementor.", kind: "preference", scope: "project" },
      ],
      wish,
    );
    expect(picked.proposals.map((p) => p.matched)).toEqual([undefined, 0]);
    // One proposal can cover two wishes said together.
    const two = [{ match: "short|concise" }, { match: "comment" }];
    const merged = judge([{ key: "style.answers", body: "Short answers and code comments in English.", kind: "preference", scope: "global" }], two);
    expect(merged.proposals.map((p) => p.matched)).toEqual([0]);
    expect(merged.missed).toEqual([]);
  });

  it("replays sessions through the real pipeline: a perfect model scores 100%, gates drop secrets", async () => {
    // Answers in the fixture's session order: nothing for the task instruction, the shipping decision, the rule plus a leaked password.
    const answers = [
      { candidates: [] },
      { candidates: [{ kind: "decision", scope: "project", key: "shipping.croatia-serbia", body: "Croatia and Serbia ship for a flat 15 KM with no free threshold.", evidence: ["m1"] }] },
      {
        candidates: [
          { kind: "convention", scope: "project", key: "db.fk-index", body: "Add an index with every foreign key.", evidence: ["m1"] },
          { kind: "decision", scope: "project", key: "staging.password", body: "The staging DB password is Xk9#pLw2Qr7!vT.", evidence: ["m1"] },
        ],
      },
    ];
    const prompts: string[] = [];
    const r = await runExtraction([suite()], async (p) => {
      prompts.push(p);
      return JSON.stringify(answers.shift());
    });
    expect(prompts).toHaveLength(3);
    // The transcript the model reads has the password redacted.
    expect(prompts[2]).not.toContain("Xk9#pLw2Qr7!vT");
    expect(r.sessions.map((s) => [s.id, s.raw, s.proposals.length, s.missed.length])).toEqual([
      ["rn-run-tests", 0, 0, 0],
      ["wp-shipping-decision", 1, 1, 0],
      ["js-secret-and-rule", 2, 1, 0], // the password never reaches the inbox
    ]);
    expect(r).toMatchObject({ proposals: 2, accepted: 2, precision: 1, recall: 1, noisySessions: 0, failed: 0 });
  });

  it("counts a proposal for a task instruction against precision", async () => {
    const r = await runExtraction([{ ...suite(), sessions: suite().sessions.filter((s) => s.id === "rn-run-tests") }], async () =>
      JSON.stringify({ candidates: [{ kind: "preference", scope: "global", key: "workflow.run_tests_first", body: "Always run the tests first.", evidence: ["m1"] }] }),
    );
    // The gate narrows it to the project (said as a task, not a standing wish), but it's still wrong.
    expect(r.sessions[0]!.proposals).toMatchObject([{ key: "workflow.run_tests_first", scope: "project" }]);
    expect(r).toMatchObject({ proposals: 1, accepted: 0, precision: 0, noisySessions: 1 });
  });

  it("records a failing model per session instead of stopping the run", async () => {
    const r = await runExtraction([suite()], async () => {
      throw new Error("server down");
    });
    expect(r.failed).toBe(3);
    expect(r.sessions[0]!.error).toBe("server down");
  });
});

describe("report", () => {
  it("renders targets, the decision and misses", async () => {
    const kw = await runRetrieval(publicSuites().filter((s): s is RetrievalSuite => s.kind === "retrieval"));
    const md = renderReport({ when: new Date(0), suites: ["evals/fixtures/retrieval/developer-world.json"] }, [kw]);
    expect(md).toMatch(/^# Eval run, 1970-01-01 00:00 UTC/);
    expect(md).toMatch(/\| none \(keywords only\) \| \d+% ✅/);
    expect(md).toMatch(/\n\nNo model server: keyword-only retrieval, extraction not run\.\n/);
  });

  it("finds the server's id for a model name", () => {
    const ids = ["mlx-community/Qwen3.6-35B-A3B-4bit", "embeddinggemma-300m-6bit", "Qwen3-Embedding-0.6B-4bit-DWQ"];
    expect(pickModel(ids, "embeddinggemma-300m-6bit")).toBe("embeddinggemma-300m-6bit");
    expect(pickModel(ids, "qwen3-embedding-0.6b")).toBe("Qwen3-Embedding-0.6B-4bit-DWQ");
    expect(pickModel(ids, "Qwen3.6-35B-A3B-4bit")).toBe("mlx-community/Qwen3.6-35B-A3B-4bit");
    expect(pickModel(ids, "nomic-embed")).toBeUndefined();
  });
});
