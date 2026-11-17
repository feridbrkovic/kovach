import { type ChatModel, createOpenAiCompatibleModel } from "@kovach-dev/agent";
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, EXTRACTION_TEMPERATURE, type Extractor, type FixSummary, type Summarizer, summaryPrompt } from "@kovach-dev/memory-service";

const SCHEMA = {
  type: "object",
  properties: {
    problem: { type: "string" },
    fixSummary: { type: "string" },
    lesson: { type: "string" },
  },
  required: ["problem", "fixSummary", "lesson"],
  additionalProperties: false,
} as const;

/**
 * Episode summaries come from the same local model as the agent (decision 2:
 * no second LLM in memory). It runs as a background job after the run, so it
 * never competes with the user's task.
 */
export function createFixSummarizer(model: () => ChatModel | undefined): Summarizer {
  return async (fix, context, signal) => {
    const m = model();
    if (!m) throw new Error("no model configured");
    const res = await m.complete({
      messages: [
        { role: "system", content: "You write short, factual notes about bugs that were fixed. Answer with JSON only." },
        { role: "user", content: summaryPrompt(fix, context) },
      ],
      jsonSchema: { name: "fix_summary", schema: SCHEMA as unknown as Record<string, unknown> },
      ...(signal ? { signal } : {}),
    });
    const text = res.content.replace(/^[\s\S]*?(\{)/, "$1").replace(/\}[^}]*$/, "}");
    const parsed = JSON.parse(text) as Partial<FixSummary>;
    if (typeof parsed.problem !== "string" || typeof parsed.fixSummary !== "string") throw new Error("summary missing fields");
    return {
      problem: parsed.problem,
      fixSummary: parsed.fixSummary,
      ...(typeof parsed.lesson === "string" && parsed.lesson.trim() ? { lesson: parsed.lesson } : {}),
    };
  };
}

/** The model the user configured, built fresh so settings changes apply. */
export function settingsModel(get: () => { modelBaseUrl: string; model: string; apiKey?: string }): () => ChatModel | undefined {
  return () => {
    const s = get();
    if (!s.modelBaseUrl || !s.model) return undefined;
    return createOpenAiCompatibleModel({ baseUrl: s.modelBaseUrl, model: s.model, ...(s.apiKey ? { apiKey: s.apiKey } : {}) });
  };
}

/**
 * Memory extraction (Phase 5) on the same local model: the prompt comes from
 * the memory service, the answer is constrained to its JSON schema and parsed
 * (and gated) there.
 */
export function createMemoryExtractor(model: () => ChatModel | undefined): Extractor {
  return async (prompt, signal) => {
    const m = model();
    if (!m) throw new Error("no model configured");
    const res = await m.complete({
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM },
        { role: "user", content: prompt },
      ],
      jsonSchema: { name: "memory_candidates", schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> },
      temperature: EXTRACTION_TEMPERATURE,
      ...(signal ? { signal } : {}),
    });
    return res.content;
  };
}
