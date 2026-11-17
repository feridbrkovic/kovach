/**
 * Opens a page the agent built in a hidden browser window, at phone and desktop width, and
 * returns screenshots plus what can be measured (see page-findings.ts). The page runs
 * sandboxed, without Node or the app's preload, in its own throwaway session.
 */
import type { ReferenceLook } from "@kovach-dev/agent";
import { isPublicPage, REFERENCE_SCRIPT } from "./reference-look";
import type { PageLook } from "@kovach-dev/agent";
import { BrowserWindow } from "electron";
import { MEASURE_SCRIPT, pageFindings, type PageMeasure } from "./page-findings";

const SIZES = [
  { label: "Phone, 390 px wide", width: 390, height: 844 },
  { label: "Desktop, 1280 px wide", width: 1280, height: 800 },
];
/** Tall pages are cut here so the screenshots stay readable for the model. */
const MAX_HEIGHT = 4000;
const SHOT_WIDTH = 640;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);

export async function lookAtPage(path: string, signal?: AbortSignal): Promise<PageLook | undefined> {
  const shots: PageLook["shots"] = [];
  const findings: string[] = [];
  for (const [i, size] of SIZES.entries()) {
    if (signal?.aborted) return undefined;
    const win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "page-look", backgroundThrottling: false },
    });
    try {
      const contents = win.webContents;
      contents.setAudioMuted(true);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      const errors: string[] = [];
      // The event's shape differs between Electron versions: (event, level, message) or one event object.
      contents.on("console-message", (...args: unknown[]) => {
        const event = args[0] as { level?: unknown; message?: unknown } | undefined;
        const level = typeof args[1] === "number" ? args[1] : event?.level;
        const message = typeof args[2] === "string" ? args[2] : event?.message;
        if ((level === 3 || level === "error") && typeof message === "string") errors.push(message);
      });
      await within(win.loadFile(path), 15_000, "Loading the page");
      await wait(1500); // fonts, CDN scripts, entrance animations
      const measure = (await within(contents.executeJavaScript(MEASURE_SCRIPT, true), 15_000, "Measuring the page")) as PageMeasure;
      const height = Math.min(Math.max(Math.round(measure.height), size.height), MAX_HEIGHT);
      win.setContentSize(size.width, height);
      await wait(800);
      const image = await within(contents.capturePage(), 10_000, "The screenshot");
      if (image.isEmpty()) continue;
      const scaled = size.width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH, quality: "good" }) : image;
      shots.push({
        label: `${size.label}${measure.height > MAX_HEIGHT ? ", the first 4,000 px" : ""}`,
        image: { type: "image", mediaType: "image/jpeg", data: scaled.toJPEG(72).toString("base64") },
      });
      findings.push(...pageFindings(measure, errors, size.width, i === 0));
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
  return shots.length ? { shots, findings } : undefined;
}

/** Opens a public page off-screen and measures its look, for "make it look like this link". */
export async function measureReference(url: string, signal?: AbortSignal): Promise<ReferenceLook | undefined> {
  if (!isPublicPage(url) || signal?.aborted) return undefined;
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "page-reference", backgroundThrottling: false },
  });
  try {
    const contents = win.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // A redirect to somewhere that is not a public page ends the visit.
    contents.on("will-redirect", (event, target) => {
      if (!isPublicPage(target)) event.preventDefault();
    });
    await within(win.loadURL(url), 20_000, "Loading the reference");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const look = (await within(contents.executeJavaScript(REFERENCE_SCRIPT, true), 10_000, "Measuring the reference")) as Omit<ReferenceLook, "url">;
    return { ...look, url };
  } catch {
    return undefined; // a reference that can't be opened is not a reason to fail the page
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

