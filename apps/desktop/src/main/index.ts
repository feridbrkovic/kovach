import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BlobStore,
  createGitDocsFetcher,
  createHistoryStore,
  createMemoryStore,
  createOpenAiEmbedder,
  type Db,
  type MemoryStore,
  migrate,
  type Summarizer,
  type Extractor,
  redactSecrets,
  openDatabase,
} from "@kovach-dev/memory-service";
import { createMacDriver, hasCliclick, webFetch } from "@kovach-dev/agent";
import { lookAtPage } from "./page-look";
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, type MenuItemConstructorOptions, safeStorage, shell, systemPreferences } from "electron";
import { CHANNELS } from "../shared/ipc";
import { serveAgent } from "./agent-ipc";
import { AgentService, type ComputerHost, createFileSettingsStore, type MediaHost } from "./agent-service";
import { createFixSummarizer, createMemoryExtractor, settingsModel } from "./fix-summarizer";
import { createMfluxProvider, installMedia, mediaStatus } from "./media";
import { formatBytes, freeScratchSpace, removeScratch, scratchUsage } from "./scratch-space";
import { loadLoginShellPath } from "./shell-path";
import { getLoadablePath } from "sqlite-vec";
import { combineApi, serveHistory } from "./history-ipc";
import { matchModel } from "../shared/agent";
import { MIGRATIONS } from "./migrations";
import { evalLaunch, evalsRoot, runEvals } from "./dev-evals";

const APP_NAME = "Local Kovach";
/** embeddinggemma 300M, quantized for MLX: small next to the chat model (MASTER_PLAN › Read path). */
const DEFAULT_EMBEDDING_MODEL = "embeddinggemma-300m-6bit";
app.setName(APP_NAME);
// ~/Library/Application Support/Local Kovach (MASTER_PLAN.md › Data model).
app.setPath("userData", join(app.getPath("appData"), APP_NAME));

let db: Db | undefined;
let stopServing: (() => void) | undefined;
let agent: AgentService | undefined;
let memoryStore: MemoryStore | undefined;
let fixSummarizer: Summarizer | undefined;
let memoryExtractor: Extractor | undefined;
let evalSettings: ReturnType<typeof createFileSettingsStore> | undefined;
let evalsRunning = false;

const broadcast = (channel: string, value: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, value);
};

/** better-sqlite3 built for this Electron version (`pnpm native` writes it; the DMG keeps it in Resources). */
function nativeBinding(): string | undefined {
  const path = app.isPackaged
    ? join(process.resourcesPath, "native", "better_sqlite3.node")
    : join(app.getAppPath(), "native", "better_sqlite3.node");
  return existsSync(path) ? path : undefined;
}

/** SQLite can't load an extension from inside app.asar; the packaged app uses the unpacked copy. */
function vecExtension(): string | undefined {
  if (!app.isPackaged) return undefined; // in development sqlite-vec finds it in node_modules
  return getLoadablePath().replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/** Screen control on macOS: screencapture plus cliclick or System Events, behind the two privacy permissions. */
function macComputer(): ComputerHost | undefined {
  if (process.platform !== "darwin") return undefined;
  const panes = {
    screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  } as const;
  return {
    driver: async () => createMacDriver({ hasCliclick: await hasCliclick() }),
    permissions: async () => ({
      screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    }),
    openSettings: async (which) => {
      // Asking once puts Local Kovach in the list, so the user only has to flip the switch.
      if (which === "screenRecording") await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
      else systemPreferences.isTrustedAccessibilityClient(true);
      await shell.openExternal(panes[which]);
    },
  };
}

/** Image generation with mflux + FLUX.2 klein, in an environment the app manages (Apple Silicon only). */
function macMedia(dataDir: string): MediaHost | undefined {
  if (process.platform !== "darwin" || process.arch !== "arm64") return undefined;
  const status = async () => {
    const s = await mediaStatus(dataDir);
    return s.state === "installed"
      ? { state: "installed" as const, modelDownloaded: !!s.modelDownloaded, ...(s.mfluxVersion ? { detail: `mflux ${s.mfluxVersion}` } : {}) }
      : { state: "not_installed" as const, ...(s.pythonFound ? {} : { detail: "Needs Python 3.11+ or uv (brew install uv)." }) };
  };
  return {
    status,
    install: async (onLine) => {
      await installMedia(dataDir, onLine);
      return status();
    },
    provider: createMfluxProvider(dataDir),
  };
}

/** Connects memory to the embedding model; run after the window has shown (see openMemory). */
let startEmbedder: (() => void) | undefined;

function openMemory(): void {
  const dataDir = app.getPath("userData");
  const binding = nativeBinding();
  const vec = vecExtension();
  db = openDatabase(join(dataDir, "kovach.db"), { ...(binding ? { nativeBinding: binding } : {}), ...(vec ? { vecExtension: vec } : {}) });
  migrate(db, MIGRATIONS);
  // Tool output (command output, files the agent read) is stored with secrets masked (T8).
  const history = createHistoryStore(db, { blobs: new BlobStore(dataDir), redactOutput: redactSecrets });
  const memory = createMemoryStore(db, {
    defaultEmbeddingModel: DEFAULT_EMBEDDING_MODEL,
    // Docs packs are read from each library's own repo with git (on the login-shell PATH).
    docsFetcher: () => {
      mkdirSync(join(dataDir, "tmp"), { recursive: true });
      return createGitDocsFetcher({ tmp: join(dataDir, "tmp") });
    },
    // Verified fixes are summarized by the local model, in the background (the settings store exists by then).
    summarizer: () => fixSummarizer,
    // Proposed memories from finished sessions, also from the local model; they wait in Review.
    extractor: () => memoryExtractor,
  });
  memoryStore = memory;
  // Settings changes that affect embeddings (model id) rebuild the embedder and re-index.
  const memoryApi = {
    ...memory,
    updateSettings: async (patch: Parameters<MemoryStore["updateSettings"]>[0]) => {
      const s = await memory.updateSettings(patch);
      if (patch.embeddingModel !== undefined) void refreshEmbedder();
      return s;
    },
  };
  const historyApi = combineApi(history, memoryApi);
  const deleteSession = historyApi.deleteSession;
  // A deleted session takes its scratch folder (and any packages installed there) with it.
  historyApi.deleteSession = async (id) => {
    const result = await deleteSession(id);
    removeScratch(join(dataDir, "scratch"), id);
    return result;
  };
  const stopHistory = serveHistory(ipcMain, historyApi, (e) => broadcast(CHANNELS.change, e));

  const settingsStore = createFileSettingsStore(
    join(dataDir, "settings.json"),
    safeStorage.isEncryptionAvailable()
      ? {
          encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
          decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, "base64")),
        }
      : undefined,
  );
  evalSettings = settingsStore;

  /**
   * Point the memory store at the embedding model on the same server as the chat
   * model, using the server's own spelling of its name, then embed what isn't yet.
   * Without a reachable model, retrieval simply stays on keyword search.
   */
  let embedderGeneration = 0;
  const refreshEmbedder = async () => {
    const gen = ++embedderGeneration;
    const { modelBaseUrl, apiKey } = settingsStore.get();
    const wanted = (await memory.getSettings()).embeddingModel;
    let model = wanted;
    try {
      const res = await fetch(`${modelBaseUrl}/models`, {
        signal: AbortSignal.timeout(4000),
        ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      });
      if (res.ok) {
        const ids = ((await res.json()) as { data?: { id?: string }[] }).data?.map((m) => m.id ?? "").filter(Boolean) ?? [];
        model = matchModel(wanted, ids) ?? model;
      }
    } catch {
      // the server may be starting; try with the name as given
    }
    if (gen !== embedderGeneration) return;
    memory.setEmbedder(createOpenAiEmbedder({ baseUrl: modelBaseUrl, model, ...(apiKey ? { apiKey } : {}) }));
    const r = await memory.reindex();
    if (gen !== embedderGeneration) return;
    console.log(
      r.error
        ? `[memory] semantic search off (${model}: ${r.error}); using keyword search`
        : `[memory] semantic search on with ${model}${r.embedded ? `, embedded ${r.embedded}` : ""}`,
    );
  };
  // Started once the window is up: reading the API key can raise a Keychain prompt (the first
  // launch of a newly installed build), which blocks until answered and must not hide the app.
  // Background jobs wait too: a queued fix summary or extraction calls the model, which needs the key.
  startEmbedder = () => {
    void refreshEmbedder();
    memory.jobs.start();
  };
  fixSummarizer = createFixSummarizer(settingsModel(() => settingsStore.get()));
  memoryExtractor = createMemoryExtractor(settingsModel(() => settingsStore.get()));
  // Research findings are re-checked against their pages when due: shortly after start, then every 6 hours.
  const recheck = () =>
    void memory.revalidateResearch((url, signal) => webFetch(url, {}, signal).then((r) => `${r.title}\n${r.text}`)).catch(() => undefined);
  setTimeout(recheck, 2 * 60_000);
  setInterval(recheck, 6 * 3600_000);

  agent = new AgentService({
    history,
    memory,
    onSettingsChanged: () => void refreshEmbedder(),
    settings: settingsStore,
    send: {
      status: (e) => broadcast(CHANNELS.agentStatus, e),
      approval: (p) => broadcast(CHANNELS.agentApproval, p),
      media: (line) => broadcast(CHANNELS.agentMedia, line),
    },
    scratchDir: join(dataDir, "scratch"),
    attachmentsDir: join(dataDir, "attachments"),
    ...(macComputer() ? { computer: macComputer()! } : {}),
    ...(macMedia(dataDir) ? { media: macMedia(dataDir)! } : {}),
    lookAtPage,
    // Stock photos arrive at camera size; pages need them at screen size.
    resizeImage: async (image, maxWidth) => {
      const picture = nativeImage.createFromBuffer(image);
      if (picture.isEmpty()) return undefined;
      const { width } = picture.getSize();
      const scaled = width > maxWidth ? picture.resize({ width: maxWidth, quality: "best" }) : picture;
      const size = scaled.getSize();
      return { data: scaled.toJPEG(82), width: size.width, height: size.height };
    },
    openFile: async (path) => {
      const failed = await shell.openPath(path);
      if (failed) throw new Error(failed);
    },
    showFolder: async (path) => {
      const failed = await shell.openPath(path);
      if (failed) throw new Error(failed);
    },
    pickFolder: async (title) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      // Saving a session's files starts on the Desktop, not wherever the last dialog happened to be.
      const options = {
        title: title ?? "Choose a project folder",
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
        ...(title ? { defaultPath: app.getPath("desktop"), buttonLabel: "Save here" } : {}),
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  const stopAgent = serveAgent(ipcMain, agent);
  stopServing = () => {
    stopHistory();
    stopAgent();
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: APP_NAME,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#16181D",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // Links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  return win;
}

/** Developer › Run Evals: the eval set against the model in Settings, report in logs/evals (development only). */
function runEvalsFromMenu(root: string): void {
  const settings = evalSettings?.get();
  if (!settings) return;
  if (evalsRunning) {
    void dialog.showMessageBox({ type: "info", message: "Evals are already running.", detail: "The report goes to logs/evals/latest.md when they finish." });
    return;
  }
  evalsRunning = true;
  const launch = evalLaunch(root, settings);
  runEvals(launch, (r) => {
    evalsRunning = false;
    void dialog
      .showMessageBox({
        type: r.code === 0 ? "info" : "error",
        message: r.code === 0 ? "Evals finished" : "Evals failed",
        detail: [...r.summary, ...(r.error ? [r.error] : []), "", r.code === 0 ? `Report: ${launch.report}` : `Log: ${launch.log}`].join("\n"),
        buttons: r.code === 0 ? ["Open Report", "Close"] : ["Close"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (r.code === 0 && response === 0) void shell.openPath(launch.report);
      });
  });
}

/** File › Free Up Space: removes installed packages and build output from the sessions' scratch folders. */
async function freeUpSpaceFromMenu(): Promise<void> {
  const root = join(app.getPath("userData"), "scratch");
  const usage = scratchUsage(root);
  if (usage.regrowableBytes === 0) {
    await dialog.showMessageBox({ message: "Nothing to free", detail: `Sessions without a project use ${formatBytes(usage.bytes)} in ${usage.sessions} folders, none of it installed packages or build output.` });
    return;
  }
  const answer = await dialog.showMessageBox({
    type: "question",
    message: `Free ${formatBytes(usage.regrowableBytes)}?`,
    detail: `Sessions without a project use ${formatBytes(usage.bytes)} in ${usage.sessions} folders. ${formatBytes(usage.regrowableBytes)} of that is installed packages and build output, which come back with an install or a build. The files the sessions wrote stay.`,
    buttons: ["Remove", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer.response !== 0) return;
  const active = await agent?.activeRun();
  const freed = freeScratchSpace(root, active?.sessionId);
  await dialog.showMessageBox({ message: `Freed ${formatBytes(freed.freedBytes)}`, detail: active ? "The session that is running was left alone." : "" });
}

function installMenu(): void {
  const root = app.isPackaged ? undefined : evalsRoot(app.getAppPath());
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { label: "File", submenu: [{ label: "Free Up Space…", click: () => void freeUpSpaceFromMenu() }, { type: "separator" }, { role: "close" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(root
      ? [{ label: "Developer", submenu: [{ label: "Run Evals", click: () => runEvalsFromMenu(root) }] } satisfies MenuItemConstructorOptions]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Started from Finder or the Dock, the app gets a bare PATH; take the user's shell PATH so
  // node, pnpm, git and Homebrew tools work in the agent's commands.
  if (process.platform === "darwin") process.env.PATH = await loadLoginShellPath();
  try {
    openMemory();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = /NODE_MODULE_VERSION|was compiled against a different Node.js version/.test(message)
      ? "\n\nThe database driver is built for Node, not Electron. Run `pnpm --filter @kovach-dev/desktop native` and start again."
      : "";
    dialog.showErrorBox(`${APP_NAME} could not open its database`, message + hint);
    app.exit(1);
    return;
  }
  installMenu();
  const win = createWindow();
  win.once("ready-to-show", () => {
    const start = startEmbedder;
    startEmbedder = undefined;
    // After the first paint, so a Keychain prompt appears over a visible window.
    if (start) setTimeout(start, 1500);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  memoryStore?.jobs.stop();
  void agent?.activeRun().then((run) => run && agent?.stop(run.runId));
  stopServing?.();
  db?.close();
});
