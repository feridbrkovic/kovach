import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_DIRECTIONS, designKitTool, directionFromReference, isAnnouncement, KIT_JS, logoSvg, PAGE_SCRIPT_MARKER, photoTools, runAgentTask, searchPhotos, kitCss, kitMarkup, PAGE_RULES_MARKER, pickDirection, pickPlaybooks, planPrompt, renderPlaybooks, TOOLS, Workspace } from "../src/index.js";
import { type ChatMessage, type ChatModel, cleanContent, ModelError, recommendedSampling } from "../src/model.js";
import { isReadOnlyRequest, isRepetitive, trimOldOutput } from "../src/loop.js";
import type { ToolContext } from "../src/tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-kit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): ToolContext => ({
  workspace: new Workspace(dir),
  approve: async () => true,
  checks: [],
  limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 1000 },
  createdThisRun: new Set(),
});
const kit = TOOLS.find((t) => t.name === "design_kit")!;

const CONTENT = {
  business: "neighbourhood bakery",
  name: "The Daily Crumb",
  seo: { phrase: "bakery in Sarajevo", title: "Bakery in Sarajevo | The Daily Crumb", description: "Sourdough, croissants and tarts baked every morning in Sarajevo. Order ahead for tomorrow or drop in while the loaves are still warm from the oven." },
  hero: { eyebrow: "Neighbourhood bakery", headline: "Bread baked this morning, a short walk away", emphasis: "a short walk", lede: "Small batches before sunrise.", action: "Order for tomorrow", photo: "sourdough loaves" },
  offer: { label: "Bakes", heading: "Three things every day", intro: "Made daily.", items: [{ name: "Sourdough", text: "Dark crust.", price: "$8.50" }, { name: "Croissant", text: "Buttery.", price: "$4.75" }, { name: "Tarts & cakes", text: "Seasonal.", price: "$32" }] },
  story: { label: "Our story", heading: "An early start", paragraphs: ["We bake every morning.", "By hand."], photo: "baker hands dough" },
  steps: { label: "Ordering", heading: "How to order", items: [{ name: "Ask", text: "Send the form." }, { name: "We bake", text: "First batch." }, { name: "Pick up", text: "Warm." }] },
  gallery: "bakery pastries",
  faq: { heading: "Questions", items: [{ q: "Cakes?", a: "Yes." }, { q: "Sell out?", a: "Often." }, { q: "Vegan?", a: "Some." }, { q: "Delivery?", a: "No." }] },
  band: { statement: "Order by noon.", action: "Order" },
  contact: { heading: "Say hello", intro: "We answer.", details: [{ label: "Address", value: "[Street]" }, { label: "Phone", value: "[Phone]" }], submit: "Send" },
};

describe("design kit", () => {
  it("picks a direction from the kind of business, or the one asked for", () => {
    expect(pickDirection("neighbourhood bakery").id).toBe("warm-editorial");
    expect(pickDirection("SEO services company").id).toBe("bold-modern");
    expect(pickDirection("dental clinic").id).toBe("calm-professional");
    expect(pickDirection("wedding photographer portfolio").id).toBe("dark-studio");
    expect(pickDirection("something else entirely").id).toBe("calm-professional");
    expect(pickDirection("bakery", "dark-studio").id).toBe("dark-studio");
  });

  it("every direction is a complete stylesheet whose markup uses only classes it defines", () => {
    for (const d of DESIGN_DIRECTIONS) {
      const css = kitCss(d);
      expect(css.trimEnd().endsWith(PAGE_RULES_MARKER)).toBe(true);
      for (const token of ["--paper", "--ink", "--accent", "--accent-ink", "--font-display", "--font-body", "--step-3", "--space-5"]) expect(css).toContain(`${token}:`);
      expect(css).toContain("prefers-reduced-motion");
      expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
      const classes = new Set([...kitMarkup(d, "styles.css").matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
      for (const c of classes) expect(css, `${d.id}: .${c}`).toMatch(new RegExp(`\\.${c}(?![\\w-])`));
      expect(kitMarkup(d, "styles.css")).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("builds the whole page from content: ten sections, search tags, motion, a logo", async () => {
    const c = ctx();
    const out = await kit.run(kit.schema.parse(CONTENT), c);
    expect(out.ok).toBe(true);
    expect(out.change).toEqual({ path: "index.html", before: null });
    expect(out.content).toContain('Built the page in the "Warm editorial" direction');
    expect(out.content).toContain("web access is off");
    expect(out.content).toContain("Left for the user to fill in: [A sentence from a real customer], [Their name], [Street], [Phone].");
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('<h1 class="display">Bread baked this morning, <em>a short walk</em> away</h1>');
    expect(html.match(/<section/g)!.length).toBeGreaterThanOrEqual(9);
    for (const part of ['<title>Bakery in Sarajevo | The Daily Crumb</title>', '<meta name="description"', 'property="og:title"', '"@type":"LocalBusiness"', '"@type":"FAQPage"', 'class="menu"', 'class="faq"', 'class="gallery"', 'class="band"', '<form class="form reveal" novalidate>', '<script src="script.js" defer>', "data-year", 'Photo: sourdough loaves']) expect(html).toContain(part);
    // Placeholders never reach the structured data, and text is escaped.
    expect(html).not.toContain('"telephone"');
    expect(html).toContain("Tarts &amp; cakes");
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(readFileSync(join(dir, "styles.css"), "utf8")).toContain("Design kit: Warm editorial");
    expect(readFileSync(join(dir, "script.js"), "utf8")).toBe(KIT_JS);
    expect(readFileSync(join(dir, "assets/logo.svg"), "utf8")).toBe(logoSvg("The Daily Crumb", DESIGN_DIRECTIONS[0]!));
    // Every class the page uses is in the stylesheet.
    const css = readFileSync(join(dir, "styles.css"), "utf8");
    for (const cls of new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)))) expect(css, `.${cls}`).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
    // It made the files in this run, so it may build again in another direction.
    expect((await kit.run(kit.schema.parse({ ...CONTENT, direction: "bold-modern" }), c)).ok).toBe(true);
    expect(readFileSync(join(dir, "styles.css"), "utf8")).toContain("Design kit: Bold modern");
  });

  it("finds and places photos when web access is on, and says which are missing", async () => {
    const fetcher = (async (url: string | URL) =>
      String(url).includes("api.openverse.org")
        ? new Response(JSON.stringify({ results: [1, 2, 3].map((i) => ({ title: `Loaf ${i}`, tags: [{ name: "sourdough" }, { name: "loaves" }, { name: "baker" }, { name: "hands" }, { name: "dough" }, { name: "bakery" }, { name: "pastries" }], creator: "Ana", license: "cc0", url: `https://img.example/${i}.jpg`, width: 2000, height: 1500 })) }))
        : new Response(Buffer.alloc(5000, 1))) as unknown as typeof fetch;
    const withPhotos = designKitTool({ photos: { fetch: fetcher } });
    const out = await withPhotos.run(withPhotos.schema.parse(CONTENT), ctx());
    expect(out.content).toContain('5 photos found and placed; still labelled places: 1 of 4 for "bakery pastries"');
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html).toContain('<img src="assets/sourdough-loaves-1.jpg" alt="sourdough loaves" width="2000" height="1500" data-parallax>');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('<p class="credits">Photos: Loaf 1 by Ana (CC0)');
  });

  it("leaves a project's own page alone", async () => {
    writeFileSync(join(dir, "styles.css"), "body { color: red; }\n");
    const out = await kit.run(kit.schema.parse(CONTENT), ctx());
    expect(out.ok).toBe(false);
    expect(out.content).toContain("follow their conventions instead of the kit");
    expect(readFileSync(join(dir, "styles.css"), "utf8")).toBe("body { color: red; }\n");
    expect(existsSync(join(dir, "index.html"))).toBe(false);
  });

  it("the web page standards send the planner to it first", () => {
    const text = renderPlaybooks(pickPlaybooks("make a landing page for a bakery", []));
    expect(text).toMatch(/^Static web page or landing page:\n- A new page or site is built with the design_kit tool/);
    expect(text).toContain("no emoji as pictures or icons");
    expect(text).toContain("[square brackets]");
  });
});

describe("what comes with the kit", () => {
  it("the script is self-contained, honours reduced motion and loads three.js only for a 3D scene", () => {
    expect(KIT_JS.trimEnd().endsWith(PAGE_SCRIPT_MARKER)).toBe(true);
    expect(KIT_JS).toContain("prefers-reduced-motion");
    expect(KIT_JS.match(/import\(/g)).toHaveLength(1);
    expect(KIT_JS).toContain('import("https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js")');
    expect(() => new Function(KIT_JS)).not.toThrow(); // it parses
  });

  it("gives the same business the same mark, in the direction's colours", () => {
    const d = DESIGN_DIRECTIONS[0]!;
    const shape = (name: string) => logoSvg(name, d).replace(/aria-label="[^"]*"/, "");
    expect(shape("Golden Crust")).toBe(shape("golden crust "));
    expect(logoSvg("Golden Crust", d)).toContain(d.tokens["--accent"]);
    expect(new Set(["Golden Crust", "RankFlow", "Apolo", "Riket", "Kovach", "Lexon"].map((n) => logoSvg(n, d).replace(/aria-label="[^"]*"/, ""))).size).toBeGreaterThan(2);
    expect(logoSvg('a"<b>', d)).not.toContain('"<b>');
  });
});

describe("stock photos", () => {
  const results = [
    { title: "Too small", creator: "x", license: "by", license_version: "2.0", url: "https://img.example/small.jpg", foreign_landing_url: "https://src.example/1", width: 640, height: 480 },
    { title: "Sourdough loaves", tags: [{ name: "bread" }], creator: "Ana", license: "by", license_version: "2.0", url: "https://img.example/loaves.jpg", foreign_landing_url: "https://src.example/2", width: 4000, height: 3000 },
    { title: "Bread shelf", tags: [{ name: "sourdough" }, { name: "loaves" }], creator: "", license: "cc0", license_version: "1.0", url: "https://img.example/shelf.png", foreign_landing_url: "", width: 2000, height: 1500 },
  ];
  const fakeFetch = (status = 200) =>
    (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.openverse.org/")) {
        expect(u).toContain("license=cc0%2Cpdm%2Cby");
        expect(u).toMatch(/q=(sourdough\+loaves|sourdough|loaves)&/);
        expect(u).toContain("source=stocksnap%2Crawpixel");
        return new Response(JSON.stringify({ results }), { status });
      }
      return new Response(Buffer.alloc(5000, 1), { status: 200 });
    }) as unknown as typeof fetch;

  it("saves photos into the project with their size, alt text and credit", async () => {
    const [find] = photoTools({ fetch: fakeFetch(), resize: async (data) => ({ data, width: 1600, height: 1200 }) });
    const out = await find!.run(find!.schema.parse({ query: "sourdough loaves", count: 2 }), ctx());
    expect(out.ok).toBe(true);
    expect(out.content).toContain('- assets/sourdough-loaves-1.jpg (1600×1200): alt="sourdough loaves". Credit: Sourdough loaves by Ana (CC BY 2.0)');
    expect(out.content).toContain("- assets/sourdough-loaves-2.jpg (1600×1200)");
    expect(out.content).toContain("Bread shelf (CC0)");
    expect(existsSync(join(dir, "assets/sourdough-loaves-1.jpg"))).toBe(true);
    expect(readFileSync(join(dir, "assets/CREDITS.md"), "utf8")).toContain("- assets/sourdough-loaves-1.jpg: Sourdough loaves by Ana (CC BY 2.0), https://src.example/2");
  });

  it("tries a long query as pairs and single words, and keeps only photos that are about what was asked", async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown[]> = {
      "kneading dough": [
        { title: "Kneading dough, 1934", tags: [{ name: "museum" }], creator: null, license: "pdm", url: "https://img.example/old.jpg", width: 4000, height: 3000 },
        { title: "Hands kneading bread dough", tags: [{ name: "baker" }], creator: null, license: "cc0", url: "https://img.example/k.jpg", width: 4000, height: 3000 },
      ],
      // A one-word search finds things that merely share the word: a portrait, a plant.
      baker: [{ title: "Woman; inscribed 'Miss Baker'", creator: "museum", license: "cc0", url: "https://img.example/miss.jpg", width: 3000, height: 4000 }],
      kneading: [{ title: "Arctostaphylos bakeri", tags: [{ name: "plant" }], license: "by", url: "https://img.example/plant.jpg", width: 3000, height: 2000 }],
    };
    const fetcher = (async (url: string | URL) => {
      const q = new URL(String(url)).searchParams.get("q")!;
      asked.push(q);
      return new Response(JSON.stringify({ results: answers[q] ?? [] }));
    }) as unknown as typeof fetch;
    const found = await searchPhotos("Baker kneading dough!", "wide", { fetch: fetcher }, undefined, 2);
    expect(asked).toEqual(["baker kneading dough", "baker kneading", "kneading dough", "baker dough", "kneading", "baker"]);
    // Only the stock photo: not the archive scan, the portrait or the plant.
    expect(found.map((p) => p.url)).toEqual(["https://img.example/k.jpg"]);
    expect(found[0]).toEqual({ title: "Hands kneading bread dough", creator: "", license: "CC0", url: "https://img.example/k.jpg", page: "", width: 4000, height: 3000 });
  });

  it("says what to do instead when the search is rate-limited or finds nothing", async () => {
    const [limited] = photoTools({ fetch: fakeFetch(429) });
    const out = await limited!.run(limited!.schema.parse({ query: "sourdough loaves" }), ctx());
    expect(out.ok).toBe(false);
    expect(out.content).toContain("rate-limited");
    expect(out.content).toContain("labelled photo place");
  });
});

describe("planning and replies", () => {
  it("plans research first only when the agent can search", () => {
    expect(planPrompt(["a.js"], "", "", true)).toContain("Research belongs in the plan");
    expect(planPrompt(["a.js"])).not.toContain("Research belongs in the plan");
  });

  it("a long reply that closes on a promise to fix something is still only an announcement", () => {
    const long = `${"The hero is too tall on desktop and the share tags are missing. ".repeat(8)}\nThe two key issues are:\n1. Duplicate min-height\n2. Missing OG tags\n\nLet me fix these two issues.`;
    expect(long.length).toBeGreaterThan(400);
    expect(isAnnouncement(long)).toBe(true);
    expect(isAnnouncement(`${"I built the page with three files and checked it at two widths. ".repeat(8)}Open index.html to see it.`)).toBe(false);
    expect(isAnnouncement("Let me check the code.")).toBe(true);
  });

  it("drops tool-call markup a model leaks into its text", () => {
    expect(cleanContent("Let me fix these two issues.\n</parameter>")).toBe("Let me fix these two issues.");
    expect(cleanContent("Use <section> and </section> here.")).toBe("Use <section> and </section> here.");
  });

  it("asks again when the model server can't read a tool call, instead of failing the task", async () => {
    let calls = 0;
    const seen: string[] = [];
    const model: ChatModel = {
      id: "test",
      async complete(req) {
        calls++;
        seen.push(String(req.messages.at(-1)!.content));
        if (calls === 1) throw new ModelError("model server error: Model output contains an unrecoverable tool call.", 500);
        return { content: "It returns the sum of two numbers.", toolCalls: [] };
      },
    };
    const outcome = await runAgentTask({ model, workspace: new Workspace(dir), task: "What does add() return?", approve: async () => true, checks: [], plan: false });
    expect(outcome).toMatchObject({ status: "done", message: "It returns the sum of two numbers." });
    expect(seen[1]).toMatch(/^Your last reply couldn't be read: its tool call was malformed/);
  });

  it("stops a model that keeps making the same call, after telling it once", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    const seen: string[] = [];
    const model: ChatModel = {
      id: "test",
      async complete(req) {
        seen.push(String(req.messages.at(-1)!.content));
        return { content: "", toolCalls: [{ id: `c${seen.length}`, name: "read_file", arguments: '{"path":"a.txt"}' }] };
      },
    };
    const outcome = await runAgentTask({ model, workspace: new Workspace(dir), task: "What is in a.txt?", approve: async () => true, checks: [], plan: false });
    expect(outcome.status).toBe("error");
    expect(outcome.message).toMatch(/^Stopped: the model kept making the same call \(read_file\)/);
    expect(seen).toHaveLength(5);
    expect(seen[3]).toMatch(/^That is the third time in a row you made exactly the same call/);
  });

  it("throws away a reply that repeats itself and asks again", async () => {
    let calls = 0;
    const model: ChatModel = {
      id: "test",
      async complete() {
        return ++calls === 1 ? { content: "The answer is the answer.\n".repeat(40), toolCalls: [] } : { content: "It prints hello.", toolCalls: [] };
      },
    };
    const outcome = await runAgentTask({ model, workspace: new Workspace(dir), task: "What does it print?", approve: async () => true, checks: [], plan: false });
    expect(outcome).toMatchObject({ status: "done", message: "It prints hello." });
    expect(isRepetitive("A normal answer.\n".repeat(3))).toBe(false);
    expect(isRepetitive(`${"Here is a real explanation with different sentences. ".repeat(2)}\n- one\n- two\n- three\n${"x".repeat(10)} and more text that goes on for a while without repeating itself, covering setup, usage, caveats and next steps in ordinary prose so that it is long enough to be checked by the detector but clearly not a loop of any kind at all, really.`)).toBe(false);
  });

  it("cuts old tool output down once the conversation is long, keeping recent results whole", () => {
    const big = "x".repeat(30_000);
    const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "task" }];
    for (let i = 0; i < 12; i++) messages.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: `c${i}`, content: big });
    trimOldOutput(messages, 160_000, 4);
    const outputs = messages.filter((m) => m.role === "tool").map((m) => String(m.content).length);
    expect(outputs.slice(-4)).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(outputs[0]).toBeLessThan(700);
    expect(String(messages.find((m) => m.role === "tool")!.content)).toContain("more characters of this earlier result were dropped");
    expect(outputs.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(160_000);
  });

  it("uses the sampling the model's makers recommend, and strips reasoning that leaks into the answer", () => {
    expect(recommendedSampling("Qwen3.6-35B-A3B-4bit")).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20 });
    expect(recommendedSampling("llama3.3")).toBeUndefined();
    expect(cleanContent("<think>Let me see…</think>\nIt returns 4.")).toBe("It returns 4.");
    expect(cleanContent("still thinking about it</think>\n\nIt returns 4.")).toBe("It returns 4.");
  });

  it("offers no file-writing tools when the user asks a question and says not to change anything", async () => {
    expect(isReadOnlyRequest("Question only, don't change anything: compare FlatList and FlashList.")).toBe(true);
    expect(isReadOnlyRequest("Samo pitanje, ne mijenjaj ništa: šta radi ova funkcija?")).toBe(true);
    expect(isReadOnlyRequest("Explain this without changing the code")).toBe(true);
    expect(isReadOnlyRequest("Don't change the header, but add a footer")).toBe(false);
    expect(isReadOnlyRequest("Add a question-only mode to the quiz")).toBe(false);
    let offered: string[] = [];
    const model: ChatModel = {
      id: "test",
      async complete(req) {
        offered = (req.tools ?? []).map((t) => t.name);
        return { content: "FlashList recycles views.", toolCalls: [] };
      },
    };
    await runAgentTask({ model, workspace: new Workspace(dir), task: "Question only, don't change anything: compare FlatList and FlashList.", approve: async () => true, checks: [], plan: false });
    expect(offered).toContain("read_file");
    for (const name of ["create_file", "edit_file", "insert_lines", "design_kit", "app_kit"]) expect(offered).not.toContain(name);
  });
});

describe("design from a reference link", () => {
  it("builds a direction from what was measured on the reference, on the closest built-in layout", () => {
    const d = directionFromReference({ url: "https://www.example-studio.com/work", background: "#0b0b0f", text: "#f5f5f7", accent: "#7c5cff", fontDisplay: "Inter", fontBody: "Inter", radius: 14 })!;
    expect(d.name).toBe("In the style of example-studio.com");
    expect(d.tokens).toMatchObject({ "--paper": "#0b0b0f", "--ink": "#f5f5f7", "--accent": "#7c5cff", "--accent-ink": "#ffffff", "--radius": "14px" });
    expect(d.tokens["--font-display"]).toMatch(/^"Inter", /);
    expect(kitCss(d)).toContain("--accent: #7c5cff");
    // A light page with a serif headline sits on the editorial layout; unusable colours give nothing.
    expect(directionFromReference({ url: "https://bakery.example", background: "#fffaf0", text: "#2a1a10", accent: "#f2c14e", fontDisplay: "Playfair Display" })!.tokens["--accent-ink"]).toBe("#111111");
    expect(directionFromReference({ url: "https://x.example", background: "transparent", text: "#000000", accent: "#ff0000" })).toBeUndefined();
  });

  it("the page builder measures the user's link and says so; without web access it says that instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kovach-ref-"));
    const ctx = { workspace: new Workspace(dir), approve: async () => true, checks: [], limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 1000 }, createdThisRun: new Set<string>() } as never;
    const asked: string[] = [];
    const tool = designKitTool({ reference: async (url) => (asked.push(url), { url, background: "#101014", text: "#f2f2f2", accent: "#00c2a8", radius: 8 }) });
    const out = await tool.run(tool.schema.parse({ ...CONTENT, references: ["https://linear.app/"] }), ctx);
    expect(out.ok).toBe(true);
    expect(asked).toEqual(["https://linear.app/"]);
    expect(out.content).toContain('in the "In the style of linear.app" direction. Its colours, corners and fonts were measured on https://linear.app/');
    expect(readFileSync(join(dir, "styles.css"), "utf8")).toContain("--accent: #00c2a8");
    const offline = designKitTool();
    const dir2 = mkdtempSync(join(tmpdir(), "kovach-ref-"));
    const out2 = await offline.run(offline.schema.parse({ ...CONTENT, references: ["https://linear.app/"] }), { ...(ctx as object), workspace: new Workspace(dir2), createdThisRun: new Set<string>() } as never);
    expect(out2.content).toContain("The reference links were not opened: web access is off for this run.");
  });
});
