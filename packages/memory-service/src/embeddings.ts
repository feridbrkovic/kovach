/**
 * Embeddings for semantic search. The plan uses embeddinggemma (768 dims) served
 * by the same local model server as the chat model; the main model is never
 * needed for search. Anything that can turn text into vectors fits `Embedder`.
 */

export interface Embedder {
  /** Model id, recorded in embedding_meta: a change triggers a re-index. */
  readonly model: string;
  embed(texts: string[], kind: "query" | "document", signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface OpenAiEmbedderOptions {
  /** e.g. "http://127.0.0.1:8000/v1" */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Task prefixes the embedding models were trained with. Using them noticeably
 * improves retrieval; models without one get the text as is.
 */
export function withPrefix(model: string, text: string, kind: "query" | "document"): string {
  const m = model.toLowerCase();
  if (m.includes("embeddinggemma")) return kind === "query" ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  if (m.includes("qwen3-embedding")) {
    return kind === "query" ? `Instruct: Given a coding task, retrieve notes and lessons that help with it\nQuery: ${text}` : text;
  }
  if (m.includes("nomic-embed")) return kind === "query" ? `search_query: ${text}` : `search_document: ${text}`;
  return text;
}

export function createOpenAiEmbedder(options: OpenAiEmbedderOptions): Embedder {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
  return {
    model: options.model,
    async embed(texts, kind, signal) {
      if (texts.length === 0) return [];
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ model: options.model, input: texts.map((t) => withPrefix(options.model, t, kind)) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`embedding server returned ${res.status}: ${body.slice(0, 300)}`);
      const data = JSON.parse(body) as { data?: { embedding?: number[]; index?: number }[] };
      const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding))) {
        throw new Error("embedding server returned an unexpected shape");
      }
      return rows.map((r) => normalize(Float32Array.from(r.embedding!)));
    },
  };
}

/** Unit length, so cosine distance behaves the same for every model. */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
