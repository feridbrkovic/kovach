import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
  type ReferenceLook,
  type ApprovalRequest,
  type ChatMessage,
  type ChatModel,
  type PageLook,
  type ComputerDriver,
  type ContentPart,
  computerTools,
  createOpenAiCompatibleModel,
  memoryTools,
  type SessionRecorder,
  type ImagePart,
  imageTools,
  type MediaProvider,
  runAgentTask,
  TOOLS,
  Workspace,
  appKitTool,
  designKitTool,
  photoTools,
  webTools,
} from "@kovach-dev/agent";
import { MemoryApiError } from "@kovach-dev/memory-contract";
import type { AutomationRunner } from "./automations";
import { commandAllowed, commandScopes, rememberCommand, scopeLabel } from "./command-scope";
import { type AlwaysOnBlock, type ContextItem, type HistoryStore, type MemoryStore, redactSecrets, scanSecrets } from "@kovach-dev/memory-service";
import {
  type AgentApi,
  type AgentSettings,
  type AgentStatusEvent,
  type ApprovalDecision,
  type ApprovalPrompt,
  type ComputerPermissions,
  DEFAULT_SETTINGS,
  MAX_STANDARDS_CHARS,
  type ImageAttachment,
  type MediaStatusView,
  describeActivity,
  type ModelCheck,
  matchModel,
  type ProjectInfo,
  type SessionFiles,
  type RunRef,
  type SettingsInput,
  type SettingsView,
  type StoredSettings,
  type StartInput,
  type StatusBody,
  type Automation,
  type AutomationInput,
  type AutomationsView,
} from "../shared/agent";

export interface SettingsStore {
  get(): StoredSettings;
  set(settings: StoredSettings): StoredSettings;
  /**
   * Whether a key is saved, without decrypting it. Decrypting can raise a Keychain prompt that
   * blocks the app until answered, so showing the settings must not need it.
   */
  hasApiKey?(): boolean;
}

/**
 * Encrypts the API key at rest. In the app this is Electron's safeStorage,
 * which keeps its key in the macOS Keychain.
 */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/** Settings in a small JSON file next to the database; the API key only ever encrypted. */
export function createFileSettingsStore(path: string, codec?: SecretCodec): SettingsStore {
  let cache: StoredSettings | undefined;
  /** A saved key exists on disk (whether or not it has been decrypted yet). */
  let encrypted = false;
  return {
    hasApiKey() {
      this.get();
      return encrypted;
    },
    get() {
      if (cache) return cache;
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSettings> & { apiKeyEncrypted?: unknown };
        const loaded: StoredSettings = { ...DEFAULT_SETTINGS };
        // Copy every known field of the right type; older files simply lack the newer ones.
        for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof AgentSettings)[]) {
          if (typeof raw[k] === typeof DEFAULT_SETTINGS[k]) (loaded as unknown as Record<string, unknown>)[k] = raw[k];
        }
        cache = loaded;
        if (codec && typeof raw.apiKeyEncrypted === "string") {
          // Decrypted the first time something needs the key (a model call), not when settings are read.
          const stored = raw.apiKeyEncrypted;
          let key: string | undefined;
          let tried = false;
          Object.defineProperty(cache, "apiKey", {
            enumerable: true,
            configurable: true,
            get: () => {
              if (!tried) {
                tried = true;
                try {
                  key = codec.decrypt(stored);
                } catch {
                  // A key encrypted on another machine or user can't be read; treat it as unset.
                }
              }
              return key;
            },
            set: (v: string | undefined) => {
              tried = true;
              key = v;
            },
          });
          encrypted = true;
        }
      } catch {
        cache = { ...DEFAULT_SETTINGS };
      }
      return cache!;
    },
    set(settings) {
      if (settings.apiKey && !codec) throw new MemoryApiError("unavailable", "Can't store the API key safely on this system");
      const { apiKey: _key, ...plain } = settings;
      const file: Record<string, unknown> = { ...plain };
      if (settings.apiKey && codec) file.apiKeyEncrypted = codec.encrypt(settings.apiKey);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      cache = { ...settings };
      encrypted = !!(settings.apiKey && codec);
      return cache;
    },
  };
}

/** Settings for the UI. With `hasKey` given, the key itself is never read (see SettingsStore.hasApiKey). */
/** Files under a folder, as relative paths (dot-folders left out). */
/** Folders that are installed or generated, not written by the session: not counted and not copied. */
const NOT_OURS = [/^node_modules$/, /^\.expo$/, /^ios\/(Pods|build)$/, /^android\/(build|\.gradle|app\/build)$/];
const skipped = (relative: string) => NOT_OURS.some((folder) => folder.test(relative.split(sep).join("/")));

function listTree(root: string, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit || e.name.startsWith(".")) continue;
      if (e.isDirectory() && skipped(prefix + e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.isFile()) out.push(prefix + e.name);
    }
  };
  walk(root, "");
  return out;
}

const FILLER = new Set(
  "a an the and or but yet in on at to of for with it its me my please can you could create make build write generate add new simple folder file files desktop documents downloads".split(" "),
);

/** The page to open: index.html nearest the top, else the first HTML file. */
function pageAmong(names: string[]): string | undefined {
  const pages = names.filter((n) => /\.html?$/i.test(n));
  return pages.filter((n) => /(^|\/)index\.html?$/i.test(n)).sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? pages[0];
}

/** A folder name from a session title: a few plain words, safe on any file system. */
export function folderName(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean);
  // Titles are the start of the request ("create a new folder on desktop and in it…"): keep the words that name the thing.
  const naming = words.filter((w) => !FILLER.has(w));
  return (naming.length ? naming : words).slice(0, 4).join("-").slice(0, 48) || "local-kovach-files";
}

/** The user named a place for the files (a session without a project can't write there). */
const NAMED_PLACE = /\b(desktop|documents|downloads|home (folder|directory)|radn[aeiou]j? površin\w*|~\/|\/Users\/|[A-Za-z]:\\)/i;
export const SCRATCH_PLACE_NOTE =
  'Note from the app: this session has no project folder, so you can\'t create files on the Desktop or in any other folder the user names. Create them here, with plain relative paths (index.html, not a folder for the location). In the brief\'s assumptions and in your final answer, say that the files are in this session\'s own folder and that the user can put them where they want with "Save to folder…" under this conversation. Never say they are on the Desktop.';

const view = (s: StoredSettings, hasKey?: boolean): SettingsView => {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(s)) if (k !== "apiKey") rest[k] = (s as unknown as Record<string, unknown>)[k];
  return { ...(rest as Omit<StoredSettings, "apiKey">), hasApiKey: hasKey ?? !!s.apiKey };
};

export interface AgentServiceDeps {
  history: HistoryStore;
  settings: SettingsStore;
  /** Status events and approval prompts go to the renderer through these. */
  send: { status(e: AgentStatusEvent): void; approval(p: ApprovalPrompt): void; media?(line: string): void };
  /** Folder picker (Electron's dialog in the app). */
  pickFolder?: (title?: string) => Promise<string | undefined>;
  /** Shows a folder in the system file manager. */
  showFolder?: (path: string) => Promise<void>;
  /** Opens a file with the system's default app (a web page: the browser). */
  openFile?: (path: string) => Promise<void>;
  /** Renders a web page the agent built and reports what it looks like (screenshots, measurable problems). */
  lookAtPage?: (path: string, signal?: AbortSignal) => Promise<PageLook | undefined>;
  /** Opens a link the user gave as a design example and measures its colours, fonts and corners. */
  measureReference?: (url: string, signal?: AbortSignal) => Promise<ReferenceLook | undefined>;
  createModel?: (settings: StoredSettings) => ChatModel;
  fetch?: typeof fetch;
  /** Scale a downloaded photo down to a web size (JPEG). */
  resizeImage?: (image: Buffer, maxWidth: number) => Promise<{ data: Buffer; width: number; height: number } | undefined>;
  /** Extra options for every run (tests turn planning off, pass checks, …). */
  runOptions?: Partial<AgentOptions>;
  /** How long a session that didn't finish must sit idle before memory extraction runs. Default 10 minutes. */
  extractionIdleMs?: number;
  /** Sessions without a project get a private folder here, one per session. */
  scratchDir: string;
  /** Pasted images and screenshots are kept here, content-addressed. */
  attachmentsDir: string;
  /** Screen control on macOS; absent where it isn't supported. */
  computer?: ComputerHost;
  /** The image-generation module; absent where it isn't supported. */
  media?: MediaHost;
  /** Long-term memory (Phase 2). Without it runs have no memory. */
  memory?: MemoryStore;
  /** Called after the model settings change (the embedder follows the model server). */
  onSettingsChanged?: () => void;
}

export interface ComputerHost {
  driver(): Promise<ComputerDriver>;
  permissions(): Promise<ComputerPermissions>;
  openSettings(which: keyof ComputerPermissions): Promise<void>;
}

export interface MediaHost {
  status(): Promise<MediaStatusView>;
  install(onLine: (line: string) => void): Promise<MediaStatusView>;
  provider: MediaProvider;
}

const ATTACHMENT_NAME = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
const EXT: Record<ImageAttachment["mediaType"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
/** The largest image the window may attach (base64 of ~10 MB). */
const MAX_IMAGE_B64 = 14_000_000;

interface ActiveRun extends RunRef {
  controller: AbortController;
}

/** How many earlier messages a resumed session sends back to the model. */
const RESUME_MESSAGES = 20;

/**
 * Runs the agent for the desktop app: one task at a time (one model loaded),
 * every command approved through the renderer, everything recorded in history.
 * Electron-free, so it is tested directly.
 */
export class AgentService implements Omit<AgentApi, "onStatus" | "onApproval" | "onMediaProgress" | "onOpenSession"> {
  private active: ActiveRun | undefined;
  private installing = false;
  private pending = new Map<string, { sessionId: string; command: string; kind: ApprovalRequest["kind"]; resolve: (ok: boolean) => void }>();
  /** Commands (and, for screen and media actions, whole kinds) the user allowed for the rest of a session. */
  private remembered = new Map<string, Set<string>>();
  /** The always-on block, built once per session so the prompt cache holds (MASTER_PLAN › Read path). */
  private alwaysOnBySession = new Map<string, AlwaysOnBlock>();

  constructor(private readonly deps: AgentServiceDeps) {
    // A session keeps its always-on block (prompt caching), except when the user
    // edits or deletes something in it: that must stop reaching the model at once.
    deps.memory?.onChange((e) => {
      if (e.type !== "memory" || e.action === "created") return;
      for (const [sid, block] of this.alwaysOnBySession) {
        if (block.items.some((i) => i.ref.type === "memory" && i.ref.id === e.id)) this.alwaysOnBySession.delete(sid);
      }
    });
  }

  async getSettings(): Promise<SettingsView> {
    return view(this.deps.settings.get(), this.deps.settings.hasApiKey?.());
  }

  async saveSettings(settings: SettingsInput): Promise<SettingsView> {
    const current = this.deps.settings.get();
    const modelBaseUrl = (settings.modelBaseUrl ?? current.modelBaseUrl).trim().replace(/\/+$/, "");
    const model = (settings.model ?? current.model).trim();
    let url: URL;
    try {
      url = new URL(modelBaseUrl);
    } catch {
      throw new MemoryApiError("invalid", "The model server address must be a URL, e.g. http://127.0.0.1:8000/v1");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new MemoryApiError("invalid", "Use an http:// or https:// address");
    if (!model) throw new MemoryApiError("invalid", "Enter the model name the server uses");
    const searxngUrl = (settings.searxngUrl ?? current.searxngUrl).trim().replace(/\/+$/, "");
    if (searxngUrl) {
      try {
        const u = new URL(searxngUrl);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      } catch {
        throw new MemoryApiError("invalid", "The SearXNG address must be an http:// or https:// URL, or empty");
      }
    }
    const flag = (k: "webSearch" | "computerUse" | "imageGeneration") => (typeof settings[k] === "boolean" ? settings[k] : current[k]);
    const standards = (settings.standards ?? current.standards).replace(/\r\n/g, "\n").trim();
    if (standards.length > MAX_STANDARDS_CHARS) {
      throw new MemoryApiError("invalid", `Standards can be up to ${MAX_STANDARDS_CHARS.toLocaleString("en")} characters; this is ${standards.length.toLocaleString("en")}. They are read on every task, so keep them to the rules that matter.`);
    }
    // They go into every planning prompt and are stored in plain text: no keys or passwords.
    if (scanSecrets(standards).length) throw new MemoryApiError("invalid", "The standards contain something that looks like a key or password. Remove it; standards are stored as plain text.");
    const next: StoredSettings = {
      standards,
      modelBaseUrl,
      model,
      searxngUrl,
      webSearch: flag("webSearch"),
      computerUse: flag("computerUse"),
      imageGeneration: flag("imageGeneration"),
    };
    const key = settings.apiKey === undefined ? current.apiKey : settings.apiKey.trim();
    if (key && /\s/.test(key)) throw new MemoryApiError("invalid", "The API key can't contain spaces");
    if (key) next.apiKey = key;
    const saved = view(this.deps.settings.set(next));
    this.deps.onSettingsChanged?.();
    return saved;
  }

  async checkModel(): Promise<ModelCheck> {
    const { modelBaseUrl, model, apiKey } = this.deps.settings.get();
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${modelBaseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
        ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      });
    } catch {
      return { ok: false, message: `Can't reach the model server at ${modelBaseUrl}. Is oMLX running?` };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: apiKey
          ? "The model server refused the API key. Copy it again from the server's settings (in oMLX: Settings → Auth & Info)."
          : "The model server needs an API key. Paste it below (in oMLX: Settings → Auth & Info).",
      };
    }
    if (!res.ok) return { ok: false, message: `The model server answered ${res.status}.` };
    let models: string[] = [];
    try {
      const body = (await res.json()) as { data?: { id?: string }[] };
      models = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    } catch {
      // A server without a model list is still reachable.
    }
    if (!models.length) return { ok: true, models, message: `Connected to ${modelBaseUrl}.` };
    const found = matchModel(model, models);
    if (!found) {
      return { ok: false, models, message: `Connected, but the server has no model called "${model}". Available: ${models.join(", ")}.` };
    }
    if (found !== model) {
      this.deps.settings.set({ ...this.deps.settings.get(), model: found });
      return { ok: true, models, model: found, message: `Connected to ${modelBaseUrl}; using ${found}, the server's name for that model.` };
    }
    return { ok: true, models, message: `Connected to ${modelBaseUrl}; ${model} is available.` };
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return this.deps.history.listProjects().map(({ id, name, path }) => ({ id, name, path }));
  }

  async addProject(): Promise<ProjectInfo | undefined> {
    const path = await this.deps.pickFolder?.();
    if (!path) return undefined;
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new MemoryApiError("invalid", `${path} is not a folder`);
    const id = this.deps.history.ensureProject({ path, name: basename(path) });
    const p = this.deps.history.getProject(id)!;
    this.prepareProject(id);
    return { id: p.id, name: p.name, path: p.path };
  }

  /** The private folder of a session without a project; undefined for project sessions. */
  private scratchRoot(sessionId: string): string | undefined {
    const session = this.deps.history.resume(sessionId, { lastN: 0 }).session;
    if (session.projectId || !/^[\w-]+$/.test(sessionId)) return undefined;
    return join(this.deps.scratchDir, sessionId);
  }

  async sessionFiles(sessionId: string): Promise<SessionFiles> {
    const root = this.scratchRoot(sessionId);
    if (!root || !existsSync(root)) return { count: 0, names: [] };
    const names = listTree(root);
    const page = pageAmong(names);
    return { count: names.length, names: names.slice(0, 8), ...(page ? { page } : {}) };
  }

  async openSessionPage(sessionId: string): Promise<void> {
    const root = this.scratchRoot(sessionId);
    const page = root && existsSync(root) ? pageAmong(listTree(root)) : undefined;
    if (!root || !page) throw new MemoryApiError("not_found", "This session hasn't made a web page");
    await this.deps.openFile?.(join(root, page));
  }

  async showSessionFiles(sessionId: string): Promise<void> {
    const root = this.scratchRoot(sessionId);
    if (!root || !existsSync(root)) throw new MemoryApiError("not_found", "This session hasn't made any files");
    await this.deps.showFolder?.(root);
  }

  /** Copies the session's files into a new folder inside one the user picks; nothing is overwritten. */
  async saveSessionFiles(sessionId: string): Promise<{ path: string; copied: number } | undefined> {
    const root = this.scratchRoot(sessionId);
    const names = root && existsSync(root) ? listTree(root) : [];
    if (!root || names.length === 0) throw new MemoryApiError("not_found", "This session hasn't made any files");
    const parent = await this.deps.pickFolder?.("Choose where to save the files");
    if (!parent) return undefined;
    if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new MemoryApiError("invalid", `${parent} is not a folder`);
    const title = this.deps.history.resume(sessionId, { lastN: 0 }).session.title ?? "";
    const base = folderName(title);
    let target = join(parent, base);
    for (let n = 2; existsSync(target); n++) target = join(parent, `${base} ${n}`);
    // Installed packages and generated native folders stay behind: they are large and rebuilt with one command.
    cpSync(root, target, { recursive: true, errorOnExist: true, force: false, filter: (source) => source === root || !skipped(relative(root, source)) });
    return { path: target, copied: names.length };
  }

  /**
   * Background work for a project the user works in: docs packs for the
   * versions it uses (rebuilt after an upgrade) and, once, proposals from its
   * AGENTS.md / CLAUDE.md. Never blocks or fails a run.
   */
  private prepareProject(projectId: string): void {
    const memory = this.deps.memory;
    if (!memory) return;
    try {
      memory.ensureDocPacks(projectId);
    } catch {
      // the docs panel shows the problem
    }
    void memory.seedProject(projectId).catch(() => undefined);
  }

  private extractionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private scheduleExtraction(sessionId: string, delayMs: number): void {
    const memory = this.deps.memory;
    if (!memory) return;
    this.cancelExtraction(sessionId);
    const go = () => {
      this.extractionTimers.delete(sessionId);
      try {
        memory.queueExtraction(sessionId);
      } catch {
        // proposals are best effort
      }
    };
    if (delayMs <= 0) return go();
    const timer = setTimeout(go, delayMs);
    timer.unref?.();
    this.extractionTimers.set(sessionId, timer);
  }

  private cancelExtraction(sessionId: string): void {
    const t = this.extractionTimers.get(sessionId);
    if (t) clearTimeout(t);
    this.extractionTimers.delete(sessionId);
  }

  /** Scheduled automations; attached once the app has built the runner (it needs this service). */
  private automations: AutomationRunner | undefined;
  attachAutomations(runner: AutomationRunner): void {
    this.automations = runner;
  }
  private runner(): AutomationRunner {
    if (!this.automations) throw new MemoryApiError("invalid", "Automations aren't available here");
    return this.automations;
  }
  async listAutomations(): Promise<AutomationsView> {
    return this.runner().list();
  }
  async saveAutomation(input: AutomationInput): Promise<Automation> {
    return this.runner().save(input);
  }
  async deleteAutomation(id: string): Promise<void> {
    this.runner().delete(id);
  }
  async runAutomation(id: string, options?: { dryRun?: boolean }): Promise<RunRef> {
    return this.runner().run(id, options);
  }
  async setAutomationsPaused(paused: boolean): Promise<AutomationsView> {
    return this.runner().setPaused(paused);
  }

  private madePath(sessionId: string): string | undefined {
    return /^[\w-]+$/.test(sessionId) ? join(this.deps.scratchDir, ".made", `${sessionId}.json`) : undefined;
  }
  private madeBefore(sessionId: string): string[] {
    const path = this.madePath(sessionId);
    try {
      const list = path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : [];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  private rememberMade(sessionId: string, made: string[]): void {
    const path = this.madePath(sessionId);
    if (!path || made.length === 0) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(made), "utf8");
    } catch {
      // bookkeeping only: a follow-up then treats these files as the project's own
    }
  }

  async activeRun(): Promise<RunRef | undefined> {
    return this.active ? { runId: this.active.runId, sessionId: this.active.sessionId } : undefined;
  }

  async start(input: StartInput): Promise<RunRef> {
    const text = input.text?.trim();
    if (!text) throw new MemoryApiError("invalid", "Write what you want done first");
    if (this.active) throw new MemoryApiError("conflict", "Another task is still running. Stop it or wait for it to finish.");
    const { history } = this.deps;
    const settings = this.deps.settings.get();

    // Images first: refuse bad input before anything is created.
    const images = (input.images ?? []).map((img) => {
      if (!(img.mediaType in EXT) || typeof img.data !== "string" || img.data.length > MAX_IMAGE_B64) {
        throw new MemoryApiError("invalid", "Attach PNG, JPEG, WebP or GIF images up to about 10 MB");
      }
      return img;
    });

    // Computer use: refuse early, before a session is created, if it can't work.
    let computer: ComputerHost | undefined;
    if (input.computerUse) {
      if (!settings.computerUse || !this.deps.computer) throw new MemoryApiError("invalid", "Turn on computer use in settings first");
      const perms = await this.deps.computer.permissions();
      if (!perms.screenRecording || !perms.accessibility) {
        throw new MemoryApiError(
          "invalid",
          "Computer use needs Screen Recording and Accessibility permission for Local Kovach (System Settings → Privacy & Security)",
        );
      }
      computer = this.deps.computer;
    }

    // Session and workspace: a project folder, or a scratch folder for sessions without one.
    let sessionId: string | undefined;
    let projectId: string | undefined;
    let priorMessages: ChatMessage[] = [];
    if (input.sessionId) {
      const resumed = history.resume(input.sessionId, { lastN: RESUME_MESSAGES });
      projectId = resumed.session.projectId;
      sessionId = input.sessionId;
      priorMessages = toChatMessages(resumed.summary, resumed.messages);
    } else {
      projectId = input.projectId;
    }
    let root: string;
    if (projectId) {
      const project = history.getProject(projectId);
      if (!project) throw new MemoryApiError("not_found", "That project no longer exists");
      root = project.path;
    } else {
      sessionId ??= history.createSession({ title: input.title?.trim() || titleFrom(text), model: settings.model }).id;
      root = join(this.deps.scratchDir, sessionId);
      mkdirSync(root, { recursive: true });
    }
    let workspace: Workspace;
    try {
      workspace = new Workspace(root);
    } catch {
      throw new MemoryApiError("invalid", `The project folder ${root} can't be opened. Was it moved?`);
    }

    // Tools for this run.
    const tools: AgentTool[] = [...TOOLS];
    const extras = { scratch: !projectId, web: false, computer: false, images: false, memory: false };
    if (settings.webSearch) {
      tools.push(...webTools({ ...(settings.searxngUrl ? { searxngUrl: settings.searxngUrl } : {}), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }));
      // With web access the page builder finds and places photos itself; find_photos is for swapping one afterwards.
      const photos = { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(this.deps.resizeImage ? { resize: this.deps.resizeImage } : {}) };
      const kit = tools.findIndex((t) => t.name === "design_kit");
      if (kit >= 0) tools[kit] = designKitTool({ photos, ...(this.deps.measureReference ? { reference: this.deps.measureReference } : {}) });
      // The same for apps: the app kit fetches pictures for its sample rows.
      const appKit = tools.findIndex((t) => t.name === "app_kit");
      if (appKit >= 0) tools[appKit] = appKitTool({ photos });
      tools.push(...photoTools(photos));
      extras.web = true;
    }
    if (computer) {
      tools.push(...computerTools(await computer.driver()));
      extras.computer = true;
    }
    if (settings.imageGeneration && this.deps.media && (await this.deps.media.status()).state === "installed") {
      tools.push(...imageTools(this.deps.media.provider));
      extras.images = true;
    }

    if (!sessionId) sessionId = history.createSession({ ...(projectId ? { projectId } : {}), title: input.title?.trim() || titleFrom(text), model: settings.model }).id;
    const isNew = !input.sessionId;
    const run: ActiveRun = { runId: randomUUID(), sessionId, controller: new AbortController() };
    this.active = run;
    const ref: RunRef = { runId: run.runId, sessionId: run.sessionId };
    const status = (e: StatusBody) => this.deps.send.status({ ...ref, ...e });
    status({ type: "started" });

    // The task: text, links to the saved attachments (so history can show them), then the images.
    let task: string | ContentPart[] = text;
    if (images.length) {
      const refs = images.map((img, i) => `![${img.name ?? `image ${i + 1}`}](attachment:${this.saveAttachment(img.data, img.mediaType)})`);
      task = [{ type: "text", text: `${text}\n\n${refs.join("\n")}` }, ...images.map((img): ImagePart => ({ type: "image", mediaType: img.mediaType, data: img.data }))];
    }

    const model = (this.deps.createModel ?? defaultModel)(settings);
    // The recorder is wrapped to learn which messages are the user's turn and the final answer.
    const ids = { lastUser: undefined as string | undefined, lastAssistant: undefined as string | undefined };
    const recorder: SessionRecorder = {
      appendMessage: (sid, m) => {
        const msg = history.appendMessage(sid, m);
        if (m.role === "user") ids.lastUser = msg.id;
        if (m.role === "assistant") ids.lastAssistant = msg.id;
        return msg;
      },
      completeToolCall: (id, r) => history.completeToolCall(id, r),
    };
    let given: ContextItem[] = [];
    // Said by the app, not left to the model to work out: a named place is out of reach without a project.
    const placeNote = !projectId && NAMED_PLACE.test(text) ? SCRATCH_PLACE_NOTE : "";
    // A session in use again is not idle: its extraction waits for this run to end.
    this.cancelExtraction(run.sessionId);
    // Background jobs (docs downloads and embedding) wait while the model is busy with the user's task.
    this.deps.memory?.jobs.pause();
    if (projectId) this.prepareProject(projectId);
    // What this session made in earlier messages is its own to rebuild: in a scratch folder that is
    // everything there, in a project only the files it created.
    const madeEarlier = projectId ? this.madeBefore(run.sessionId) : await workspace.listFiles(5000).catch(() => []);
    void (async () => {
      const memory = await this.memoryFor(run.sessionId, projectId, text, () => ids.lastUser);
      given = memory.items;
      if (memory.tools.length) {
        tools.push(...memory.tools);
        extras.memory = true;
      }
      return runAgentTask({
        model,
        workspace,
        task,
        priorMessages,
        tools: tools.map((t) => this.keepImages(t)),
        promptExtras: extras,
        ...(memory.system || memory.task || placeNote
          ? { memory: { ...(memory.system ? { system: memory.system } : {}), ...(memory.task || placeNote ? { task: [memory.task, placeNote].filter(Boolean).join("\n\n") } : {}) } }
          : {}),
        ...(memory.recall ? { recall: memory.recall } : {}),
        approve: (req) => this.ask(run, req),
        history: { recorder, sessionId: run.sessionId },
        signal: run.controller.signal,
        ...(input.allowFailingChecks ? { allowFailingChecks: true } : {}),
        ...(input.readOnly ? { readOnly: true } : {}),
        madeEarlier,
        ...(settings.standards ? { standards: settings.standards } : {}),
        ...(this.deps.lookAtPage ? { lookAt: (page: string, signal?: AbortSignal) => this.deps.lookAtPage!(workspace.resolve(page), signal) } : {}),
        onEvent: (e) => {
          // A session started by this run gets the name the planner gave the task.
          if (e.type === "plan" && isNew && e.plan.title?.trim()) void history.renameSession(run.sessionId, e.plan.title.trim()).catch(() => undefined);
          this.forward(e, status);
        },
        ...this.deps.runOptions,
      });
    })()
      .then((outcome) => {
        if (projectId) this.rememberMade(run.sessionId, outcome.made);
        history.setStatus(run.sessionId, outcome.status === "done" ? "done" : "open");
        // Verified fixes in this run become episodes (summarized in the background, after the run).
        try {
          this.deps.memory?.learnFromSession(run.sessionId);
        } catch {
          // never fails a finished run
        }
        // Proposed memories: right away for a finished task, after 10 idle minutes otherwise.
        this.scheduleExtraction(run.sessionId, outcome.status === "done" ? 0 : (this.deps.extractionIdleMs ?? 10 * 60_000));
        if (this.deps.memory && ids.lastAssistant && given.length) {
          try {
            this.deps.memory.recordUse(ids.lastAssistant, given, outcome.message, run.sessionId);
          } catch {
            // a bookkeeping failure must never turn a finished task into an error
          }
        }
        // The run is over before anyone hears it finished, so a queued message can start right away.
        if (this.active?.runId === run.runId) this.active = undefined;
        status({ type: "finished", status: outcome.status, message: outcome.message });
      })
      .catch((err: unknown) => {
        if (this.active?.runId === run.runId) this.active = undefined;
        status({ type: "finished", status: "error", message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        for (const [id, p] of this.pending) {
          if (p.sessionId === run.sessionId) {
            p.resolve(false);
            this.pending.delete(id);
          }
        }
        if (this.active?.runId === run.runId) this.active = undefined;
        if (!this.active) this.deps.memory?.jobs.resume();
      });
    return ref;
  }

  async stop(runId: string): Promise<void> {
    if (this.active?.runId !== runId) return;
    this.active.controller.abort();
    // Unblock a run that is waiting on an approval.
    for (const [id, p] of this.pending) {
      if (p.sessionId === this.active.sessionId) {
        p.resolve(false);
        this.pending.delete(id);
      }
    }
  }

  async respond(requestId: string, decision: ApprovalDecision): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) throw new MemoryApiError("not_found", "That approval request is no longer open");
    this.pending.delete(requestId);
    // Every memory save is approved on its own: a blanket yes would let text the
    // model read later (a web page, a file) plant lasting "preferences".
    if (decision === "allow_session" && p.kind !== "memory") {
      const set = this.remembered.get(p.sessionId) ?? new Set<string>();
      // Commands are remembered by what they do (see command-scope.ts), or exactly when that
      // can't be told safely; screen, web and media actions by kind (every click differs).
      if (p.kind === "command" || p.kind === "check") rememberCommand(set, p.command);
      else set.add(`kind:${p.kind}`);
      this.remembered.set(p.sessionId, set);
    }
    p.resolve(decision !== "deny");
  }

  /**
   * Memory for one run: the session's always-on block, the recalled block for
   * this message, and the memory tools. Nothing at all when memory is missing
   * or switched off for the project. Never throws: a run without memory is
   * better than no run.
   */
  private async memoryFor(
    sessionId: string,
    projectId: string | undefined,
    text: string,
    userMessageId: () => string | undefined,
  ): Promise<{ system?: string; task?: string; items: ContextItem[]; tools: AgentTool[]; recall?: (errorOutput: string) => Promise<string | undefined> }> {
    const memory = this.deps.memory;
    const mode = memory?.projectMode(projectId);
    if (!memory || mode === "off") return { items: [], tools: [] };
    try {
      let always = this.alwaysOnBySession.get(sessionId);
      if (!always) {
        always = await memory.alwaysOn(projectId);
        this.alwaysOnBySession.set(sessionId, always);
      }
      const exclude = new Set(always.items.map((i) => `${i.ref.type}:${i.ref.id}`));
      const recalled = await memory.taskContext({ ...(projectId ? { projectId } : {}), text }, exclude);
      // Everything the model was shown, so citations of search results count too.
      const items: ContextItem[] = [...always.items, ...recalled.items];
      const shown = new Set(items.map((i) => i.handle));
      const tools = memoryTools({
        searchMemory: async (query) => {
          const found = await memory.taskContext({ ...(projectId ? { projectId } : {}), text: query }, exclude);
          for (const i of found.items) {
            if (!shown.has(i.handle)) {
              shown.add(i.handle);
              items.push(i);
            }
          }
          return found.text;
        },
        ...(projectId
          ? {
              searchDocs: async (query: string, library?: string) => {
                const hits = await memory.searchDocs({ projectId, query, ...(library ? { library } : {}), k: 3 });
                return hits
                  .map((h) => {
                    const ref = { ref: { type: "doc" as const, id: h.id }, handle: h.handle, kind: "doc", trust: "official", text: `${h.label} ${h.docsVersion} — ${h.heading}`, score: h.score, reasons: [`docs:${h.library}@${h.docsVersion}`], possiblyOutdated: h.possiblyOutdated, tokens: 0 };
                    if (!shown.has(h.handle)) {
                      shown.add(h.handle);
                      items.push(ref);
                    }
                    return `[${h.handle}] ${h.label} ${h.docsVersion} docs${h.possiblyOutdated ? " (possibly outdated for this project)" : ""} — ${h.heading}\n${h.url}\n${h.text}`;
                  })
                  .join("\n\n");
              },
            }
          : {}),
        searchHistory: async (query) => {
          try {
            // Only this project's sessions; in a scratch chat only other scratch chats.
            return this.deps.history
              .searchScoped({ query, ...(projectId ? { projectId } : {}), limit: 8 })
              .map((h) => `- ${new Date(h.createdAt).toISOString().slice(0, 10)} (session ${h.sessionId}): ${redactSecrets(h.snippet)}`)
              .join("\n");
          } catch {
            return "";
          }
        },
        remember: async (input) => {
          if (input.scope === "project" && !projectId) throw new Error("This session has no project; save it for all projects (scope global) instead.");
          const m = await memory.remember(
            { kind: input.kind, scope: input.scope, ...(input.scope === "project" ? { projectId: projectId! } : {}), key: input.key, body: input.body },
            { sessionId, ...(userMessageId() ? { messageId: userMessageId()! } : {}), ...(projectId ? { contextProjectId: projectId } : {}) },
          );
          return `Saved to memory as ${m.key}. It applies from the next session; don't cite it in this answer.`;
        },
      });
      // Fixes seen before for a failing check, each shown once per run.
      const recall = async (errorOutput: string) => {
        const found = await memory.errorRecall({ ...(projectId ? { projectId } : {}), errorOutput, task: text }, exclude);
        const fresh = found.filter((i) => !shown.has(i.handle));
        for (const i of fresh) {
          shown.add(i.handle);
          items.push(i);
        }
        return fresh.length ? fresh.map((i) => `- [${i.handle}] (${i.kind ?? i.ref.type}, ${i.trust ?? "verified"}) ${i.text}`).join("\n") : undefined;
      };
      return {
        ...(always.text ? { system: always.text } : {}),
        ...(recalled.text ? { task: recalled.text } : {}),
        recall,
        items,
        // A read-only project reads memory but never adds to it, not even globally.
        tools: mode === "read_only" ? tools.filter((t) => t.name !== "remember") : tools,
      };
    } catch {
      return { items: [], tools: [] };
    }
  }

  async computerPermissions(): Promise<ComputerPermissions> {
    return this.deps.computer ? this.deps.computer.permissions() : { screenRecording: false, accessibility: false };
  }

  async openPermissionSettings(which: keyof ComputerPermissions): Promise<void> {
    if (which !== "screenRecording" && which !== "accessibility") throw new MemoryApiError("invalid", "Unknown permission");
    await this.deps.computer?.openSettings(which);
  }

  async mediaStatus(): Promise<MediaStatusView> {
    return this.deps.media ? this.deps.media.status() : { state: "unsupported", detail: "Image generation needs a Mac with Apple Silicon." };
  }

  async installMedia(): Promise<MediaStatusView> {
    if (!this.deps.media) return this.mediaStatus();
    if (this.installing) throw new MemoryApiError("conflict", "The image module is already being installed");
    this.installing = true;
    try {
      const result = await this.deps.media.install((line) => this.deps.send.media?.(line));
      if (result.state === "installed" && !this.deps.settings.get().imageGeneration) {
        this.deps.settings.set({ ...this.deps.settings.get(), imageGeneration: true });
      }
      return result;
    } catch (err) {
      throw new MemoryApiError("unavailable", err instanceof Error ? err.message : String(err));
    } finally {
      this.installing = false;
    }
  }

  async readAttachment(name: string): Promise<string> {
    if (typeof name !== "string" || !ATTACHMENT_NAME.test(name)) throw new MemoryApiError("invalid", "Not an attachment name");
    const file = join(this.deps.attachmentsDir, name);
    if (!existsSync(file)) throw new MemoryApiError("not_found", "That attachment is gone");
    return `data:${MIME[name.split(".").pop()!]};base64,${readFileSync(file).toString("base64")}`;
  }

  /** Save an image under its content hash; returns the attachment name. */
  private saveAttachment(base64: string, mediaType: ImageAttachment["mediaType"]): string {
    const buf = Buffer.from(base64, "base64");
    const name = `${createHash("sha256").update(buf).digest("hex")}.${EXT[mediaType] ?? "png"}`;
    const file = join(this.deps.attachmentsDir, name);
    if (!existsSync(file)) {
      mkdirSync(this.deps.attachmentsDir, { recursive: true });
      writeFileSync(file, buf);
    }
    return name;
  }

  /** Images a tool returns (screenshots, generated pictures) are saved and linked from its history output. */
  private keepImages(tool: AgentTool): AgentTool {
    return {
      ...tool,
      run: async (args, ctx) => {
        const out = await tool.run(args, ctx);
        if (out.images?.length) {
          const refs = out.images.map((img, i) => `![${tool.name} ${i + 1}](attachment:${this.saveAttachment(img.data, img.mediaType)})`);
          out.output = `${out.output ?? out.content}\n\n${refs.join("\n")}`;
        }
        return out;
      },
    };
  }

  private ask(run: ActiveRun, req: ApprovalRequest): Promise<boolean> {
    if (run.controller.signal.aborted) return Promise.resolve(false);
    const allowed = this.remembered.get(run.sessionId);
    const isCommand = req.kind === "command" || req.kind === "check";
    if (isCommand ? commandAllowed(allowed, req.command) : allowed?.has(`kind:${req.kind}`)) return Promise.resolve(true);
    const requestId = randomUUID();
    const scopes = isCommand ? commandScopes(req.command) : undefined;
    return new Promise((resolve) => {
      this.pending.set(requestId, { sessionId: run.sessionId, command: req.command, kind: req.kind, resolve });
      this.deps.send.approval({
        runId: run.runId,
        sessionId: run.sessionId,
        requestId,
        kind: req.kind,
        command: req.command,
        cwd: req.cwd,
        ...(scopes ? { sessionScope: scopeLabel(scopes) } : {}),
      });
    });
  }

  private forward(e: AgentEvent, status: (e: StatusBody) => void): void {
    switch (e.type) {
      case "plan":
        status({ type: "plan", summary: e.plan.summary, steps: e.plan.steps });
        break;
      case "thinking":
        status({ type: "activity", text: "Thinking" });
        break;
      case "progress":
        // Only worth showing for a file being written; short replies stay "Thinking".
        if (e.path && e.lines && e.lines > 5) status({ type: "activity", text: `Writing ${e.path} · ${e.lines.toLocaleString("en")} lines so far` });
        break;
      case "tool_start":
        status({ type: "activity", text: describeActivity(e.name, e.args) });
        break;
      case "checks":
        status({
          type: "checks",
          passed: e.passed,
          results: e.runs.map((r) => ({ kind: r.check.kind, command: r.check.command, exitCode: r.exitCode })),
        });
        break;
      default:
        // Messages and tool results reach the UI through history updates.
        break;
    }
  }
}

function defaultModel(settings: StoredSettings): ChatModel {
  return createOpenAiCompatibleModel({
    baseUrl: settings.modelBaseUrl,
    model: settings.model,
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
  });
}

/** Earlier turns for the model: the summary, then user and assistant text (tool traffic stays in history). */
function toChatMessages(summary: string | undefined, messages: { role: string; content: string }[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (summary) out.push({ role: "system", content: `Summary of earlier work in this session: ${summary}` });
  for (const m of messages) {
    if (!m.content.trim()) continue;
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content });
  }
  return out;
}

export function titleFrom(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim().replace(/\s+/g, " ") ?? "New session";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}
