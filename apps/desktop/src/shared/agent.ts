import type { Schedule } from "./schedule";
/** Types shared by the main process and the renderer for running the agent. */

export interface AgentSettings {
  /** OpenAI-compatible endpoint of the local model server (oMLX by default). */
  modelBaseUrl: string;
  model: string;
  /** Let the agent search the web and read pages. */
  webSearch: boolean;
  /** SearXNG base URL; empty uses the keyless fallback. */
  searxngUrl: string;
  /** Allow computer use at all. Each run still has to opt in. */
  computerUse: boolean;
  /** Let the agent generate images (needs the image module installed). */
  imageGeneration: boolean;
  /** The user's own engineering standards, in their words; the planner applies them before the built-in ones. */
  standards: string;
}

export const MAX_STANDARDS_CHARS = 6000;

/** What the main process keeps: the settings plus the server's API key, if it needs one. */
export interface StoredSettings extends AgentSettings {
  apiKey?: string;
}

/** What the window sees. The key itself never leaves the main process. */
export interface SettingsView extends AgentSettings {
  hasApiKey: boolean;
}

/**
 * What the window sends. Fields left out keep their saved value.
 * `apiKey`: omit to keep the saved key, "" to remove it.
 */
export type SettingsInput = Partial<AgentSettings> & { apiKey?: string };

export const DEFAULT_SETTINGS: AgentSettings = {
  modelBaseUrl: "http://127.0.0.1:8000/v1",
  model: "Qwen3.6-35B-A3B-4bit",
  webSearch: true,
  searxngUrl: "",
  computerUse: false,
  imageGeneration: false,
  standards: "",
};

/**
 * Finds the server's id for the model the user asked for. Servers name the same
 * model differently ("Qwen3.6-35B-A3B-4bit", "mlx-community/Qwen3.6-35B-A3B-4bit"),
 * so this ignores case and the organisation prefix. Undefined unless exactly one fits.
 */
export function matchModel(wanted: string, available: readonly string[]): string | undefined {
  if (available.includes(wanted)) return wanted;
  const norm = (id: string) => id.trim().toLowerCase().split("/").pop() ?? "";
  const target = norm(wanted);
  const hits = available.filter((id) => norm(id) === target);
  return hits.length === 1 ? hits[0] : undefined;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

/** An image the user pasted, dropped or picked. Base64 without the data: prefix. */
export interface ImageAttachment {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  name?: string;
}

export interface StartInput {
  text: string;
  /** Continue this session; omit to start a new one in `projectId`, or without a project. */
  sessionId?: string;
  /** Omit for a session without a project: the agent gets a private scratch folder. */
  projectId?: string;
  images?: ImageAttachment[];
  /** Let this run see and control the screen (only when computer use is on in settings). */
  computerUse?: boolean;
  /** The user's override: allow finishing while checks are red. */
  allowFailingChecks?: boolean;
  /** Title for a new session (automations name theirs). */
  title?: string;
  /** Look and report only: tools that change files or run commands are left out. */
  readOnly?: boolean;
}

/** A task that starts by itself on a schedule. Every run is an ordinary session in the history. */
export interface Automation {
  id: string;
  name: string;
  /** What to do, as the user would write it in the message box. */
  prompt: string;
  /** Runs in this project, or without one (a private scratch folder per run). */
  projectId?: string;
  schedule: Schedule;
  enabled: boolean;
  /** The first run only looks and reports what it would do; real runs start after it. */
  dryRunDone: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRun?: { at: number; sessionId: string; dryRun: boolean; status: RunFinalStatus | "running"; message?: string };
}

export interface AutomationInput {
  id?: string;
  name: string;
  prompt: string;
  projectId?: string;
  schedule: Schedule;
  enabled?: boolean;
}

export interface AutomationsView {
  /** The kill switch: no automation starts while this is on. */
  paused: boolean;
  items: Automation[];
}

export interface ComputerPermissions {
  screenRecording: boolean;
  accessibility: boolean;
}

export interface MediaStatusView {
  state: "not_installed" | "installed" | "unsupported";
  modelDownloaded?: boolean;
  detail?: string;
}

export interface RunRef {
  runId: string;
  sessionId: string;
}

export type ApprovalDecision = "allow" | "allow_session" | "deny";

export interface ApprovalPrompt {
  runId: string;
  sessionId: string;
  requestId: string;
  kind: "command" | "check" | "computer" | "web" | "media" | "memory";
  command: string;
  cwd: string;
  /** For commands: what a session-wide yes would cover, e.g. "npx expo lint …". Absent when only this exact command would be remembered. */
  sessionScope?: string;
}

export interface PlanStep {
  title: string;
  files: string[];
}

export type RunFinalStatus = "done" | "done_with_failing_checks" | "checks_failed" | "max_turns" | "aborted" | "error";

export type AgentStatusEvent = RunRef &
  (
    | { type: "started" }
    | { type: "plan"; summary: string; steps: PlanStep[] }
    | { type: "activity"; text: string }
    | { type: "checks"; passed: boolean; results: { kind: string; command: string; exitCode: number }[] }
    | { type: "finished"; status: RunFinalStatus; message: string }
  );

/** A status event without its run reference (distributes over the union). */
export type StatusBody = AgentStatusEvent extends infer E ? (E extends unknown ? Omit<E, "runId" | "sessionId"> : never) : never;

export interface ModelCheck {
  ok: boolean;
  message: string;
  models?: string[];
  /** The model id now saved, when the check corrected the name to the server's spelling. */
  model?: string;
}

/** What a session without a project has made in its private folder. */
export interface SessionFiles {
  count: number;
  /** The first few paths, relative to that folder. */
  names: string[];
  /** A web page among them to open in the browser (index.html when there is one). */
  page?: string;
}

/** Everything the renderer can ask of the agent side. */
export interface AgentApi {
  getSettings(): Promise<SettingsView>;
  saveSettings(settings: SettingsInput): Promise<SettingsView>;
  checkModel(): Promise<ModelCheck>;
  listProjects(): Promise<ProjectInfo[]>;
  /** Opens a folder picker; undefined when the user cancels. */
  addProject(): Promise<ProjectInfo | undefined>;
  /** Files a session without a project made (it can only write in its own private folder). */
  sessionFiles(sessionId: string): Promise<SessionFiles>;
  /** Opens the session's web page (SessionFiles.page) in the default browser. */
  openSessionPage(sessionId: string): Promise<void>;
  /** Shows that folder in Finder. */
  showSessionFiles(sessionId: string): Promise<void>;
  /** Copies the files into a new folder inside one the user picks; undefined when they cancel. */
  saveSessionFiles(sessionId: string): Promise<{ path: string; copied: number } | undefined>;
  start(input: StartInput): Promise<RunRef>;
  stop(runId: string): Promise<void>;
  respond(requestId: string, decision: ApprovalDecision): Promise<void>;
  activeRun(): Promise<RunRef | undefined>;
  computerPermissions(): Promise<ComputerPermissions>;
  /** Open the System Settings pane where the user grants a permission. */
  openPermissionSettings(which: keyof ComputerPermissions): Promise<void>;
  mediaStatus(): Promise<MediaStatusView>;
  /** Install the image module; progress arrives through onMediaProgress. */
  installMedia(): Promise<MediaStatusView>;
  /** An attachment saved with a message, as a data: URL for display. */
  readAttachment(name: string): Promise<string>;
  onStatus(cb: (e: AgentStatusEvent) => void): () => void;
  onApproval(cb: (p: ApprovalPrompt) => void): () => void;
  /** Output lines while the image module installs. */
  onMediaProgress(cb: (line: string) => void): () => void;
  /** The app asks to show a session (a notification was clicked). */
  onOpenSession(cb: (sessionId: string) => void): () => void;
  listAutomations(): Promise<AutomationsView>;
  saveAutomation(input: AutomationInput): Promise<Automation>;
  deleteAutomation(id: string): Promise<void>;
  /** Start one now; a dry run only looks and reports. */
  runAutomation(id: string, options?: { dryRun?: boolean }): Promise<RunRef>;
  setAutomationsPaused(paused: boolean): Promise<AutomationsView>;
}

export const AGENT_METHODS = [
  "listAutomations",
  "saveAutomation",
  "deleteAutomation",
  "runAutomation",
  "setAutomationsPaused",
  "getSettings",
  "saveSettings",
  "checkModel",
  "listProjects",
  "addProject",
  "sessionFiles",
  "showSessionFiles",
  "openSessionPage",
  "saveSessionFiles",
  "start",
  "stop",
  "respond",
  "activeRun",
  "computerPermissions",
  "openPermissionSettings",
  "mediaStatus",
  "installMedia",
  "readAttachment",
] as const;
export type AgentMethod = (typeof AGENT_METHODS)[number];

export function isAgentMethod(value: unknown): value is AgentMethod {
  return typeof value === "string" && (AGENT_METHODS as readonly string[]).includes(value);
}

/** A short line for the status bar, from a tool the agent is starting. */
export function describeActivity(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "list_files":
      return "Looking through the project files";
    case "read_file":
      return `Reading ${str("path")}`;
    case "search":
      return `Searching for ${str("pattern")}`;
    case "edit_file":
      return `Editing ${str("path")}`;
    case "create_file":
      return `Creating ${str("path")}`;
    case "insert_lines":
      return `Editing ${str("path")}`;
    case "run_command":
      return `Running ${str("command")}`;
    case "run_checks":
      return "Running checks";
    case "web_search":
      return `Searching the web for ${str("query")}`;
    case "fetch_page":
      return `Reading ${str("url")}`;
    case "computer_screenshot":
      return "Looking at the screen";
    case "computer_read_screen":
      return "Reading the screen";
    case "computer_open_app":
      return `Opening ${str("name")}`;
    case "computer_drag":
      return `Dragging${str("note") ? ` ${str("note")}` : ""}`;
    case "computer_click":
      return `Clicking${str("note") ? ` ${str("note")}` : ""}`;
    case "computer_type":
      return "Typing";
    case "computer_key":
      return `Pressing ${str("combo")}`;
    case "computer_scroll":
      return "Scrolling";
    case "find_symbol":
      return `Finding ${str("name")}`;
    case "find_references":
      return `Finding uses of ${str("name")}`;
    case "diagnostics":
      return "Checking for errors";
    case "look_at_page":
      return `Looking at ${str("path")} in a browser`;
    case "self_review":
      return "Reviewing the change";
    case "search_memory":
      return `Searching memory for ${str("query")}`;
    case "search_docs":
      return `Searching the docs for ${str("query")}`;
    case "search_history":
      return `Searching earlier sessions for ${str("query")}`;
    case "remember":
      return `Saving to memory: ${str("key")}`;
    case "generate_image":
      return `Generating ${str("path") || "an image"}`;
    default:
      return `Using ${name}`;
  }
}
