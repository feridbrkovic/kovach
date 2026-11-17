import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyEdits,
  clip,
  createOpenAiCompatibleModel,
  detectChecks,
  isSecretPath,
  ModelError,
  runCommand,
  toolSpecs,
  TOOLS,
  Workspace,
  WorkspaceError,
} from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-agent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

describe("strict edits", () => {
  const file = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";

  it("replaces a unique block", () => {
    const r = applyEdits(file, [{ old: "const b = 2;", new: "const b = 3;" }]);
    expect(r).toEqual({ ok: true, content: "const a = 1;\nconst b = 3;\nconst a2 = 1;\n", changedLines: 1, addedLines: 0 });
  });

  it("refuses missing, ambiguous, empty and no-op blocks with an actionable error", () => {
    const missing = applyEdits(file, [{ old: "const  b = 2;", new: "x" }]);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toMatch(/not found/);
    const ambiguous = applyEdits(file, [{ old: " = 1;", new: " = 9;" }]);
    // The model is told where the matches are, so it can widen "old" around the one it means.
    expect(!ambiguous.ok && ambiguous.error).toBe('"old" text appears 2 times (starting on lines 1, 3); include more surrounding lines so it matches only the place you mean, or use insert_lines with a line number to add new lines');
    expect(applyEdits(file, [{ old: "", new: "x" }]).ok).toBe(false);
    expect(applyEdits(file, [{ old: "const b = 2;", new: "const b = 2;" }]).ok).toBe(false);
  });

  it("applies all blocks or none", () => {
    const r = applyEdits(file, [
      { old: "const a = 1;", new: "const a = 5;" },
      { old: "does not exist", new: "x" },
    ]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^edit 2:/);
  });

  it("counts changed lines as the larger side of each block, and pure insertions as added lines", () => {
    const changed = applyEdits(file, [{ old: "const b = 2;", new: "const b = 20;\nconst c = 3;\nconst d = 4;" }]);
    expect(changed).toMatchObject({ ok: true, changedLines: 3, addedLines: 0 });
    // "old" kept whole at the start (after it) or the end (before it) of "new": nothing existing changes.
    const after = applyEdits(file, [{ old: "const b = 2;", new: "const b = 2;\nconst c = 3;\nconst d = 4;" }]);
    expect(after).toMatchObject({ ok: true, changedLines: 0, addedLines: 2 });
    const before = applyEdits(file, [{ old: "const a2 = 1;", new: "// header\nconst a2 = 1;" }]);
    expect(before).toMatchObject({ ok: true, changedLines: 0, addedLines: 1 });
    // Both kinds in one call add up separately.
    const mixed = applyEdits(file, [
      { old: "const a = 1;", new: "const a = 2;" },
      { old: "const b = 2;", new: "const b = 2;\n// more" },
    ]);
    expect(mixed).toMatchObject({ ok: true, changedLines: 1, addedLines: 1 });
  });
});

describe("workspace", () => {
  it("keeps paths inside the project and away from secrets", () => {
    write("src/a.ts", "x");
    write(".env", "SECRET=1");
    const ws = new Workspace(dir);
    expect(ws.readText("src/a.ts")).toBe("x");
    expect(() => ws.resolve("../outside.txt")).toThrow(WorkspaceError);
    expect(() => ws.resolve("/etc/passwd")).toThrow(/relative/);
    // Guessed paths from another OS or the home folder are refused, not turned into odd file names.
    expect(() => ws.resolve("C:\\Users\\User\\Desktop\\site\\index.html")).toThrow(/relative to the project root/);
    expect(() => ws.resolve("C:/Users/User/Desktop/index.html")).toThrow(/relative to the project root/);
    expect(() => ws.resolve("~/Desktop/site/index.html")).toThrow(/relative to the project root/);
    expect(() => ws.resolve("site\\index.html")).toThrow(/forward slashes/);
    expect(ws.rel(ws.resolve("site/index.html"))).toBe("site/index.html");
    expect(() => ws.readText(".env")).toThrow(/secrets/);
    expect(isSecretPath("config/.env.production")).toBe(true);
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath("certs/server.pem")).toBe(true);
  });

  it("refuses symlinks that point outside the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "kovach-outside-"));
    writeFileSync(join(outside, "x.txt"), "outside");
    symlinkSync(outside, join(dir, "link"));
    const ws = new Workspace(dir);
    expect(() => ws.readText("link/x.txt")).toThrow(/outside/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("lists files without dependencies, build output or secrets, and searches them", async () => {
    write("src/cart.ts", "export function total() {\n  return sum.toFixed(2);\n}\n");
    write("node_modules/x/index.js", "toFixed");
    write("dist/cart.js", "toFixed");
    write(".env.local", "toFixed");
    const ws = new Workspace(dir);
    expect(await ws.listFiles()).toEqual(["src/cart.ts"]);
    const hits = await ws.search("toFixed");
    expect(hits).toEqual([{ path: "src/cart.ts", line: 2, text: "  return sum.toFixed(2);" }]);
    expect(await ws.search("nothing-here")).toEqual([]);
    await expect(ws.search("(")).rejects.toThrow(/invalid regular expression/);
  });

  it("sees a project that an enclosing repository ignores, but keeps the project's own .gitignore", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    write(".gitignore", "playground/\n");
    write("playground/shop/src/cart.js", "export const total = (x) => x.toFixed(2);\n");
    write("playground/shop/.gitignore", "tmp/\n");
    write("playground/shop/tmp/scratch.js", "toFixed");
    const ws = new Workspace(join(dir, "playground/shop"));
    expect(await ws.listFiles()).toEqual([".gitignore", "src/cart.js"]);
    expect((await ws.search("toFixed")).map((h) => h.path)).toEqual(["src/cart.js"]);
  });

  it("reads binary and huge files as errors, not garbage", () => {
    writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0, 0, 1]));
    expect(() => new Workspace(dir).readText("img.png")).toThrow(/binary/);
  });
});

describe("check detection", () => {
  it("finds typecheck, lint and test scripts with the project's package manager", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" } }));
    write("pnpm-lock.yaml", "");
    expect(detectChecks(dir)).toEqual([
      { kind: "typecheck", command: "pnpm typecheck" },
      { kind: "lint", command: "pnpm lint" },
      { kind: "test", command: "pnpm test" },
    ]);
  });

  it("ignores the npm placeholder test and falls back to tsc when TypeScript is installed", () => {
    write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { typescript: "^5" } }));
    write("tsconfig.json", "{}");
    expect(detectChecks(dir)).toEqual([{ kind: "typecheck", command: "npx --no-install tsc --noEmit" }]);
  });

  it("finds PHP checks from composer and phpunit", () => {
    write("composer.json", JSON.stringify({ scripts: { phpstan: "phpstan analyse" } }));
    write("vendor/bin/phpunit", "#!/bin/sh");
    expect(detectChecks(dir)).toEqual([
      { kind: "typecheck", command: "composer phpstan" },
      { kind: "test", command: "vendor/bin/phpunit" },
    ]);
  });
});

describe("shell", () => {
  it("returns exit codes and combined output", async () => {
    const r = await runCommand("echo out; echo err 1>&2; exit 3", { cwd: dir });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.timedOut).toBe(false);
  });

  it("stops commands that run too long", async () => {
    const r = await runCommand("sleep 5", { cwd: dir, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.durationMs).toBeLessThan(4000);
  });

  it("clips long text keeping both ends", () => {
    const text = `START${"x".repeat(10_000)}END`;
    const c = clip(text, 200);
    expect(c.startsWith("START")).toBe(true);
    expect(c.endsWith("END")).toBe(true);
    expect(c.length).toBeLessThan(260);
  });
});

describe("tool specs", () => {
  it("are plain JSON schemas the model server can use", () => {
    const specs = toolSpecs();
    expect(specs.map((s) => s.name)).toEqual(["list_files", "read_file", "search", "edit_file", "create_file", "design_kit", "app_kit", "insert_lines", "run_command", "run_checks", "find_symbol", "find_references", "diagnostics"]);
    const edit = specs.find((s) => s.name === "edit_file")!;
    expect(edit.parameters).toMatchObject({ type: "object", required: ["path", "edits"] });
    expect(edit.parameters).not.toHaveProperty("$schema");
  });
});

describe("OpenAI-compatible model client", () => {
  let server: Server;
  let base: string;
  let lastBody: Record<string, unknown> = {};
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastBody = JSON.parse(data);
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends tools and messages in the OpenAI shape and parses tool calls", async () => {
    reply = {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
                { id: "c2", type: "function", function: { name: "search", arguments: { pattern: "x" } } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 18 },
      },
    };
    const model = createOpenAiCompatibleModel({ baseUrl: `${base}/`, model: "qwen" });
    const res = await model.complete({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "list_files", arguments: "{}" }] },
        { role: "tool", toolCallId: "c0", content: "a.ts" },
      ],
      tools: toolSpecs().slice(0, 1),
    });
    expect(lastBody.model).toBe("qwen");
    expect(lastBody.tool_choice).toBe("auto");
    expect((lastBody.messages as unknown[])[3]).toEqual({ role: "tool", tool_call_id: "c0", content: "a.ts" });
    expect((lastBody.messages as { tool_calls?: unknown[] }[])[2]!.tool_calls).toHaveLength(1);
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { id: "c2", name: "search", arguments: '{"pattern":"x"}' },
    ]);
    expect(res.content).toBe("");
    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 18 });
  });

  it("asks for structured output with a JSON schema", async () => {
    reply = { status: 200, body: { choices: [{ message: { content: '{"ok":true}' } }] } };
    const model = createOpenAiCompatibleModel({ baseUrl: base, model: "qwen" });
    await model.complete({ messages: [{ role: "user", content: "x" }], jsonSchema: { name: "plan", schema: { type: "object" } } });
    expect(lastBody.response_format).toEqual({ type: "json_schema", json_schema: { name: "plan", schema: { type: "object" }, strict: true } });
  });

  it("turns server and network failures into clear ModelErrors", async () => {
    reply = { status: 500, body: "model not loaded" };
    const model = createOpenAiCompatibleModel({ baseUrl: base, model: "qwen" });
    await expect(model.complete({ messages: [] })).rejects.toThrow(/500: model not loaded/);
    const offline = createOpenAiCompatibleModel({ baseUrl: "http://127.0.0.1:9/v1", model: "qwen" });
    await expect(offline.complete({ messages: [] })).rejects.toBeInstanceOf(ModelError);
    await expect(offline.complete({ messages: [] })).rejects.toThrow(/unreachable/);
  });
});

describe("web", () => {
  it("parses DuckDuckGo HTML results and unwraps redirect links", async () => {
    const { parseDuckDuckGo, isPrivateHost, htmlToText } = await import("../src/web.js");
    const html =
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnode.org%2Fdocs&amp;rut=x">Node <b>docs</b></a>' +
      '<a class="result__snippet" href="x">The official <b>docs</b>.</a>';
    const hits = parseDuckDuckGo(html);
    expect(hits[0]).toMatchObject({ title: "Node docs", url: "https://node.org/docs", snippet: "The official docs." });
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.5")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(htmlToText("<h1>Hi</h1><p>one<br>two</p>")).toBe("Hi\none\ntwo");
  });

  it("refuses to fetch a private address", async () => {
    const { webFetch } = await import("../src/web.js");
    await expect(webFetch("http://localhost:8000/x")).rejects.toThrow(/local or private/);
    await expect(webFetch("ftp://example.com")).rejects.toThrow(/http/);
  });
});

describe("check output for the model", () => {
  it("keeps the failing test and the summary from long output", async () => {
    const { focusClip } = await import("../src/shell.js");
    const passing = Array.from({ length: 300 }, (_, i) => `ok ${i + 1} - test number ${i + 1} passes fine`).join("\n");
    const out = `${passing}\nnot ok 301 - 17% VAT on 200 is 234\n  error: |-\n    Expected values to be strictly equal:\n    217 !== 234\n${passing}\n# tests 601\n# fail 1`;
    const focused = focusClip(out, 4000);
    expect(focused.length).toBeLessThanOrEqual(4000);
    expect(focused).toContain("not ok 301 - 17% VAT on 200 is 234");
    expect(focused).toContain("217 !== 234");
    expect(focused).toContain("# fail 1");
    expect(focused).toMatch(/lines omitted/);
    expect(focusClip("short", 4000)).toBe("short");
  });
});

describe("computer use", () => {
  type Calls = { op: string; args: unknown[] }[];
  const fakeDriver = (calls: Calls, extra: Record<string, unknown> = {}) => ({
    // A Retina display: 1512x982 points, so screenshots are bigger, but clicks use points.
    screenSize: async () => ({ width: 1512, height: 982 }),
    screenshot: async () => ({ type: "image" as const, mediaType: "image/jpeg" as const, data: "/9j/" }),
    click: async (...args: unknown[]) => void calls.push({ op: "click", args }),
    move: async () => {},
    drag: async (...args: unknown[]) => void calls.push({ op: "drag", args }),
    type: async (...args: unknown[]) => void calls.push({ op: "type", args }),
    key: async () => {},
    scroll: async () => {},
    ...extra,
  });
  const ctxWith = (approve: (r: { command?: string }) => boolean, seen: string[] = []) =>
    ({
      workspace: { root: "/tmp" },
      approve: async (r: { command?: string }) => {
        seen.push(r.command ?? "");
        return approve(r);
      },
    }) as unknown as import("../src/tools.js").ToolContext;
  const tool = async (driver: object, name: string) => {
    const { computerTools } = await import("../src/computer.js");
    const t = computerTools(driver as never).find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  it("maps 0-1000 coordinates onto screen points and approves every action", async () => {
    const calls: Calls = [];
    const click = await tool(fakeDriver(calls), "computer_click");
    const out = await click.run({ x: 500, y: 250, button: "left", count: 1 }, ctxWith(() => true));
    expect(calls[0]).toEqual({ op: "click", args: [756, 246, "left", 1] });
    expect(out.images?.[0]?.mediaType).toBe("image/jpeg");
    expect((await click.run({ x: 1, y: 1, button: "left", count: 1 }, ctxWith(() => false))).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  const snapshot = {
    app: "Calculator",
    window: "Calculator",
    elements: [
      { role: "AXGroup", name: null, description: null, x: 100, y: 100, w: 300, h: 400 },
      { role: "AXButton", name: null, description: "seven", x: 110, y: 300, w: 50, h: 40, enabled: true },
      { role: "AXButton", name: null, description: "seven", x: 110, y: 300, w: 50, h: 40, enabled: true },
      { role: "AXStaticText", name: null, description: null, value: "0", x: 110, y: 120, w: 280, h: 60 },
      { role: "AXButton", name: "Off screen", x: 4000, y: 10, w: 40, h: 20 },
      { role: "AXButton", name: "Clear", x: 170, y: 300, w: 50, h: 40, enabled: false },
      { role: "AXTextField", name: null, x: 10, y: 10, w: 0, h: 0 },
    ],
  };

  it("lists the frontmost window's controls with ids, dropping noise, duplicates and off-screen items", async () => {
    const { uiItems, formatUi } = await import("../src/computer.js");
    const items = uiItems(snapshot, { width: 1512, height: 982 });
    expect(items.map((i) => [i.id, i.role, i.label])).toEqual([
      [1, "button", "seven"],
      [2, "static text", "0"],
      [3, "button", "Clear"],
    ]);
    expect(items[0]).toMatchObject({ cx: 89, cy: 326, px: 135, py: 320 });
    const text = formatUi(snapshot, items, false);
    expect(text).toContain('Calculator — "Calculator": 3 elements.');
    expect(text).toContain('[1] button "seven" at 89,326');
    expect(text).toContain('[3] button "Clear" at 129,326 (disabled)');
  });

  it("clicks an element by id at its centre, and refuses stale ids after the screen changes", async () => {
    const calls: Calls = [];
    const driver = fakeDriver(calls, { readUi: async () => snapshot });
    const { computerTools } = await import("../src/computer.js");
    const tools = computerTools(driver as never);
    const read = tools.find((t) => t.name === "computer_read_screen")!;
    const click = tools.find((t) => t.name === "computer_click")!;
    const seen: string[] = [];
    const ctx = ctxWith(() => true, seen);
    expect((await read.run({}, ctx)).content).toContain("[1] button");
    expect((await click.run({ element: 1, button: "left", count: 1 }, ctx)).ok).toBe(true);
    expect(calls[0]).toEqual({ op: "click", args: [135, 320, "left", 1] });
    expect(seen[0]).toBe('click button "seven"');
    const stale = await click.run({ element: 1, button: "left", count: 1 }, ctx);
    expect(stale.ok).toBe(false);
    expect(stale.content).toMatch(/read_screen again/);
    expect(click.schema.safeParse({ button: "left", count: 1 }).success).toBe(false);
  });

  it("falls back to screenshots when the controls can't be read", async () => {
    const read = await tool(fakeDriver([], { readUi: async () => Promise.reject(new Error("not allowed assistive access")) }), "computer_read_screen");
    const out = await read.run({}, ctxWith(() => true));
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/computer_screenshot/);
    const none = await tool(fakeDriver([]), "computer_read_screen");
    expect((await none.run({}, ctxWith(() => true))).content).toMatch(/isn't available/);
  });

  it("drags and opens apps only with approval, and rejects odd app names", async () => {
    const calls: Calls = [];
    const opened: string[] = [];
    const driver = fakeDriver(calls, { openApp: async (n: string) => void opened.push(n) });
    const drag = await tool(driver, "computer_drag");
    await drag.run({ fromX: 0, fromY: 0, toX: 1000, toY: 1000 }, ctxWith(() => true));
    expect(calls[0]).toEqual({ op: "drag", args: [0, 0, 1512, 982] });
    const open = await tool(driver, "computer_open_app");
    expect((await open.run({ name: "Calculator" }, ctxWith(() => true))).ok).toBe(true);
    expect((await open.run({ name: "Notes" }, ctxWith(() => false))).ok).toBe(false);
    expect((await open.run({ name: "x; rm -rf ~" }, ctxWith(() => true))).ok).toBe(false);
    expect(opened).toEqual(["Calculator"]);
  });

  it("gives the model a JSON schema for every tool", async () => {
    const { computerTools } = await import("../src/computer.js");
    const { z } = await import("zod");
    for (const t of computerTools(fakeDriver([], { openApp: async () => {} }) as never)) {
      const js = z.toJSONSchema(t.schema) as { type?: string; properties?: Record<string, unknown> };
      expect(js.type).toBe("object");
    }
    const click = computerTools(fakeDriver([]) as never).find((t) => t.name === "computer_click")!;
    expect(Object.keys((z.toJSONSchema(click.schema) as { properties: object }).properties)).toEqual(
      expect.arrayContaining(["element", "x", "y"]),
    );
  });

  it("builds System Events key presses", async () => {
    const { systemEventsKey } = await import("../src/computer.js");
    expect(systemEventsKey("cmd+shift+t")).toBe('tell application "System Events" to keystroke "t" using {command down, shift down}');
    expect(systemEventsKey("Return")).toBe('tell application "System Events" to key code 36');
    expect(systemEventsKey("escape")).toBe('tell application "System Events" to key code 53');
  });
});

describe("image generation", () => {
  it("generates into the project, refuses non-png and non-approval", async () => {
    const { imageTools } = await import("../src/media.js");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const provider = { generateImage: async () => png };
    const gen = imageTools(provider)[0]!;
    const ws = new Workspace(dir);
    const ctx = { workspace: ws, approve: async () => true } as unknown as import("../src/tools.js").ToolContext;
    const ok = await gen.run({ prompt: "a cat", path: "assets/cat.png", width: 1000, height: 1000, steps: 4 }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.files?.[0]).toMatch(/assets\/cat\.png$/);
    expect(ok.images?.[0]?.mediaType).toBe("image/png");
    const bad = await gen.run({ prompt: "x", path: "a.jpg", width: 512, height: 512, steps: 4 }, ctx);
    expect(bad.ok).toBe(false);
    const denied = { workspace: ws, approve: async () => false } as unknown as import("../src/tools.js").ToolContext;
    expect((await gen.run({ prompt: "x", path: "b.png", width: 512, height: 512, steps: 4 }, denied)).ok).toBe(false);
  });
});

describe("image parts on the wire", () => {
  it("sends images as data URLs in OpenAI image_url parts", async () => {
    let sent: { messages: { content: unknown }[] } | undefined;
    const model = createOpenAiCompatibleModel({
      baseUrl: "http://x/v1",
      model: "qwen",
      fetch: async (_u, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      },
    });
    await model.complete({
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "AAAA" }] }],
    });
    expect(sent!.messages[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("insert_lines", () => {
  const tool = TOOLS.find((t) => t.name === "insert_lines")!;
  const ctxFor = (root: string) => ({ workspace: new Workspace(root), approve: async () => true, checks: [], limits: { editLines: 150, newFileLines: 5, commandTimeoutMs: 1000 } });

  it("inserts after a line number, at the start, or at the end, and shows where it landed", async () => {
    const root = mkdtempSync(join(tmpdir(), "kovach-ins-"));
    writeFileSync(join(root, "page.html"), "<main>\n  <section>a</section>\n</main>\n");
    const ctx = ctxFor(root);
    const r = await tool.run({ path: "page.html", afterLine: 2, content: "  <section>b</section>\n  <section>c</section>" } as never, ctx as never);
    expect(r).toMatchObject({ ok: true, edited: true, change: { path: "page.html", before: "<main>\n  <section>a</section>\n</main>\n" } });
    expect(r.content).toBe("Inserted 2 lines into page.html after line 2:\n    2    <section>a</section>\n    3    <section>b</section>\n    4    <section>c</section>\n    5  </main>");
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe("<main>\n  <section>a</section>\n  <section>b</section>\n  <section>c</section>\n</main>\n");
    await tool.run({ path: "page.html", afterLine: 0, content: "<!doctype html>" } as never, ctx as never);
    await tool.run({ path: "page.html", afterLine: 6, content: "<!-- end -->" } as never, ctx as never);
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe("<!doctype html>\n<main>\n  <section>a</section>\n  <section>b</section>\n  <section>c</section>\n</main>\n<!-- end -->\n");
  });

  it("refuses a line past the end and content over the new-content limit, leaving the file alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "kovach-ins-"));
    writeFileSync(join(root, "a.txt"), "one\ntwo");
    const ctx = ctxFor(root);
    expect((await tool.run({ path: "a.txt", afterLine: 4, content: "x" } as never, ctx as never)).content).toBe("a.txt has 2 lines; afterLine must be 0–2 (2 appends at the end).");
    expect((await tool.run({ path: "a.txt", afterLine: 2, content: "1\n2\n3\n4\n5\n6" } as never, ctx as never)).content).toMatch(/^Not inserted: 6 lines is over the 5-line limit/);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo");
    // A file without a final newline: appending after its last line.
    await tool.run({ path: "a.txt", afterLine: 2, content: "three" } as never, ctx as never);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\nthree");
  });

  it("agrees with read_file and create_file on a file's line count, and treats one past the end as append", async () => {
    const root = mkdtempSync(join(tmpdir(), "kovach-ins-"));
    const ctx = { ...ctxFor(root), limits: { editLines: 150, newFileLines: 3, commandTimeoutMs: 1000 } };
    const create = TOOLS.find((t) => t.name === "create_file")!;
    const read = TOOLS.find((t) => t.name === "read_file")!;
    // Three lines and a final newline is three lines, not four.
    expect(await create.run({ path: "p.html", content: "<a>\n<b>\n</a>\n" } as never, ctx as never)).toMatchObject({ ok: true, content: "Created p.html (3 lines)." });
    const shown = (await read.run({ path: "p.html" } as never, ctx as never)).content;
    expect(shown).toBe("    1| <a>\n    2| <b>\n    3| </a>");
    // Aiming at the empty "line 4" a model might still have from older output appends.
    await tool.run({ path: "p.html", afterLine: 4, content: "<c>" } as never, ctx as never);
    expect(readFileSync(join(root, "p.html"), "utf8")).toBe("<a>\n<b>\n</a>\n<c>\n");
    // Over the step size: created with a note up to twice the target, refused beyond that.
    const big = await create.run({ path: "big.txt", content: "1\n2\n3\n4\n5\n" } as never, ctx as never);
    expect(big).toMatchObject({ ok: true, content: "Created big.txt (5 lines). That is over the 3-line step size: check it with diagnostics before going on, and keep the next steps smaller." });
    const huge = await create.run({ path: "huge.txt", content: Array.from({ length: 16 }, (_, i) => i).join("\n") } as never, ctx as never);
    expect(huge).toMatchObject({ ok: false, content: "Not created: 16 lines is over the 15-line limit for one step (aim for 3). Create the first part, then add the rest with insert_lines after the file's last line." });
    expect(existsSync(join(root, "huge.txt"))).toBe(false);
    // A file this run created can be replaced whole; one that was already there can't.
    const mine = { ...ctx, createdThisRun: new Set<string>() };
    await create.run({ path: "page.html", content: "<a>\n" } as never, mine as never);
    const again = await create.run({ path: "page.html", content: "<b>\n" } as never, mine as never);
    expect(again).toMatchObject({ ok: true, content: "Replaced page.html (1 lines).", change: { path: "page.html", before: "<a>\n" } });
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe("<b>\n");
    expect(await create.run({ path: "p.html", content: "x" } as never, mine as never)).toMatchObject({
      ok: false,
      content: `p.html already exists and wasn't created in this task, so it can't be replaced whole. Change it with edit_file (small "old" blocks) or add to it with insert_lines.`,
    });
    writeFileSync(join(root, "empty.txt"), "");
    expect(await read.run({ path: "empty.txt" } as never, ctx as never)).toMatchObject({ ok: true, content: "empty.txt is empty." });
  });
});
