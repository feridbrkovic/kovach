import { type Embedder, normalize } from "../../src/index.js";

/**
 * A deterministic embedder for tests: words (and their synonyms) hash into
 * fixed dimensions, so texts that share meaning end up close together.
 */
export function fakeEmbedder(opts: { model?: string; dims?: number; synonyms?: Record<string, string> } = {}): Embedder & { calls: number; fail: boolean } {
  const dims = opts.dims ?? 768;
  const syn = opts.synonyms ?? {};
  const self = {
    model: opts.model ?? "fake-embed",
    calls: 0,
    fail: false,
    async embed(texts: string[]) {
      self.calls++;
      if (self.fail) throw new Error("embedding server down");
      return texts.map((t) => {
        const v = new Float32Array(dims);
        for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const w = syn[raw] ?? raw;
          let h = 2166136261;
          for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
          v[Math.abs(h) % dims]! += 1;
        }
        return normalize(v);
      });
    },
  };
  return self;
}
