/**
 * Chat model client for OpenAI-compatible servers (oMLX by default, Ollama as
 * a fallback). The agent only depends on the `ChatModel` interface, so tests
 * use a scripted model and other providers can be added later.
 */

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it; validated by the agent, not here. */
  arguments: string;
}

/** An image sent to the model: base64 data, never a remote URL. */
export interface ImagePart {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** Base64, without the data: prefix. */
  data: string;
}
export type ContentPart = { type: "text"; text: string } | ImagePart;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Ask for JSON matching this schema (structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Called while the reply is being generated (at most a few times a second), so a long tool
   * call (a whole file) shows progress. Asks the server to stream; the result is the same.
   */
  onProgress?: (progress: ModelProgress) => void;
}

export interface ModelProgress {
  /** Characters of text and tool arguments received so far. */
  chars: number;
  /** The tool call being written, once its name is known, with its arguments so far (partial JSON). */
  tool?: { name: string; arguments: string };
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
}

export interface ChatModel {
  /** Model id, e.g. "qwen3.6-35b-a3b". */
  readonly id: string;
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface OpenAiCompatibleOptions {
  /** e.g. "http://127.0.0.1:8000/v1" for oMLX, "http://127.0.0.1:11434/v1" for Ollama. */
  baseUrl: string;
  model: string;
  /** Local servers usually need none. Never logged. */
  apiKey?: string;
  /** Per-request timeout. Default 10 minutes: long prompts on a laptop take a while. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): ChatModel {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  let noTopK = false;

  return {
    id: options.model,
    async complete(req) {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: req.messages.map(toWire),
        stream: !!req.onProgress,
      };
      if (req.onProgress) body.stream_options = { include_usage: true };
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = "auto";
      }
      if (req.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
        };
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      else {
        // What the model's makers recommend for precise coding; a server's own default is often
        // tuned for chat and makes tool calls and code less reliable.
        const sampling = recommendedSampling(options.model);
        if (sampling) Object.assign(body, sampling);
        if (noTopK) delete body.top_k;
      }
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      const post = () =>
        doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal,
        });
      try {
        res = await post();
        // top_k isn't part of the OpenAI API: a server that refuses it gets the request again without it, from then on.
        if ((res.status === 400 || res.status === 422) && body.top_k !== undefined) {
          delete body.top_k;
          noTopK = true;
          res = await post();
        }
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (timeout.aborted) throw new ModelError(`model server did not answer within ${Math.round(timeoutMs / 1000)} s`);
        throw new ModelError(`model server unreachable at ${options.baseUrl}: ${err instanceof Error ? err.message : err}`);
      }
      if (res.ok && req.onProgress && res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        try {
          return await readStream(res.body, req.onProgress);
        } catch (err) {
          if (req.signal?.aborted || err instanceof ModelError) throw err;
          if (timeout.aborted) throw new ModelError(`model server did not answer within ${Math.round(timeoutMs / 1000)} s`);
          throw new ModelError(`the model server's reply was cut off: ${err instanceof Error ? err.message : err}`);
        }
      }
      // Not streaming, or a server that ignored the request to stream: one JSON body.
      const text = await res.text();
      if (!res.ok) throw new ModelError(`model server returned ${res.status}: ${text.slice(0, 500)}`, res.status);

      let data: {
        choices?: { message?: { content?: unknown; tool_calls?: WireToolCall[] }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        data = JSON.parse(text);
      } catch {
        throw new ModelError(`model server sent invalid JSON: ${text.slice(0, 200)}`);
      }
      const choice = data.choices?.[0];
      if (!choice?.message) throw new ModelError("model server sent no message");
      const toolCalls = (choice.message.tool_calls ?? []).map((c, i): ToolCallRequest => {
        const args = c.function?.arguments;
        return {
          id: c.id || `call_${i}`,
          name: c.function?.name ?? "",
          // Some servers send arguments as an object instead of a JSON string.
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        };
      });
      const out: ChatResponse = {
        content: typeof choice.message.content === "string" ? cleanContent(choice.message.content) : "",
        toolCalls,
      };
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
      if (data.usage) {
        out.usage = { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 };
      }
      return out;
    },
  };
}

interface StreamChunk {
  choices?: {
    delta?: { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

/** Reads an OpenAI-style server-sent-event stream into the same shape a plain reply has. */
async function readStream(body: ReadableStream<Uint8Array>, onProgress: (p: ModelProgress) => void): Promise<ChatResponse> {
  const decoder = new TextDecoder();
  const calls: { id: string; name: string; arguments: string }[] = [];
  let content = "";
  let finish: string | undefined;
  let usage: ChatResponse["usage"];
  let chars = 0;
  let lastReport = 0;
  let pending = "";
  let sawChunk = false;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 400) return;
    lastReport = now;
    const current = calls.at(-1);
    onProgress({ chars, ...(current?.name ? { tool: { name: current.name, arguments: current.arguments } } : {}) });
  };
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      return; // a keep-alive or a partial line some servers send
    }
    if (chunk.error) throw new ModelError(`model server error: ${chunk.error.message ?? "unknown"}`);
    sawChunk = true;
    if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 };
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string") {
      content += delta.content;
      chars += delta.content.length;
    }
    for (const c of delta.tool_calls ?? []) {
      const at = c.index ?? calls.length - (c.id ? 0 : 1);
      const call = (calls[Math.max(0, at)] ??= { id: "", name: "", arguments: "" });
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      const args = c.function?.arguments;
      const piece = typeof args === "string" ? args : args === undefined ? "" : JSON.stringify(args);
      call.arguments += piece;
      chars += piece.length;
    }
    report();
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  if (pending.trim()) handle(pending);
  if (!sawChunk) throw new ModelError("model server sent no message");
  report(true);
  const out: ChatResponse = {
    content: cleanContent(content),
    toolCalls: calls.filter((c) => c.name || c.arguments).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || "{}" })),
  };
  if (finish) out.finishReason = finish;
  if (usage) out.usage = usage;
  return out;
}

/** Plain text of a message, images left out. */
export function textOf(content: string | ContentPart[]): string {
  return typeof content === "string" ? content : content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

function wireContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}

function toWire(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case "user":
      return { role: "user", content: wireContent(m.content) };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    default:
      return { role: m.role, content: m.content };
  }
}

/** Tool-call markup a model sometimes leaks into its text ("</parameter>", "</tool_call>") is not part of the answer. */
export function cleanContent(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, (m) => (m.includes("<think>") ? m : ""))
    .replace(/<\/?(parameter|function|tool_call|invoke)\b[^>]*>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Sampling settings a model family is known to need. Undefined: leave it to the server. */
export function recommendedSampling(model: string): Record<string, number> | undefined {
  // Qwen3 family, thinking mode, precise coding (from the model card).
  if (/qwen-?3/i.test(model)) return { temperature: 0.6, top_p: 0.95, top_k: 20 };
  return undefined;
}
