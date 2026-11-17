/**
 * Opt-in desktop computer use for macOS (MASTER_PLAN › Browser, device &
 * computer use, level 3). The main vision model both plans and reads the
 * screen. It gets two views of it:
 *
 * - `computer_read_screen` lists the frontmost window's controls from the
 *   accessibility tree, each with an id. Clicking by id is exact, so this is
 *   the preferred way to act.
 * - `computer_screenshot` shows the pixels, for layout and visual content.
 *   Every screenshot maps onto a fixed 1000-unit grid the model points into.
 *
 * All positions are in screen points (what macOS mouse events use), not
 * Retina pixels: `screencapture` images are twice the size on a Retina display.
 * Mouse and keyboard use `cliclick` when it is installed and otherwise
 * CoreGraphics events and System Events through JXA, which need Accessibility
 * permission. Every action is gated by the same Approver the shell tools use.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ImagePart } from "./model.js";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

const run = promisify(execFile);
const GRID = 1000; // the coordinate space the model uses on every screenshot
const SHOT_WIDTH = 1280; // screenshots are scaled down to this width for the model

/** Size of the main display in screen points (the unit click() takes). */
export interface Screen {
  width: number;
  height: number;
}

/** One accessibility element as the driver reads it, in screen points. */
export interface RawUiElement {
  role: string;
  name?: string | null;
  description?: string | null;
  value?: unknown;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled?: boolean | null;
}

export interface UiSnapshot {
  app: string;
  window?: string | null;
  elements: RawUiElement[];
  truncated?: boolean;
}

export interface ComputerDriver {
  screenSize(): Promise<Screen>;
  screenshot(): Promise<ImagePart>;
  click(x: number, y: number, button: "left" | "right", count: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>;
  scroll(x: number, y: number, dy: number): Promise<void>;
  /** The frontmost window's accessibility elements. Optional: without it, only screenshots. */
  readUi?(): Promise<UiSnapshot>;
  /** Open (or bring forward) an app by name. */
  openApp?(name: string): Promise<void>;
}

const clampGrid = (u: number) => Math.max(0, Math.min(GRID, u));
const toPoints = (u: number, size: number) => Math.round((clampGrid(u) / GRID) * size);
const toGrid = (p: number, size: number) => Math.round((p / size) * GRID);

// ---------------------------------------------------------------------------
// Reading the accessibility tree
// ---------------------------------------------------------------------------

/** Roles worth showing even without a label; everything else needs one. */
const ACTIONABLE = new Set([
  "AXButton",
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXSecureTextField",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXMenuButton",
  "AXComboBox",
  "AXLink",
  "AXSlider",
  "AXIncrementor",
  "AXTabButton",
  "AXDisclosureTriangle",
  "AXColorWell",
]);
/** Containers that only add noise unless they carry a label. */
const STRUCTURAL = new Set(["AXGroup", "AXScrollArea", "AXSplitGroup", "AXSplitter", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXScrollBar", "AXValueIndicator", "AXToolbar", "AXList", "AXOutline", "AXTable", "AXColumn", "AXBrowser"]);

export interface UiItem {
  id: number;
  role: string;
  label: string;
  /** Centre and size in grid units. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  disabled: boolean;
  /** Centre in screen points, for clicking. */
  px: number;
  py: number;
}

const MAX_ITEMS = 150;

const labelOf = (e: RawUiElement): string => {
  const parts = [e.name, e.description, typeof e.value === "string" || typeof e.value === "number" ? String(e.value) : undefined]
    .map((s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const text = unique.join(" — ");
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/** Pick the elements worth showing the model, give them ids and grid positions. */
export function uiItems(snapshot: UiSnapshot, screen: Screen): UiItem[] {
  const out: UiItem[] = [];
  const seen = new Set<string>();
  for (const e of snapshot.elements) {
    if (!(e.w > 1 && e.h > 1)) continue;
    const cxp = e.x + e.w / 2;
    const cyp = e.y + e.h / 2;
    if (cxp < 0 || cyp < 0 || cxp > screen.width || cyp > screen.height) continue; // off the main display
    const label = labelOf(e);
    if (!label && !ACTIONABLE.has(e.role)) continue;
    if (STRUCTURAL.has(e.role) && !label) continue;
    if (e.role === "AXStaticText" && !label) continue;
    const key = `${e.role}|${label}|${Math.round(cxp)}|${Math.round(cyp)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: out.length + 1,
      role: e.role.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
      label,
      cx: toGrid(cxp, screen.width),
      cy: toGrid(cyp, screen.height),
      w: toGrid(e.w, screen.width),
      h: toGrid(e.h, screen.height),
      disabled: e.enabled === false,
      px: Math.round(cxp),
      py: Math.round(cyp),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export function formatUi(snapshot: UiSnapshot, items: UiItem[], cut: boolean): string {
  const head = `${snapshot.app}${snapshot.window ? ` — "${snapshot.window}"` : ""}: ${items.length} elements${cut ? " (list cut short; take a screenshot for the rest)" : ""}.`;
  const lines = items.map((i) => `[${i.id}] ${i.role}${i.label ? ` "${i.label.replace(/"/g, "'")}"` : ""} at ${i.cx},${i.cy}${i.disabled ? " (disabled)" : ""}`);
  return [head, ...lines, "Click an element with computer_click {element: id}. Ids are only valid until the screen changes."].join("\n");
}

// ---------------------------------------------------------------------------
// macOS driver
// ---------------------------------------------------------------------------

async function jxa(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
  return stdout.trim();
}

const SCREEN_SIZE_JXA = `ObjC.import("AppKit");
function run() {
  const f = $.NSScreen.mainScreen.frame;
  return JSON.stringify({ width: f.size.width, height: f.size.height });
}`;

/**
 * Walk the frontmost window level by level. Chained element specifiers
 * (win.uiElements.uiElements…) fetch a whole level per property in one Apple
 * Event, which is far faster than asking element by element.
 */
export const READ_UI_JXA = `function run() {
  const se = Application("System Events");
  const procs = se.applicationProcesses.whose({ frontmost: true });
  if (procs.length === 0) return JSON.stringify({ app: "", elements: [] });
  const p = procs[0];
  const out = { app: p.name(), window: null, elements: [], truncated: false };
  if (p.windows.length === 0) return JSON.stringify(out);
  const w = p.windows[0];
  try { out.window = w.name(); } catch (e) {}
  const flat = (a, levels) => {
    let r = a;
    for (let i = 0; i < levels; i++) r = [].concat.apply([], r.map((x) => (Array.isArray(x) ? x : [x])));
    return r;
  };
  let spec = w.uiElements;
  for (let depth = 1; depth <= 12; depth++) {
    let roles;
    try { roles = flat(spec.role(), depth - 1); } catch (e) { break; }
    if (roles.length === 0) break;
    if (roles.length > 1500) { out.truncated = true; break; }
    const get = (f) => { try { return flat(f(), depth - 1); } catch (e) { return []; } };
    const names = get(() => spec.name());
    const descs = get(() => spec.description());
    const values = get(() => spec.value());
    const enabled = get(() => spec.enabled());
    const pos = get(() => spec.position());
    const size = get(() => spec.size());
    for (let i = 0; i < roles.length; i++) {
      const p0 = pos[i], s0 = size[i];
      if (!p0 || !s0) continue;
      const v = values[i];
      out.elements.push({
        role: roles[i], name: names[i] == null ? null : String(names[i]), description: descs[i] == null ? null : String(descs[i]),
        value: typeof v === "string" || typeof v === "number" ? v : null, enabled: enabled[i] == null ? null : !!enabled[i],
        x: p0[0], y: p0[1], w: s0[0], h: s0[1],
      });
    }
    if (out.elements.length > 3000) { out.truncated = true; break; }
    spec = spec.uiElements;
  }
  return JSON.stringify(out);
}`;

/** Mouse events through CoreGraphics, for Macs without cliclick. Coordinates in points. */
const MOUSE_JXA = `ObjC.import("CoreGraphics");
function run(argv) {
  const a = JSON.parse(argv[0]);
  const pt = (x, y) => $.CGPointMake(x, y);
  const post = (type, x, y, button, clicks) => {
    const e = $.CGEventCreateMouseEvent($(), type, pt(x, y), button);
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState
    $.CGEventPost(0, e); // kCGHIDEventTap
  };
  const pause = () => delay(0.05);
  if (a.op === "move") post(5, a.x, a.y, 0);
  if (a.op === "click") {
    const right = a.button === "right";
    for (let n = 1; n <= a.count; n++) {
      post(right ? 3 : 1, a.x, a.y, right ? 1 : 0, n);
      post(right ? 4 : 2, a.x, a.y, right ? 1 : 0, n);
      if (n < a.count) pause();
    }
  }
  if (a.op === "drag") {
    post(5, a.x, a.y, 0);
    post(1, a.x, a.y, 0, 1);
    const steps = 12;
    for (let i = 1; i <= steps; i++) { pause(); post(6, a.x + ((a.tx - a.x) * i) / steps, a.y + ((a.ty - a.y) * i) / steps, 0); }
    post(2, a.tx, a.ty, 0, 1);
  }
  if (a.op === "scroll") {
    post(5, a.x, a.y, 0);
    const lines = -a.dy; // positive wheel values scroll up
    const e = $.CGEventCreateScrollWheelEvent2($(), 1, 1, lines, 0, 0); // kCGScrollEventUnitLine
    $.CGEventPost(0, e);
  }
  return "ok";
}`;

async function osascript(script: string): Promise<void> {
  await run("osascript", ["-e", script]);
}
const asAppleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const KEYCODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};
export function systemEventsKey(combo: string): string {
  const parts = combo.toLowerCase().replace(/\s+/g, "").split("+");
  const key = parts.pop()!;
  const mods = parts
    .map((p) => ({ cmd: "command down", command: "command down", ctrl: "control down", control: "control down", alt: "option down", opt: "option down", option: "option down", shift: "shift down" })[p])
    .filter(Boolean);
  const using = mods.length ? ` using {${mods.join(", ")}}` : "";
  if (key in KEYCODES) return `tell application "System Events" to key code ${KEYCODES[key]}${using}`;
  return `tell application "System Events" to keystroke ${asAppleScriptString(key)}${using}`;
}

export function createMacDriver(opts: { hasCliclick?: boolean } = {}): ComputerDriver {
  const hasCliclick = opts.hasCliclick ?? false;
  const mouse = (a: Record<string, unknown>) => jxa(MOUSE_JXA, JSON.stringify(a));
  const r = (n: number) => Math.round(n);
  const driver: ComputerDriver = {
    async screenSize() {
      try {
        const s = JSON.parse(await jxa(SCREEN_SIZE_JXA)) as Screen;
        if (s.width > 0 && s.height > 0) return s;
      } catch {
        // fall through
      }
      const { stdout } = await run("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop']);
      const [, , w, h] = stdout.split(",").map((n) => Number(n.trim()));
      return { width: w!, height: h! };
    },
    async screenshot() {
      const dir = mkdtempSync(join(tmpdir(), "kovach-shot-"));
      const file = join(dir, "shot.jpg");
      try {
        // -m: main display only (the one the grid maps onto); -x: no sound.
        await run("screencapture", ["-x", "-m", "-t", "jpg", file]);
        // Retina captures are huge; the model needs far fewer pixels. sips ships with macOS.
        await run("sips", ["--resampleWidth", String(SHOT_WIDTH), "-s", "formatOptions", "70", file]).catch(() => undefined);
        return { type: "image", mediaType: "image/jpeg", data: readFileSync(file).toString("base64") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async move(x, y) {
      if (hasCliclick) await run("cliclick", [`m:${r(x)},${r(y)}`]);
      else await mouse({ op: "move", x, y });
    },
    async click(x, y, button, count) {
      if (hasCliclick) {
        const verb = button === "right" ? "rc" : count >= 3 ? "tc" : count === 2 ? "dc" : "c";
        await run("cliclick", [`${verb}:${r(x)},${r(y)}`]);
        return;
      }
      await mouse({ op: "click", x, y, button, count });
    },
    async drag(fx, fy, tx, ty) {
      if (hasCliclick) {
        await run("cliclick", ["-e", "40", `dd:${r(fx)},${r(fy)}`, `dm:${r(tx)},${r(ty)}`, `du:${r(tx)},${r(ty)}`]);
        return;
      }
      await mouse({ op: "drag", x: fx, y: fy, tx, ty });
    },
    async type(text) {
      if (hasCliclick && /^[\x20-\x7e]*$/.test(text)) {
        await run("cliclick", ["-w", "20", `t:${text}`]);
        return;
      }
      // Line by line, so newlines become Return presses.
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await osascript(`tell application "System Events" to keystroke ${asAppleScriptString(lines[i]!)}`);
        if (i < lines.length - 1) await osascript(systemEventsKey("return"));
      }
    },
    async key(combo) {
      await osascript(systemEventsKey(combo));
    },
    async scroll(x, y, dy) {
      try {
        await mouse({ op: "scroll", x, y, dy });
      } catch {
        // No CoreGraphics scroll: page keys move the focused view instead.
        const n = Math.min(10, Math.max(1, Math.ceil(Math.abs(dy) / 5)));
        for (let i = 0; i < n; i++) await osascript(systemEventsKey(dy < 0 ? "pageup" : "pagedown"));
      }
    },
    async readUi() {
      return JSON.parse(await jxa(READ_UI_JXA)) as UiSnapshot;
    },
    async openApp(name) {
      await run("open", ["-a", name]);
    },
  };
  return driver;
}

/** cliclick present? Used to decide whether the CoreGraphics fallbacks are needed. */
export async function hasCliclick(): Promise<boolean> {
  try {
    await run("which", ["cliclick"]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const APP_NAME = /^[\p{L}\p{N} ._&'()+-]{1,60}$/u;

/**
 * The computer-use tools. They are NOT in the default TOOLS list; the desktop
 * app adds them only when the user turns computer use on for a run.
 */
export function computerTools(driver: ComputerDriver): AgentTool[] {
  let size: Screen | undefined;
  const ensureSize = async () => (size ??= await driver.screenSize());
  /** Elements from the last read_screen; cleared by every action that may change the screen. */
  let items = new Map<number, UiItem>();
  const changed = () => {
    items = new Map();
  };

  const shot = async (lead = "Screenshot taken"): Promise<ToolOutcome> => ({
    ok: true,
    content: `${lead} (point with 0–${GRID} coordinates; 0,0 is top-left).`,
    images: [await driver.screenshot()],
  });

  const approve = (ctx: ToolContext, what: string) => ctx.approve({ kind: "computer", command: what, cwd: ctx.workspace.root });

  const screenshot: AgentTool = {
    name: "computer_screenshot",
    description: `Take a screenshot of the Mac's main screen. Coordinates are 0–${GRID} in both axes regardless of resolution; 0,0 is the top-left.`,
    schema: z.object({}),
    async run() {
      return shot();
    },
  } as AgentTool;

  const readScreen: AgentTool = {
    name: "computer_read_screen",
    description:
      "List the buttons, fields, links and text in the frontmost window, each with an id and its 0–1000 position. Prefer this over guessing from a screenshot: click an element with computer_click {element: id}.",
    schema: z.object({}),
    async run() {
      if (!driver.readUi) return { ok: false, content: "Reading the screen's controls isn't available here; use computer_screenshot." };
      let snap: UiSnapshot;
      try {
        snap = await driver.readUi();
      } catch (err) {
        return { ok: false, content: `Couldn't read the screen's controls (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). Use computer_screenshot instead.` };
      }
      const s = await ensureSize();
      const list = uiItems(snap, s);
      items = new Map(list.map((i) => [i.id, i]));
      if (list.length === 0) return { ok: true, content: `${snap.app || "The frontmost app"} exposes no controls to read. Use computer_screenshot instead.` };
      return { ok: true, content: formatUi(snap, list, !!snap.truncated || list.length >= MAX_ITEMS) };
    },
  } as AgentTool;

  const click: AgentTool = {
    name: "computer_click",
    description: `Click an element from computer_read_screen ({element: id}) or a point x,y in 0–${GRID} coordinates from a screenshot. The user approves each click.`,
    schema: z
      .object({
        element: z.number().int().positive().optional(),
        x: z.number().min(0).max(GRID).optional(),
        y: z.number().min(0).max(GRID).optional(),
        button: z.enum(["left", "right"]).default("left"),
        count: z.number().int().min(1).max(3).default(1),
        note: z.string().optional().describe("What you are clicking, e.g. 'the Save button'"),
      })
      .refine((a) => a.element !== undefined || (a.x !== undefined && a.y !== undefined), { message: "Give an element id, or both x and y." }),
    async run(args, ctx) {
      const a = args as { element?: number; x?: number; y?: number; button: "left" | "right"; count: number; note?: string };
      const s = await ensureSize();
      let px: number;
      let py: number;
      let what: string;
      if (a.element !== undefined) {
        const it = items.get(a.element);
        if (!it) return { ok: false, content: `There is no element ${a.element} on the current screen. Call computer_read_screen again.` };
        px = it.px;
        py = it.py;
        what = `${it.role}${it.label ? ` "${it.label}"` : ""}`;
      } else {
        px = toPoints(a.x!, s.width);
        py = toPoints(a.y!, s.height);
        what = a.note ? `${a.note} at ${a.x}, ${a.y}` : `${a.x}, ${a.y}`;
      }
      const verb = `${a.count === 3 ? "triple-" : a.count === 2 ? "double-" : ""}${a.button === "right" ? "right-" : ""}click`;
      if (!(await approve(ctx, `${verb} ${what}`))) return { ok: false, content: "The user declined the click." };
      await driver.click(px, py, a.button, a.count);
      changed();
      await delay(400);
      return shot(`Clicked ${what}`);
    },
  } as AgentTool;

  const drag: AgentTool = {
    name: "computer_drag",
    description: `Drag from one point to another, in 0–${GRID} coordinates (moving a window, a slider, a file). The user approves it.`,
    schema: z.object({
      fromX: z.number().min(0).max(GRID),
      fromY: z.number().min(0).max(GRID),
      toX: z.number().min(0).max(GRID),
      toY: z.number().min(0).max(GRID),
      note: z.string().optional(),
    }),
    async run(args, ctx) {
      const a = args as { fromX: number; fromY: number; toX: number; toY: number; note?: string };
      const s = await ensureSize();
      if (!(await approve(ctx, `drag ${a.note ? `${a.note} ` : ""}from ${a.fromX}, ${a.fromY} to ${a.toX}, ${a.toY}`))) {
        return { ok: false, content: "The user declined the drag." };
      }
      await driver.drag(toPoints(a.fromX, s.width), toPoints(a.fromY, s.height), toPoints(a.toX, s.width), toPoints(a.toY, s.height));
      changed();
      await delay(400);
      return shot("Dragged");
    },
  } as AgentTool;

  const typeTool: AgentTool = {
    name: "computer_type",
    description: "Type text into whatever has keyboard focus. Click the field first. Newlines press Return. The user approves it.",
    schema: z.object({ text: z.string().min(1).max(4000) }),
    async run(args, ctx) {
      const { text } = args as { text: string };
      const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      if (!(await approve(ctx, `type "${shown}"`))) return { ok: false, content: "The user declined the typing." };
      await driver.type(text);
      changed();
      await delay(250);
      return shot("Typed");
    },
  } as AgentTool;

  const keyTool: AgentTool = {
    name: "computer_key",
    description: "Press a key or chord, e.g. 'return', 'escape', 'cmd+c', 'cmd+shift+t'. The user approves it.",
    schema: z.object({ combo: z.string().min(1).max(40) }),
    async run(args, ctx) {
      const { combo } = args as { combo: string };
      if (!(await approve(ctx, `press ${combo}`))) return { ok: false, content: "The user declined the key press." };
      await driver.key(combo);
      changed();
      await delay(250);
      return shot(`Pressed ${combo}`);
    },
  } as AgentTool;

  const scrollTool: AgentTool = {
    name: "computer_scroll",
    description: `Scroll at x,y (0–${GRID}); a positive amount scrolls down, in lines (5–15 is typical). The user approves it.`,
    schema: z.object({ x: z.number().min(0).max(GRID), y: z.number().min(0).max(GRID), amount: z.number().int().min(-100).max(100) }),
    async run(args, ctx) {
      const a = args as { x: number; y: number; amount: number };
      const s = await ensureSize();
      if (!(await approve(ctx, `scroll ${a.amount < 0 ? "up" : "down"} at ${a.x}, ${a.y}`))) return { ok: false, content: "The user declined the scroll." };
      await driver.scroll(toPoints(a.x, s.width), toPoints(a.y, s.height), a.amount);
      changed();
      await delay(300);
      return shot("Scrolled");
    },
  } as AgentTool;

  const tools: AgentTool[] = [screenshot, readScreen, click, drag, typeTool, keyTool, scrollTool];

  if (driver.openApp) {
    const openApp: AgentTool = {
      name: "computer_open_app",
      description: "Open a Mac app by name (or bring it to the front), e.g. 'Calculator', 'Safari', 'Notes'. The user approves it.",
      schema: z.object({ name: z.string().min(1).max(60) }),
      async run(args, ctx) {
        const { name } = args as { name: string };
        if (!APP_NAME.test(name)) return { ok: false, content: "That doesn't look like an app name." };
        if (!(await approve(ctx, `open the app "${name}"`))) return { ok: false, content: "The user declined opening the app." };
        try {
          await driver.openApp!(name);
        } catch {
          return { ok: false, content: `There is no app called "${name}".` };
        }
        changed();
        await delay(1200);
        return shot(`Opened ${name}`);
      },
    } as AgentTool;
    tools.splice(2, 0, openApp);
  }
  return tools;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
