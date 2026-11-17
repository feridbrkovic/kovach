/**
 * Memory tools (MASTER_PLAN › Read path, "On-demand tools"). The always-on and
 * recalled blocks stay small; when they aren't enough the agent can search
 * memory and earlier sessions itself, and save something the user explicitly
 * asked it to remember (the user approves the save).
 *
 * The agent package doesn't know the memory service; the host passes these
 * three functions in.
 */
import { z } from "zod";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

export interface MemoryBackend {
  /** Search long-term memory; returns lines ready for the model. */
  searchMemory(query: string): Promise<string>;
  /** Search earlier conversations; returns lines ready for the model. */
  searchHistory(query: string): Promise<string>;
  /** Save a memory the user asked for. Returns a confirmation line. */
  remember(input: { kind: RememberKind; scope: "global" | "project"; key: string; body: string }): Promise<string>;
  /** Search the official docs for the library versions this project uses. Optional: no tool without it. */
  searchDocs?(query: string, library?: string): Promise<string>;
}

export type RememberKind = "preference" | "decision" | "convention" | "open_issue";

export function memoryTools(backend: MemoryBackend): AgentTool[] {
  const search: AgentTool = {
    name: "search_memory",
    description:
      "Search what you remember about this user and project (preferences, decisions, conventions, lessons from earlier fixes). Use it when the notes you were given aren't enough.",
    schema: z.object({ query: z.string().min(2) }),
    async run(args): Promise<ToolOutcome> {
      const { query } = args as { query: string };
      return { ok: true, content: (await backend.searchMemory(query)) || "Nothing in memory matches that." };
    },
  } as AgentTool;

  const history: AgentTool = {
    name: "search_history",
    description: "Search earlier conversations with this user (what was asked, decided or tried before). Returns matching snippets with dates.",
    schema: z.object({ query: z.string().min(2) }),
    async run(args): Promise<ToolOutcome> {
      const { query } = args as { query: string };
      return { ok: true, content: (await backend.searchHistory(query)) || "No earlier conversation matches that." };
    },
  } as AgentTool;

  const remember: AgentTool = {
    name: "remember",
    description:
      "Save something to long-term memory ONLY when the user explicitly asks you to remember it. Use a short dotted subject as key (e.g. style.semicolons) and state the fact in one sentence. scope 'global' for personal preferences, 'project' for this project's decisions and conventions. The user approves every save.",
    schema: z.object({
      kind: z.enum(["preference", "decision", "convention", "open_issue"]),
      scope: z.enum(["global", "project"]),
      key: z.string().min(2).max(80),
      body: z.string().min(3).max(600),
    }),
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const a = args as { kind: RememberKind; scope: "global" | "project"; key: string; body: string };
      const where = a.scope === "global" ? "for all projects" : "for this project";
      if (!(await ctx.approve({ kind: "memory", command: `Remember ${where} (${a.kind}) ${a.key}: ${a.body}`, cwd: ctx.workspace.root }))) {
        return { ok: false, content: "The user declined saving this to memory." };
      }
      try {
        return { ok: true, content: await backend.remember(a) };
      } catch (err) {
        return { ok: false, content: `Not saved: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  } as AgentTool;

  const tools = [search, history, remember];
  if (backend.searchDocs) {
    const searchDocs = backend.searchDocs.bind(backend);
    tools.push({
      name: "search_docs",
      description:
        "Search the official documentation for the exact library versions this project uses (React Native, Expo, React, TypeScript, Node.js and others). Use it before relying on an API you aren't sure about for this version. Optionally name the library.",
      schema: z.object({ query: z.string().min(2), library: z.string().optional().describe("e.g. 'react-native', 'expo', 'node'") }),
      async run(args): Promise<ToolOutcome> {
        const { query, library } = args as { query: string; library?: string };
        return { ok: true, content: (await searchDocs(query, library)) || "No docs match that. This project may have no docs pack for that library yet." };
      },
    } as AgentTool);
  }
  return tools;
}
