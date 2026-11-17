import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModel, ChatRequest, ChatResponse } from "@kovach-dev/agent";
import { MemoryApiError } from "@kovach-dev/memory-contract";
import { BlobStore, createHistoryStore, createMemoryStore, type Db, type HistoryStore, migrate, openDatabase } from "@kovach-dev/memory-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, createFileSettingsStore, folderName, SCRATCH_PLACE_NOTE, type SettingsStore, titleFrom } from "../src/main/agent-service";
import { MIGRATIONS } from "../src/main/migrations";
import { fakeDocsFetcher, RN_REPO } from "../../../packages/memory-service/test/helpers/fake-docs";
import { type AgentStatusEvent, type ApprovalPrompt, DEFAULT_SETTINGS, describeActivity, matchModel } from "../src/shared/agent";

const CART = "export function total(items) {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum.toFixed(2);\n}\n";
const CHECK = `import { readFileSync } from "node:fs";
if (readFileSync("src/cart.js", "utf8").includes("toFixed")) { console.error("TS2322"); process.exit(2); }
`;

let root: string;
let project: string;
let db: Db;
let history: HistoryStore;
let settings: SettingsStore;
let statuses: AgentStatusEvent[];
let approvals: ApprovalPrompt[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kovach-svc-"));
  project = join(root, "shop");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/cart.js"), CART);
  writeFileSync(join(project, "check.mjs"), CHECK);
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module", scripts: { typecheck: "node check.mjs" } }));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS);
  history = createHistoryStore(db, { blobs: new BlobStore(join(root, "data")) });
  settings = createFileSettingsStore(join(root, "data", "settings.json"));
  statuses = [];
  approvals = [];
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const call = (name: string, args: unknown): ChatResponse => ({ content: "", toolCalls: [{ id: `c${++n}`, name, arguments: JSON.stringify(args) }] });
const say = (content: string): ChatResponse => ({ content, toolCalls: [] });

function scripted(steps: ChatResponse[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "scripted",
    requests,
    async complete(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const s = steps.shift();
      if (!s) throw new Error("script ran out");
      return s;
    },
  };
}

function service(model: ChatModel, extra: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) {
  return new AgentService({
    history,
    settings,
    send: { status: (e) => statuses.push(e), approval: (p) => approvals.push(p) },
    pickFolder: async () => project,
    createModel: () => model,
    runOptions: { plan: false },
    scratchDir: join(root, "data", "scratch"),
    attachmentsDir: join(root, "data", "attachments"),
    ...extra,
  });
}

const finished = () => vi.waitFor(() => {
  const f = statuses.find((s) => s.type === "finished");
  if (!f) throw new Error("not finished");
  return f as Extract<AgentStatusEvent, { type: "finished" }>;
});

describe("settings", () => {
  it("defaults, validates and persists", async () => {
    const svc = service(scripted([]));
    expect(await svc.getSettings()).toEqual({ ...DEFAULT_SETTINGS, hasApiKey: false });
    await expect(svc.saveSettings({ modelBaseUrl: "not a url", model: "q" })).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.saveSettings({ modelBaseUrl: "ftp://x", model: "q" })).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.saveSettings({ modelBaseUrl: "http://127.0.0.1:11434/v1", model: " " })).rejects.toMatchObject({ code: "invalid" });
    await svc.saveSettings({ modelBaseUrl: "http://127.0.0.1:11434/v1/", model: "qwen3.6" });
    const reloaded = createFileSettingsStore(join(root, "data", "settings.json"));
    expect(reloaded.get()).toEqual({ ...DEFAULT_SETTINGS, modelBaseUrl: "http://127.0.0.1:11434/v1", model: "qwen3.6" });
  });

  it("saves the user's standards, refuses secrets and overlong text, and gives them to the planner", async () => {
    const model = scripted([say(JSON.stringify({ summary: "Answer", steps: [{ title: "Answer", files: [] }] })), say("Nothing to change.")]);
    const svc = service(model, { runOptions: {} });
    expect((await svc.saveSettings({ standards: "  - Mobile first\r\n- No jQuery  " })).standards).toBe("- Mobile first\n- No jQuery");
    await expect(svc.saveSettings({ standards: "x".repeat(6001) })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/up to 6,000 characters; this is 6,001/) });
    await expect(svc.saveSettings({ standards: "Deploy with AKIAABCDEFGHIJKLMNOP" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/looks like a key or password/) });
    expect((await svc.getSettings()).standards).toBe("- Mobile first\n- No jQuery");
    // Other settings saved later leave them alone.
    expect((await svc.saveSettings({ webSearch: false })).standards).toBe("- Mobile first\n- No jQuery");

    await svc.start({ text: "What is in this folder?" });
    await finished();
    expect(String(model.requests[0]!.messages.at(-1)!.content)).toContain("The user's own standards (these come first; follow them where they apply):\n- Mobile first\n- No jQuery");
  });

  it("shows settings without decrypting the saved key; the first model call decrypts it once", async () => {
    let decrypts = 0;
    const codec = { encrypt: (p: string) => `enc:${p}`, decrypt: (e: string) => (decrypts++, e.slice(4)) };
    const file = join(root, "data", "settings.json");
    createFileSettingsStore(file, codec).set({ ...DEFAULT_SETTINGS, apiKey: "sk-test" });
    // A fresh start: the key is on disk only.
    settings = createFileSettingsStore(file, codec);
    const svc = service(scripted([]));
    expect(await svc.getSettings()).toMatchObject({ hasApiKey: true });
    expect(await svc.getSettings()).not.toHaveProperty("apiKey");
    expect(decrypts).toBe(0);
    expect(settings.get().apiKey).toBe("sk-test");
    expect(settings.get().apiKey).toBe("sk-test");
    expect(decrypts).toBe(1);
  });

  it("keeps the API key encrypted on disk and out of the window", async () => {
    const codec = { encrypt: (p: string) => `enc:${Buffer.from(p).toString("base64")}`, decrypt: (e: string) => Buffer.from(e.slice(4), "base64").toString() };
    const file = join(root, "data", "settings.json");
    settings = createFileSettingsStore(file, codec);
    const svc = service(scripted([]));
    const saved = await svc.saveSettings({ ...DEFAULT_SETTINGS, apiKey: " sk-omlx-test123 " });
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, hasApiKey: true });
    expect(JSON.stringify(saved)).not.toContain("sk-omlx");
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("sk-omlx-test123");
    expect(onDisk).toContain("apiKeyEncrypted");
    expect(createFileSettingsStore(file, codec).get().apiKey).toBe("sk-omlx-test123");

    // Omitting the key keeps it; "" removes it; spaces are refused.
    await svc.saveSettings({ ...DEFAULT_SETTINGS, model: "other" });
    expect(settings.get().apiKey).toBe("sk-omlx-test123");
    await expect(svc.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "a b" })).rejects.toMatchObject({ code: "invalid" });
    expect((await svc.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "" })).hasApiKey).toBe(false);
    expect(readFileSync(file, "utf8")).not.toContain("apiKeyEncrypted");

    // Without a way to encrypt, a key is refused rather than written in plain text.
    settings = createFileSettingsStore(join(root, "data", "plain.json"));
    await expect(service(scripted([])).saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-x" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("sends the API key to the model server and explains a refusal", async () => {
    const codec = { encrypt: (p: string) => p, decrypt: (e: string) => e };
    settings = createFileSettingsStore(join(root, "data", "settings.json"), codec);
    let auth: string | null = null;
    const svc = service(scripted([]), {
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization");
        return new Response("{}", { status: auth === "Bearer sk-good" ? 200 : 401 });
      },
    });
    expect((await svc.checkModel()).message).toMatch(/needs an API key/);
    await svc.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-bad" });
    expect((await svc.checkModel()).message).toMatch(/refused the API key/);
    await svc.saveSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-good" });
    expect((await svc.checkModel()).ok).toBe(true);
    expect(auth).toBe("Bearer sk-good");
  });

  it("checks the model server and says what is wrong", async () => {
    const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
    const ok = service(scripted([]), { fetch: reply({ data: [{ id: DEFAULT_SETTINGS.model }, { id: "embeddinggemma" }] }) });
    expect(await ok.checkModel()).toMatchObject({ ok: true, models: [DEFAULT_SETTINGS.model, "embeddinggemma"] });
    const missing = service(scripted([]), { fetch: reply({ data: [{ id: "llama" }] }) });
    expect(await missing.checkModel()).toMatchObject({ ok: false, models: ["llama"], message: expect.stringContaining(`no model called "${DEFAULT_SETTINGS.model}"`) });
    const down = service(scripted([]), {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await down.checkModel()).toMatchObject({ ok: false, message: expect.stringMatching(/Is oMLX running/) });
  });

  it("adopts the server's spelling of the model name", async () => {
    const reply = async () => new Response(JSON.stringify({ data: [{ id: "mlx-community/Qwen3.6-35B-A3B-4bit" }] }));
    await service(scripted([]), { fetch: reply }).saveSettings({ ...DEFAULT_SETTINGS, model: "qwen3.6-35b-a3b-4bit" });
    const result = await service(scripted([]), { fetch: reply }).checkModel();
    expect(result).toMatchObject({ ok: true, model: "mlx-community/Qwen3.6-35B-A3B-4bit" });
    expect(settings.get().model).toBe("mlx-community/Qwen3.6-35B-A3B-4bit");
    expect((await service(scripted([]), { fetch: reply }).checkModel()).model).toBeUndefined();
  });
});

describe("matchModel", () => {
  it("ignores case and the organisation prefix, and refuses to guess", () => {
    expect(matchModel("Qwen3.6-35B-A3B-4bit", ["mlx-community/Qwen3.6-35B-A3B-4bit"])).toBe("mlx-community/Qwen3.6-35B-A3B-4bit");
    expect(matchModel("mlx-community/qwen3.6-35b-a3b-4bit", ["Qwen3.6-35B-A3B-4bit"])).toBe("Qwen3.6-35B-A3B-4bit");
    expect(matchModel("x", ["x", "X"])).toBe("x");
    expect(matchModel("q", ["a/Q", "b/q"])).toBeUndefined();
    expect(matchModel("qwen3.6", ["Qwen3.6-35B-A3B-4bit"])).toBeUndefined();
  });
});

describe("projects", () => {
  it("adds a folder once and lists it", async () => {
    const svc = service(scripted([]));
    const p = await svc.addProject();
    expect(p).toMatchObject({ name: "shop", path: project });
    expect((await svc.addProject())!.id).toBe(p!.id);
    expect(await svc.listProjects()).toEqual([p]);
    expect(await service(scripted([]), { pickFolder: async () => undefined }).addProject()).toBeUndefined();
  });
});

describe("runs", () => {
  it("runs a task in a new session: approvals go to the UI, everything lands in history", async () => {
    const model = scripted([
      call("edit_file", { path: "src/cart.js", edits: [{ old: "  return sum.toFixed(2);", new: "  return Math.round(sum * 100) / 100;" }] }),
      call("run_checks", {}),
      say("Fixed total()."),
      say('{"issues": []}'), // the review before finishing finds nothing
    ]);
    const svc = service(model);
    const p = (await svc.addProject())!;
    const ref = await svc.start({ projectId: p.id, text: "Fix the typecheck error in src/cart.js" });
    expect(await svc.activeRun()).toEqual(ref);

    // The check asks for approval; allow it for the rest of the session.
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ kind: "check", command: "npm run typecheck", sessionId: ref.sessionId });
    await svc.respond(approvals[0]!.requestId, "allow_session");

    const f = await finished();
    expect(f).toMatchObject({ status: "done", message: "Fixed total()." });
    expect(readFileSync(join(project, "src/cart.js"), "utf8")).toContain("Math.round");
    expect(await svc.activeRun()).toBeUndefined();

    const types = statuses.map((s) => (s.type === "activity" ? `activity:${s.text}` : s.type));
    expect(types).toEqual([
      "started",
      "activity:Thinking",
      "activity:Editing src/cart.js",
      "activity:Thinking",
      "activity:Running checks",
      "checks",
      "activity:Thinking",
      "activity:Reviewing the change",
      "finished",
    ]);

    const detail = await history.getSession(ref.sessionId);
    expect(detail.session).toMatchObject({ title: "Fix the typecheck error in src/cart.js", projectId: p.id, status: "done", model: DEFAULT_SETTINGS.model });
    expect(detail.messages.items[0]).toMatchObject({ role: "user", content: "Fix the typecheck error in src/cart.js" });
  });

  it("resumes a session with its earlier turns and remembers 'allow for this session'", async () => {
    const first = scripted([call("run_checks", {}), say("Checks run.")]);
    const second = scripted([call("run_checks", {}), say("Again.")]);
    const models = [first, second];
    const svc = service(first, { createModel: () => models.shift()! });
    const p = (await svc.addProject())!;
    const ref = await svc.start({ projectId: p.id, text: "Run the checks" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await svc.respond(approvals[0]!.requestId, "allow_session");
    await finished();

    // Same session again: the check is already allowed, so no new prompt.
    statuses = [];
    await svc.start({ sessionId: ref.sessionId, text: "Run them again" });
    await finished();
    expect(approvals).toHaveLength(1);

    // The model saw the earlier user and assistant turns before the new task.
    const sent = second.requests[0]!.messages.map((m) => `${m.role}:${"content" in m ? m.content : ""}`);
    expect(sent.slice(1)).toEqual(["user:Run the checks", "assistant:Checks run.", "user:Run them again"]);
  });

  it("stops a run that is waiting for approval", async () => {
    const svc = service(scripted([call("run_command", { command: "pnpm build" }), say("never")]));
    const p = (await svc.addProject())!;
    const ref = await svc.start({ projectId: p.id, text: "Build it" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await svc.stop(ref.runId);
    const f = await finished();
    expect(f.status).toBe("aborted");
    await expect(svc.respond(approvals[0]!.requestId, "allow")).rejects.toMatchObject({ code: "not_found" });
  });

  it("runs one task at a time and refuses bad input with clear errors", async () => {
    const svc = service(scripted([call("run_command", { command: "sleep 1" }), say("x")]));
    const p = (await svc.addProject())!;
    await expect(svc.start({ projectId: p.id, text: "  " })).rejects.toMatchObject({ code: "invalid" });

    const ref = await svc.start({ projectId: p.id, text: "first" });
    const second = svc.start({ projectId: p.id, text: "second" });
    await expect(second).rejects.toBeInstanceOf(MemoryApiError);
    await expect(second).rejects.toMatchObject({ code: "conflict" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await svc.respond(approvals[0]!.requestId, "deny");
    await finished();
    expect(ref.sessionId).toBeTruthy();
  });

  it("reports a model server that is down as a finished error", async () => {
    const down: ChatModel = {
      id: "down",
      complete: async () => {
        throw new Error("model server unreachable at http://127.0.0.1:8000/v1");
      },
    };
    const svc = service(down);
    const p = (await svc.addProject())!;
    await svc.start({ projectId: p.id, text: "hi" });
    expect(await finished()).toMatchObject({ status: "error", message: expect.stringContaining("unreachable") });
  });
});

describe("capability settings", () => {
  it("saves new switches, keeps unsent fields, and reads old files with defaults", async () => {
    const file = join(root, "data", "settings.json");
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(file, JSON.stringify({ modelBaseUrl: "http://127.0.0.1:8000/v1", model: "old" }));
    settings = createFileSettingsStore(file);
    const svc = service(scripted([]));
    expect(await svc.getSettings()).toEqual({ ...DEFAULT_SETTINGS, model: "old", hasApiKey: false });
    await svc.saveSettings({ webSearch: false, searxngUrl: "http://127.0.0.1:8888/", computerUse: true });
    const again = createFileSettingsStore(file).get();
    expect(again).toMatchObject({ model: "old", webSearch: false, searxngUrl: "http://127.0.0.1:8888", computerUse: true });
    await expect(svc.saveSettings({ searxngUrl: "searx" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("sessions without a project", () => {
  it("works in a private scratch folder and resumes there", async () => {
    const svc = service(scripted([call("create_file", { path: "notes.md", content: "hi\n" }), say("Saved notes.md."), say('{"issues": []}'), say("Still here.")]));
    const ref = await svc.start({ text: "Write a note" });
    expect((await finished()).status).toBe("done");
    const scratch = join(root, "data", "scratch", ref.sessionId);
    expect(readFileSync(join(scratch, "notes.md"), "utf8")).toBe("hi\n");
    expect((await history.getSession(ref.sessionId)).session.projectId).toBeUndefined();

    statuses.length = 0;
    await svc.start({ sessionId: ref.sessionId, text: "Anything else?" });
    expect((await finished()).status).toBe("done");
  });

  it("lists a session's files, shows them, and saves them to a new folder where the user chooses, overwriting nothing", async () => {
    const shown: string[] = [];
    const dest = join(root, "Desktop");
    mkdirSync(dest, { recursive: true });
    const titles: (string | undefined)[] = [];
    const svc = service(scripted([call("create_file", { path: "site/index.html", content: "<h1>SEO</h1>\n" }), say("Created it."), say('{"issues": []}')]), {
      showFolder: async (p) => void shown.push(p),
      pickFolder: async (title) => (titles.push(title), dest),
    });
    const ref = await svc.start({ text: "SEO landing page: build it!" });
    await finished();
    expect(await svc.sessionFiles(ref.sessionId)).toEqual({ count: 1, names: ["site/index.html"], page: "site/index.html" });
    await svc.showSessionFiles(ref.sessionId);
    expect(shown).toEqual([join(root, "data", "scratch", ref.sessionId)]);

    expect(await svc.saveSessionFiles(ref.sessionId)).toEqual({ path: join(dest, "seo-landing-page"), copied: 1 });
    expect(titles).toEqual(["Choose where to save the files"]);
    expect(readFileSync(join(dest, "seo-landing-page", "site", "index.html"), "utf8")).toBe("<h1>SEO</h1>\n");
    // Saving again makes a second folder rather than writing over the first.
    expect((await svc.saveSessionFiles(ref.sessionId))!.path).toBe(join(dest, "seo-landing-page 2"));
    expect(folderName("  ")).toBe("local-kovach-files");
    expect(folderName("create a new folder on desktop and in it a simple but yet immersive landing page")).toBe("immersive-landing-page");
    expect(folderName("Make it")).toBe("make-it");

    // A project session has no private folder; cancelling the picker saves nothing.
    const cancelled = service(scripted([]), { pickFolder: async () => undefined });
    expect(await cancelled.saveSessionFiles(ref.sessionId)).toBeUndefined();
    const inProject = history.createSession({ projectId: history.ensureProject({ path: project, name: "shop" }), title: "x" });
    expect(await svc.sessionFiles(inProject.id)).toEqual({ count: 0, names: [] });
    await expect(svc.saveSessionFiles(inProject.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("names a new session after the task, shows writing progress, looks at a built page and opens it", async () => {
    const looked: string[] = [];
    const opened: string[] = [];
    const plan = { title: "SEO agency landing page", summary: "Build it", steps: [{ title: "Write index.html", files: ["index.html"] }] };
    const model = scripted([say(JSON.stringify(plan)), call("create_file", { path: "index.html", content: "<h1>SEO</h1>\n" }), say("Built it."), say("It looks right."), say('{"issues": []}')]);
    const svc = service(model, {
      runOptions: {},
      openFile: async (p) => void opened.push(p),
      lookAtPage: async (p) => (looked.push(p), { shots: [{ label: "Phone, 390 px wide", image: { type: "image", mediaType: "image/jpeg", data: "AAAA" } }], findings: [] }),
    });
    const ref = await svc.start({ text: "create a new folder on desktop and in it a landing page" });
    expect((await finished()).message).toBe("It looks right.");
    const scratch = join(root, "data", "scratch", ref.sessionId);
    expect(looked).toEqual([join(scratch, "index.html")]);
    expect((await history.getSession(ref.sessionId)).session.title).toBe("SEO agency landing page");
    expect(statuses).toContainEqual(expect.objectContaining({ type: "activity", text: "Looking at index.html in a browser" }));

    expect(await svc.sessionFiles(ref.sessionId)).toEqual({ count: 1, names: ["index.html"], page: "index.html" });
    await svc.openSessionPage(ref.sessionId);
    expect(opened).toEqual([join(scratch, "index.html")]);

    // A later turn in the same session keeps the title the user may have changed.
    await history.renameSession(ref.sessionId, "My page");
    statuses.length = 0;
    const again = service(scripted([say(JSON.stringify({ ...plan, title: "Something else" })), say("Nothing to do.")]), { runOptions: {} });
    await again.start({ sessionId: ref.sessionId, text: "anything else?" });
    await finished();
    expect((await history.getSession(ref.sessionId)).session.title).toBe("My page");
  });

  it("tells the agent plainly when the user names a place a session without a project can't write to", async () => {
    const model = scripted([say("The files are in this session's folder."), say("ok")]);
    const svc = service(model);
    await svc.start({ text: "create a new folder on desktop with a landing page" });
    await finished();
    const first = String(model.requests[0]!.messages.at(-1)!.content);
    expect(first).toContain(SCRATCH_PLACE_NOTE);
    expect(SCRATCH_PLACE_NOTE).toMatch(/Never say they are on the Desktop\.$/);
    // No place named, or a project session: no note.
    statuses.length = 0;
    await svc.start({ text: "make a landing page" });
    await finished();
    expect(String(model.requests[1]!.messages.at(-1)!.content)).not.toContain("Note from the app");
  });
});

describe("images", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

  it("sends pasted images to the model, saves them, and links them from history", async () => {
    const model = scripted([say("A cart icon.")]);
    const svc = service(model);
    const ref = await svc.start({ text: "What is this?", images: [{ mediaType: "image/png", data: PNG, name: "shot.png" }] });
    await finished();
    const task = model.requests[0]!.messages.at(-1)!;
    expect(Array.isArray(task.content) && task.content.some((p) => p.type === "image" && p.data === PNG)).toBe(true);
    const userMsg = (await history.getSession(ref.sessionId)).messages.items.find((m) => m.role === "user")!;
    const name = /attachment:([a-f0-9]{64}\.png)/.exec(userMsg.content)![1]!;
    expect(userMsg.content).toContain("![shot.png](attachment:");
    expect(await svc.readAttachment(name)).toBe(`data:image/png;base64,${PNG}`);
    await expect(svc.readAttachment("../settings.json")).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.readAttachment(`${"0".repeat(64)}.png`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses files that aren't images before starting anything", async () => {
    const svc = service(scripted([]));
    await expect(svc.start({ text: "x", images: [{ mediaType: "application/pdf" as never, data: "AA" }] })).rejects.toMatchObject({ code: "invalid" });
    expect((await history.listSessions({})).items).toHaveLength(0);
  });
});

describe("computer use", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const clicks: number[][] = [];
  const host = (perms = { screenRecording: true, accessibility: true }) => ({
    permissions: async () => perms,
    openSettings: async () => {},
    driver: async () => ({
      screenSize: async () => ({ width: 1000, height: 1000 }),
      screenshot: async () => ({ type: "image" as const, mediaType: "image/png" as const, data: PNG }),
      click: async (x: number, y: number) => void clicks.push([x, y]),
      move: async () => {},
      type: async () => {},
      key: async () => {},
      scroll: async () => {},
      drag: async () => {},
    }),
  });

  it("is refused unless switched on and permitted, without creating a session", async () => {
    const svc = service(scripted([]), { computer: host() });
    await expect(svc.start({ text: "click", computerUse: true })).rejects.toThrow(/Turn on computer use/);
    await svc.saveSettings({ computerUse: true });
    const blocked = service(scripted([]), { computer: host({ screenRecording: false, accessibility: true }) });
    await expect(blocked.start({ text: "click", computerUse: true })).rejects.toThrow(/Screen Recording and Accessibility/);
    expect((await history.listSessions({})).items).toHaveLength(0);
  });

  it("saves screenshots into history and remembers 'allow for this session' for clicks", async () => {
    clicks.length = 0;
    const svc = service(
      scripted([
        call("computer_screenshot", {}),
        call("computer_click", { x: 100, y: 200, note: "Save" }),
        call("computer_click", { x: 300, y: 400 }),
        say("Clicked twice."),
      ]),
      { computer: host() },
    );
    await svc.saveSettings({ computerUse: true });
    const ref = await svc.start({ text: "Click save", computerUse: true });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ kind: "computer", command: expect.stringContaining("Save") });
    await svc.respond(approvals[0]!.requestId, "allow_session");
    expect((await finished()).status).toBe("done");
    expect(approvals).toHaveLength(1); // the second click didn't ask again
    expect(clicks).toEqual([
      [100, 200],
      [300, 400],
    ]);
    const shot = (await history.getSession(ref.sessionId)).messages.items.flatMap((m) => m.toolCalls).find((c) => c.name === "computer_screenshot")!;
    expect(history.readToolOutput(shot.id)).toMatch(/attachment:[a-f0-9]{64}\.png/);
  });
});

describe("tools per run", () => {
  it("offers web search only when it is switched on", async () => {
    const on = scripted([say("ok")]);
    await service(on).start({ text: "q" });
    await finished();
    expect(on.requests[0]!.tools!.map((t) => t.name)).toContain("web_search");

    statuses.length = 0;
    const svc = service(scripted([]));
    await svc.saveSettings({ webSearch: false });
    const off = scripted([say("ok")]);
    await service(off).start({ text: "q" });
    await finished();
    expect(off.requests[0]!.tools!.map((t) => t.name)).not.toContain("web_search");
  });

  it("offers generate_image only when the module is installed and switched on", async () => {
    let installed = false;
    const media = {
      status: async () => ({ state: (installed ? "installed" : "not_installed") as "installed" | "not_installed" }),
      install: async (onLine: (l: string) => void) => {
        onLine("Installing mflux");
        installed = true;
        return { state: "installed" as const };
      },
      provider: { generateImage: async () => Buffer.from("png") },
    };
    const lines: string[] = [];
    const first = scripted([say("ok")]);
    const svc = service(first, { media, send: { status: (e) => statuses.push(e), approval: (p) => approvals.push(p), media: (l) => lines.push(l) } });
    await svc.start({ text: "draw" });
    await finished();
    expect(first.requests[0]!.tools!.map((t) => t.name)).not.toContain("generate_image");

    expect(await svc.installMedia()).toEqual({ state: "installed" });
    expect(lines).toEqual(["Installing mflux"]);
    expect((await svc.getSettings()).imageGeneration).toBe(true);
    statuses.length = 0;
    const second = scripted([say("ok")]);
    await service(second, { media }).start({ text: "draw" });
    await finished();
    expect(second.requests[0]!.tools!.map((t) => t.name)).toContain("generate_image");
  });
});

describe("memory in runs", () => {
  it("gives the model its always-on and recalled memory, keeps history as typed, and records what the answer cited", async () => {
    const memory = createMemoryStore(db);
    const p = (await service(scripted([])).addProject())!;
    const pref = await memory.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons" });
    const issue = await memory.createMemory({ kind: "open_issue", scope: "project", projectId: p.id, key: "cart.badge", body: "Badge count lags behind" });
    const always = await memory.alwaysOn(p.id);
    const handle = always.items.find((i) => i.ref.id === pref.id)!.handle;
    const model = scripted([say(`Done, no semicolons [${handle}].`)]);
    const ref = await service(model, { memory }).start({ projectId: p.id, text: "Fix the cart badge" });
    expect((await finished()).status).toBe("done");

    const req = model.requests[0]!;
    expect(req.messages[0]!.content).toContain("style.semicolons: No semicolons");
    expect(req.messages[0]!.content).toContain("Project shop");
    expect(req.messages.at(-1)!.content).toMatch(/^Fix the cart badge\n\n<recalled>[\s\S]*cart\.badge: Badge count lags behind/);
    expect(req.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["search_memory", "search_history", "remember"]));

    const msgs = (await history.getSession(ref.sessionId)).messages.items;
    expect(msgs.find((m) => m.role === "user")!.content).toBe("Fix the cart badge");
    const answer = msgs.filter((m) => m.role === "assistant").at(-1)!;
    expect((await memory.getUsedMemories(answer.id)).map((u) => [u.ref.id, u.reasons[0]])).toEqual([[pref.id, "cited"]]);
    expect((await memory.getMemory(pref.id)).memory.useCount).toBe(1);
    expect((await memory.getMemory(issue.id)).memory.useCount).toBe(0);
  });

  it("builds the always-on block once per session, so a new memory applies from the next session", async () => {
    const memory = createMemoryStore(db);
    const model = scripted([say("one"), say("two"), say("three")]);
    const svc = service(model, { memory });
    const ref = await svc.start({ text: "hello" });
    await finished();
    await memory.createMemory({ kind: "preference", scope: "global", key: "style.tabs", body: "Use tabs" });

    statuses.length = 0;
    await svc.start({ sessionId: ref.sessionId, text: "again" });
    await finished();
    // Same session: the system prompt is unchanged, so the model server's prompt cache still applies.
    expect(model.requests[1]!.messages[0]!.content).toBe(model.requests[0]!.messages[0]!.content);
    expect(String(model.requests[1]!.messages[0]!.content)).not.toContain("style.tabs");

    statuses.length = 0;
    await svc.start({ text: "new session" });
    await finished();
    expect(String(model.requests[2]!.messages[0]!.content)).toContain("style.tabs: Use tabs");
  });

  it("saves a memory the user asked for only after approval, with the user's message as evidence", async () => {
    const memory = createMemoryStore(db);
    const svc = service(
      scripted([call("remember", { kind: "preference", scope: "global", key: "style.quotes", body: "Prefer single quotes" }), say("Noted.")]),
      { memory },
    );
    const ref = await svc.start({ text: "Remember that I prefer single quotes" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ kind: "memory", command: "Remember for all projects (preference) style.quotes: Prefer single quotes" });
    await svc.respond(approvals[0]!.requestId, "allow");
    expect((await finished()).status).toBe("done");
    const saved = (await memory.listMemories({})).items[0]!;
    expect(saved).toMatchObject({ key: "style.quotes", body: "Prefer single quotes", trust: "user" });
    const userMsg = (await history.getSession(ref.sessionId)).messages.items.find((m) => m.role === "user")!;
    expect(saved.evidence).toEqual([{ type: "message", id: userMsg.id }]);
  });

  it("gives a project with memory off no memory and no memory tools", async () => {
    const memory = createMemoryStore(db);
    const p = (await service(scripted([])).addProject())!;
    await memory.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons" });
    await memory.updateSettings({ projectModes: { [p.id]: "off" } });
    const model = scripted([say("ok")]);
    await service(model, { memory }).start({ projectId: p.id, text: "Fix it" });
    await finished();
    expect(model.requests[0]!.messages[0]!.content).not.toContain("<memory>");
    expect(model.requests[0]!.tools!.map((t) => t.name)).not.toContain("remember");
  });
});

describe("memory privacy guards", () => {
  it("gives a read-only project memory to read but no way to save, not even globally", async () => {
    const memory = createMemoryStore(db);
    const p = (await service(scripted([])).addProject())!;
    await memory.createMemory({ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons" });
    await memory.updateSettings({ projectModes: { [p.id]: "read_only" } });
    const model = scripted([say("ok")]);
    await service(model, { memory }).start({ projectId: p.id, text: "Fix it" });
    await finished();
    expect(model.requests[0]!.messages[0]!.content).toContain("style.semicolons");
    const names = model.requests[0]!.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_memory", "search_history"]));
    expect(names).not.toContain("remember");
  });

  it("keeps a scratch chat's history search out of project sessions", async () => {
    const memory = createMemoryStore(db);
    const p = (await service(scripted([])).addProject())!;
    const secret = history.createSession({ projectId: p.id, title: "client" });
    history.appendMessage(secret.id, { role: "user", content: "the acme billing endpoint is internal" });
    const scratch = history.createSession({ title: "notes" });
    history.appendMessage(scratch.id, { role: "user", content: "acme billing idea for my own app" });
    const model = scripted([call("search_history", { query: "acme billing" }), say("done")]);
    await service(model, { memory }).start({ text: "What did I say about acme billing?" });
    await finished();
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content)).toContain("for my own app");
    expect(String(toolMsg.content)).not.toContain("endpoint is internal");
  });

  it("asks about every memory save, even after 'allow for this session' was chosen", async () => {
    const memory = createMemoryStore(db);
    const svc = service(
      scripted([
        call("remember", { kind: "preference", scope: "global", key: "style.quotes", body: "Prefer single quotes" }),
        call("remember", { kind: "preference", scope: "global", key: "style.tabs", body: "Use tabs" }),
        say("Noted."),
      ]),
      { memory },
    );
    await svc.start({ text: "Remember both" });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await svc.respond(approvals[0]!.requestId, "allow_session");
    await vi.waitFor(() => expect(approvals).toHaveLength(2));
    await svc.respond(approvals[1]!.requestId, "deny");
    await finished();
    expect((await memory.listMemories({})).items.map((m) => m.key)).toEqual(["style.quotes"]);
  });

  it("drops a deleted memory from the session's always-on block at once", async () => {
    const memory = createMemoryStore(db);
    const pref = await memory.createMemory({ kind: "preference", scope: "global", key: "client.secret", body: "Acme is the client" });
    const model = scripted([say("one"), say("two")]);
    const svc = service(model, { memory });
    const ref = await svc.start({ text: "hello" });
    await finished();
    expect(String(model.requests[0]!.messages[0]!.content)).toContain("client.secret");
    await memory.deleteMemory(pref.id);
    statuses.length = 0;
    await svc.start({ sessionId: ref.sessionId, text: "again" });
    await finished();
    expect(String(model.requests[1]!.messages[0]!.content)).not.toContain("client.secret");
  });

  it("counts a memory the model found with search_memory and cited", async () => {
    const memory = createMemoryStore(db);
    const lesson = await memory.createMemory({ kind: "lesson", scope: "global", key: "metro.cache", body: "Clear the metro cache after upgrading" });
    const handle = (await memory.taskContext({ text: "metro cache" })).items[0]!.handle;
    const model = scripted([call("search_memory", { query: "metro cache" }), say(`Cleared it [${handle}].`)]);
    const ref = await service(model, { memory }).start({ text: "The bundler is acting up" });
    await finished();
    const answer = (await history.getSession(ref.sessionId)).messages.items.filter((m) => m.role === "assistant").at(-1)!;
    expect((await memory.getUsedMemories(answer.id)).map((u) => [u.ref.id, u.reasons[0]])).toEqual([[lesson.id, "cited"]]);
    expect((await memory.getMemory(lesson.id)).memory.useCount).toBe(1);
  });
});

describe("docs packs and seeding in the app", () => {
  const rnProject = () => {
    writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module", dependencies: { "react-native": "0.77.1" }, scripts: { typecheck: "node check.mjs" } }));
    writeFileSync(join(project, "AGENTS.md"), "# Rules\n\n- Keep components small and typed with TypeScript\n");
  };

  it("adding a project builds its docs packs and proposes its written conventions", async () => {
    rnProject();
    const memory = createMemoryStore(db, { docsFetcher: () => fakeDocsFetcher({ "facebook/react-native-website": RN_REPO }) });
    memory.jobs.start();
    const p = (await service(scripted([]), { memory }).addProject())!;
    await memory.jobs.idle();
    await vi.waitFor(async () => expect((await memory.listCandidates()).map((c) => c.body)).toEqual(["Keep components small and typed with TypeScript"]));
    expect((await memory.listDocPacks(p.id)).map((x) => [x.library, x.version, x.status])).toEqual([["react-native", "0.77", "ready"]]);
  });

  it("lets the agent search the project's docs, records cited docs, and pauses background jobs during the run", async () => {
    rnProject();
    const memory = createMemoryStore(db, { docsFetcher: () => fakeDocsFetcher({ "facebook/react-native-website": RN_REPO }) });
    memory.jobs.start();
    const p = (await service(scripted([]), { memory }).addProject())!;
    await memory.jobs.idle();
    const handle = (await memory.searchDocs({ projectId: p.id, query: "maintainVisibleContentPosition" }))[0]!.handle;
    const paused: boolean[] = [];
    const pause = memory.jobs.pause.bind(memory.jobs);
    const resume = memory.jobs.resume.bind(memory.jobs);
    memory.jobs.pause = () => (paused.push(true), pause());
    memory.jobs.resume = () => (paused.push(false), resume());
    const model = scripted([call("search_docs", { query: "maintainVisibleContentPosition", library: "react-native" }), say(`Use maintainVisibleContentPosition [${handle}].`)]);
    const ref = await service(model, { memory }).start({ projectId: p.id, text: "Keep the chat list from jumping" });
    expect((await finished()).status).toBe("done");
    expect(model.requests[0]!.tools!.map((t) => t.name)).toContain("search_docs");
    const toolMsg = model.requests[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(toolMsg.content)).toMatch(/React Native 0\.77 docs — FlatList › Props › maintainVisibleContentPosition/);
    const answer = (await history.getSession(ref.sessionId)).messages.items.filter((m) => m.role === "assistant").at(-1)!;
    expect((await memory.getUsedMemories(answer.id)).map((u) => [u.ref.type, u.reasons[0]])).toEqual([["doc", "cited"]]);
    expect(paused).toEqual([true, false]);
  });

  it("gives a scratch session no docs tool", async () => {
    const memory = createMemoryStore(db);
    const model = scripted([say("ok")]);
    await service(model, { memory }).start({ text: "hi" });
    await finished();
    expect(model.requests[0]!.tools!.map((t) => t.name)).not.toContain("search_docs");
  });
});

describe("experience memory in the app", () => {
  const TS_ERR = (f: string) => `${f}(12,5): error TS2532: Object is possibly 'undefined'.`;
  const approveAll = (svc: AgentService) => {
    const timer = setInterval(() => {
      for (const a of approvals.splice(0)) void svc.respond(a.requestId, "allow");
    }, 5);
    return () => clearInterval(timer);
  };

  it("turns a fail-to-pass in project A into an episode, and shows its lesson when project B hits the same error", async () => {
    const memory = createMemoryStore(db, {
      summarizer: () => async (fix) => ({ problem: "Optional value used directly", fixSummary: `Guarded it in ${fix.files[0]}`, lesson: "Guard optional values before using them." }),
    });
    memory.jobs.start();
    const a = (await service(scripted([]), { memory }).addProject())!;

    // Project A: a command fails, the agent changes a file, the same command passes.
    writeFileSync(join(project, "toggle.mjs"), "import { existsSync } from 'node:fs'; if (!existsSync('fixed.txt')) { console.error(process.argv[2]); process.exit(2); }");
    const cmd = `node toggle.mjs "${TS_ERR("/Users/me/a/src/list.tsx")}"`;
    const modelA = scripted([call("run_command", { command: cmd }), call("create_file", { path: "fixed.txt", content: "ok" }), call("run_command", { command: cmd }), say("Fixed.")]);
    const svcA = service(modelA, { memory });
    const stopA = approveAll(svcA);
    await svcA.start({ projectId: a.id, text: "Fix the list", allowFailingChecks: true });
    await finished();
    stopA();
    await memory.jobs.idle();
    const eps = (await memory.listEpisodes({})).items;
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ projectId: a.id, lesson: "Guard optional values before using them.", files: ["fixed.txt"], verifiedBy: "run" });

    // Project B: the same error in another file; the failing result carries the lesson, nothing of A's code.
    const bDir = join(root, "b");
    mkdirSync(bDir);
    writeFileSync(join(bDir, "package.json"), "{}");
    const b = history.ensureProject({ path: bDir, name: "b" });
    statuses.length = 0;
    writeFileSync(join(bDir, "fail.mjs"), "console.error(process.argv[2]); process.exit(2);");
    const failB = `node fail.mjs "${TS_ERR("/home/x/b/src/other.tsx")}"`;
    const modelB = scripted([call("run_command", { command: failB }), say("Will guard it.")]);
    const svcB = service(modelB, { memory });
    const stopB = approveAll(svcB);
    const ref = await svcB.start({ projectId: b, text: "Fix the other screen" });
    await finished();
    stopB();
    const toolMsg = model1Tool(modelB);
    expect(toolMsg).toMatch(/Seen this error before[\s\S]*Guard optional values before using them\./);
    expect(toolMsg).not.toMatch(/fixed\.txt|\/Users\/me\/a/);
    const answer = (await history.getSession(ref.sessionId)).messages.items.filter((m) => m.role === "assistant").at(-1)!;
    expect((await memory.getUsedMemories(answer.id)).some((u) => u.ref.type === "episode")).toBe(true);
  });
});

describe("proposed memories in the app", () => {
  const extractor = (calls: string[]) => async (prompt: string) => {
    calls.push(prompt);
    return JSON.stringify({ candidates: [{ kind: "preference", scope: "global", key: "style.semicolons", body: "No semicolons.", evidence: ["m1"] }] });
  };

  it("proposes memories when a task finishes, for review", async () => {
    const calls: string[] = [];
    const memory = createMemoryStore(db, { extractor: () => extractor(calls) });
    memory.jobs.start();
    await service(scripted([say("Done, no semicolons.")]), { memory }).start({ text: "I never want semicolons. Write it that way." });
    await finished();
    await vi.waitFor(async () => expect((await memory.listCandidates()).map((c) => c.key)).toEqual(["style.semicolons"]));
    expect(calls[0]).toContain("[m1] USER: I never want semicolons.");
  });

  it("waits until an unfinished session sits idle, and a new run in it resets the wait", async () => {
    const calls: string[] = [];
    const memory = createMemoryStore(db, { extractor: () => extractor(calls) });
    memory.jobs.start();
    const svc = service(scripted([call("read_file", { path: "nope.txt" }), call("read_file", { path: "nope.txt" }), say("ok")]), {
      memory,
      extractionIdleMs: 600,
      runOptions: { plan: false, maxTurns: 1 },
    });
    const ref = await svc.start({ text: "No semicolons, please" });
    expect((await finished()).status).not.toBe("done");
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0);
    statuses.length = 0;
    await svc.start({ sessionId: ref.sessionId, text: "continue" }); // the session is in use again
    await finished();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 4000 });
  });
});

const model1Tool = (m: { requests: ChatRequest[] }) => String(m.requests[1]!.messages.filter((x) => x.role === "tool").at(-1)!.content);

describe("helpers", () => {
  it("titles sessions from the first line of the task", () => {
    expect(titleFrom("\n  Fix   the cart total\nmore detail")).toBe("Fix the cart total");
    expect(titleFrom("x".repeat(80))).toHaveLength(58);
  });

  it("describes tool activity in plain words", () => {
    expect(describeActivity("read_file", { path: "src/a.ts" })).toBe("Reading src/a.ts");
    expect(describeActivity("run_command", { command: "pnpm i" })).toBe("Running pnpm i");
    expect(describeActivity("computer_read_screen", {})).toBe("Reading the screen");
    expect(describeActivity("computer_open_app", { name: "Calculator" })).toBe("Opening Calculator");
    expect(describeActivity("search_docs", { query: "FlatList" })).toBe("Searching the docs for FlatList");
    expect(describeActivity("find_symbol", { name: "useCart" })).toBe("Finding useCart");
    expect(describeActivity("find_references", { name: "useCart" })).toBe("Finding uses of useCart");
    expect(describeActivity("diagnostics", {})).toBe("Checking for errors");
    expect(describeActivity("self_review", { files: ["a.ts"] })).toBe("Reviewing the change");
    expect(describeActivity("insert_lines", { path: "index.html" })).toBe("Editing index.html");
    expect(describeActivity("mystery", {})).toBe("Using mystery");
  });
});
