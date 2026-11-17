import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  designKitTool,
  LOOP_NOTE_MARK,
  MAX_SEARCHES,
  reinstallCommand,
  runAgentTask,
  scaffoldsOverProject,
  TOOLS,
  webTools,
  Workspace,
} from "../src/index.js";
import type { ToolContext } from "../src/tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-follow-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (name: string, args: unknown): ChatResponse => ({ content: "", toolCalls: [{ id: `c${Math.random()}`, name, arguments: JSON.stringify(args) }] });
const say = (content: string): ChatResponse => ({ content, toolCalls: [] });
function scripted(replies: ChatResponse[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "test",
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      return replies.shift() ?? say("Done.");
    },
  };
}
const run = (model: ChatModel, task: string, extra: Partial<Parameters<typeof runAgentTask>[0]> = {}) =>
  runAgentTask({ model, workspace: new Workspace(dir), task, approve: async () => true, checks: [], review: false, plan: false, ...extra });

describe("follow-up messages in the same session", () => {
  it("may replace files the session made in an earlier message, but not the project's own", async () => {
    // First message: the page is created.
    const first = await run(scripted([call("create_file", { path: "index.html", content: "<h1>v1</h1>\n" }), say("Made index.html.")]), "Make a page");
    expect(first.made).toEqual(["index.html"]);

    // Follow-up: without knowing what it made, the agent couldn't replace its own page.
    const blind = scripted([call("create_file", { path: "index.html", content: "<h1>v2</h1>\n" }), say("Tried.")]);
    await run(blind, "Make it bolder");
    expect(String(blind.requests[1]!.messages.at(-1)!.content)).toMatch(/already exists and wasn't created in this task/);

    const told = scripted([call("create_file", { path: "index.html", content: "<h1>v2</h1>\n" }), say("Replaced index.html.")]);
    const second = await run(told, "Make it bolder", { madeEarlier: first.made });
    expect(second.status).toBe("done");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("<h1>v2</h1>\n");

    // A file the session didn't make stays protected.
    writeFileSync(join(dir, "README.md"), "mine\n");
    const guarded = scripted([call("create_file", { path: "README.md", content: "theirs\n" }), say("ok")]);
    await run(guarded, "Rewrite the readme", { madeEarlier: second.made });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("mine\n");
  });

  it("lets the page builder rebuild the page it made earlier in the session", async () => {
    const ctx = (made: string[] = []): ToolContext => ({ workspace: new Workspace(dir), approve: async () => true, checks: [], limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 1000 }, createdThisRun: new Set(made) });
    const kit = designKitTool();
    const content = {
      business: "neighbourhood bakery",
      name: "The Daily Crumb",
      seo: { phrase: "bakery", title: "Bakery | The Daily Crumb", description: "Sourdough and croissants baked every morning. Order ahead for tomorrow or drop in while it is warm." },
      hero: { eyebrow: "Bakery", headline: "Bread baked this morning", lede: "Small batches.", action: "Order", facts: [{ label: "Open", value: "[Hours]" }], photo: "bread", scene3d: false },
      ticker: ["Sourdough", "Croissants", "Rye", "Tarts"],
      offer: { label: "Bakes", heading: "Every day", intro: "Made daily.", items: [{ name: "Sourdough", text: "Dark crust." }, { name: "Croissant", text: "Buttery." }, { name: "Tart", text: "Seasonal." }] },
      story: { label: "Story", heading: "Early", paragraphs: ["We bake.", "By hand."], photo: "baker" },
      steps: { label: "Order", heading: "How", items: [{ name: "Ask", text: "Form." }, { name: "Bake", text: "First batch." }, { name: "Pick up", text: "Warm." }] },
      gallery: "pastries",
      faq: { heading: "Questions", items: [{ q: "Cakes?", a: "Yes." }, { q: "Sell out?", a: "Often." }, { q: "Vegan?", a: "Some." }, { q: "Delivery?", a: "No." }] },
      band: { statement: "Order by noon.", action: "Order" },
      contact: { heading: "Hello", intro: "We answer.", details: [{ label: "Address", value: "[Street]" }, { label: "Phone", value: "[Phone]" }], submit: "Send" },
    };
    const first = ctx();
    expect((await kit.run(kit.schema.parse(content), first)).ok).toBe(true);
    // In a later message, with what the session made, the same page can be rebuilt.
    const rebuilt = await kit.run(kit.schema.parse({ ...content, direction: "bold-modern" }), ctx([...first.createdThisRun!]));
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.content).toMatch(/"Bold modern" direction/);
  });

  it("won't create a project inside one that exists", async () => {
    expect(scaffoldsOverProject("npx --yes create-expo-app@latest . --template default", dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), "{}");
    for (const cmd of ["npx create-expo-app@latest brico", "npm create vite@latest web", "npx create-next-app site", "pnpm init"]) expect(scaffoldsOverProject(cmd, dir), cmd).toBe("package.json");
    expect(scaffoldsOverProject("npx expo install expo-image", dir)).toBeUndefined();

    const asked: string[] = [];
    const model = scripted([call("run_command", { command: "npx create-expo-app@latest brico" }), say("The app already exists; I'll change it instead.")]);
    await run(model, "Add sign in with Google", { approve: async (r) => (asked.push(r.command), true) });
    expect(asked).toEqual([]); // refused before the user is even asked
    expect(String(model.requests[1]!.messages.at(-1)!.content)).toMatch(/^Not run: this folder already holds a project \(package\.json\)/);
  });

  it("installs an existing project's missing packages before the work, by its lockfile", async () => {
    expect(reinstallCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(reinstallCommand(dir)).toBeUndefined(); // no lockfile: never installed, the user's call
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(reinstallCommand(dir)).toBe("npm install --no-audit --no-fund");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(reinstallCommand(dir)).toBe("pnpm install");
    mkdirSync(join(dir, "node_modules"));
    expect(reinstallCommand(dir)).toBeUndefined();
    rmSync(join(dir, "node_modules"), { recursive: true });

    const commands: string[] = [];
    const runCommand = { ...TOOLS.find((t) => t.name === "run_command")!, async run(args: unknown) { commands.push((args as { command: string }).command); mkdirSync(join(dir, "node_modules"), { recursive: true }); return { ok: true, exitCode: 0, content: "done" }; } };
    const model = scripted([say("Planned."), say("Added the button.")]);
    await runAgentTask({ model, workspace: new Workspace(dir), task: "Add a share button", approve: async () => true, checks: [], review: false, tools: [...TOOLS.filter((t) => t.name !== "run_command"), runCommand as never], maxTurns: 3 });
    expect(commands).toEqual(["pnpm install"]);
    expect(existsSync(join(dir, "node_modules"))).toBe(true);
  });

  it("marks the loop's notes as its own, so the model doesn't answer them as if the user spoke", async () => {
    const model = scripted([say(""), say("Here is the answer.")]);
    await run(model, "What does add() return?");
    const note = String(model.requests[1]!.messages.at(-1)!.content);
    expect(note.endsWith(LOOP_NOTE_MARK)).toBe(true);
  });
});

describe("web research within a task", () => {
  it("refuses the same search twice and stops at the search budget", async () => {
    const seen: string[] = [];
    const fake = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ results: [{ title: "A result", url: "https://example.com/a", content: "Snippet" }] }));
    }) as typeof fetch;
    const [search] = webTools({ searxngUrl: "http://127.0.0.1:8888", fetch: fake });
    const ctx = { workspace: new Workspace(dir), approve: async () => true, checks: [], limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 1000 } } as ToolContext;
    expect((await search!.run({ query: "Ferid Brković GitHub" }, ctx)).ok).toBe(true);
    const again = await search!.run({ query: "github ferid brković" }, ctx);
    expect(again.ok).toBe(false);
    expect(again.content).toMatch(/already ran this search/);
    for (let i = 1; i < MAX_SEARCHES; i++) expect((await search!.run({ query: `topic number ${i}` }, ctx)).ok).toBe(true);
    const over = await search!.run({ query: "one more thing" }, ctx);
    expect(over.ok).toBe(false);
    expect(over.content).toMatch(new RegExp(`That's ${MAX_SEARCHES} searches in this task`));
    expect(seen).toHaveLength(MAX_SEARCHES);
    // A new task starts with a fresh budget.
    expect((await search!.run({ query: "one more thing" }, { ...ctx })).ok).toBe(true);
  });
});
