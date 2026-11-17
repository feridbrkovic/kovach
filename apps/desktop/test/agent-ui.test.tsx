// @vitest-environment jsdom
import { MemoryApiError } from "@kovach-dev/memory-contract";
import { createMockMemoryApi, demoSeed } from "@kovach-dev/memory-contract/mock";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App";
import { createDemoAgentApi } from "../src/renderer/src/demo-agent";
import type { AgentApi, AgentStatusEvent } from "../src/shared/agent";

const NOW = new Date(2026, 10, 8, 20, 0).getTime();

function setup(agent: AgentApi = createDemoAgentApi({ stepMs: 0 }), seed = demoSeed(new Date(2026, 10, 1, 9, 0).getTime())) {
  const api = createMockMemoryApi({ seed, now: () => NOW });
  const user = userEvent.setup();
  render(<App api={api} agent={agent} source="demo" now={() => NOW} searchDelay={0} />);
  return { api, agent, user };
}

afterEach(cleanup);

describe("agent UI", () => {
  it("starts a new session in a project and walks through plan, approval and result", async () => {
    const { user } = setup();
    const sidebar = await screen.findByRole("complementary", { name: "History" });
    await user.click(within(sidebar).getByRole("button", { name: "New session" }));
    const start = screen.getByRole("region", { name: "New session" });
    const project = within(start).getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    expect(project.value).toBe("__none__");
    await user.selectOptions(project, "billing-api");
    const send = within(start).getByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", true);
    await user.type(within(start).getByLabelText("Message"), "Fix the cart total type error");
    await user.click(send);

    // The live line shows the plan, then the agent asks before running the check.
    const approval = await screen.findByRole("alertdialog", { name: "Run the project's check?" });
    expect(within(approval).getByText(/pnpm typecheck/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Agent progress" }).textContent).toMatch(/3 steps · Return a number from total\(\)/);
    await user.click(within(approval).getByRole("button", { name: "Allow once" }));

    const result = await screen.findByRole("status");
    expect(result.textContent).toContain("Done");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("continues an existing session from the message box; denying the check is reported", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    await screen.findByRole("article");
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Message"), "Also show the badge on the profile tab");
    await user.click(send);

    // While it runs, the sidebar marks the session and Send turns into Stop.
    expect(await screen.findByText("Working…")).toBeTruthy();
    const approval = await screen.findByRole("alertdialog");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.click(within(approval).getByRole("button", { name: "Deny" }));

    const result = await screen.findByRole("status");
    expect(result.textContent).toMatch(/Finished, but checks fail/);
    expect(result.textContent).toMatch(/typecheck wasn't run/);
    // The message box is back, empty, ready for the next turn.
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
  });

  it("goes back to the newest messages when a task starts, and follows content that grows while at the bottom", async () => {
    // Capture the transcript's ResizeObserver so the test can say "the content grew".
    const observers: (() => void)[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { user } = setup(createDemoAgentApi({ stepMs: 200 }));
      await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
      await screen.findByRole("article");
      const scroller = document.querySelector(".transcript-scroll") as HTMLDivElement;
      let height = 1000;
      let top = 0;
      Object.defineProperty(scroller, "scrollHeight", { get: () => height });
      Object.defineProperty(scroller, "clientHeight", { get: () => 200 });
      Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => void (top = v) });

      // Reading older messages: growing content leaves the view alone.
      top = 100;
      scroller.dispatchEvent(new Event("scroll"));
      height = 1200;
      for (const fire of observers) fire();
      expect(top).toBe(100);

      // Sending a message goes back to the bottom, and from there the view follows.
      await user.type(screen.getByLabelText("Message"), "Also show the badge on the profile tab");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await screen.findByText("Working…");
      expect(top).toBe(1200);
      scroller.dispatchEvent(new Event("scroll"));
      height = 1500;
      for (const fire of observers) fire();
      expect(top).toBe(1500);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("a message opened from search is for reading: sending a new one leaves it for the end of the session", async () => {
    const { user } = setup(createDemoAgentApi({ stepMs: 200 }));
    await screen.findByRole("navigation", { name: "Sessions" });
    await user.type(screen.getByLabelText("Search history"), "badge");
    const results = await screen.findByRole("navigation", { name: "Search results" });
    await user.click((await within(results).findAllByRole("button", { name: /Add cart badge/ }))[0]!);
    const article = await screen.findByRole("article");
    await waitFor(() => expect(article.querySelector(".message.focused")).not.toBeNull());

    await user.type(screen.getByLabelText("Message"), "Also show it on the profile tab");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Stop" });
    await waitFor(() => expect(screen.getByRole("article").querySelector(".message.focused")).toBeNull());
  });

  it("stops a run", async () => {
    const { user } = setup(createDemoAgentApi({ stepMs: 200 }));
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    await user.type(await screen.findByLabelText("Message"), "Do it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect((await screen.findByRole("status", {}, { timeout: 2000 })).textContent).toContain("Stopped");
  });

  it("only one task runs at a time; sessions without a project can run too", async () => {
    const seed = demoSeed(new Date(2026, 10, 1, 9, 0).getTime());
    seed.sessions!.push({
      session: { id: "ses_loose", title: "Loose chat", status: "done", messageCount: 0, createdAt: NOW - 5000, updatedAt: NOW - 5000 },
      messages: [],
    });
    const { user } = setup(createDemoAgentApi({ stepMs: 0 }), seed);

    await user.click(await screen.findByRole("button", { name: /^Loose chat/ }));
    expect(await screen.findByText("No project")).toBeTruthy();
    expect(screen.getByLabelText("Message")).toHaveProperty("disabled", false);

    await user.click(screen.getByRole("button", { name: /^Add cart badge/ }));
    await user.type(await screen.findByLabelText("Message"), "Go");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: /^Invoice PDF/ }));
    expect(await screen.findByPlaceholderText(/Another task is running in “Add cart badge to tab bar”/)).toBeTruthy();
    expect(screen.getByLabelText("Message")).toHaveProperty("disabled", true);
  });

  it("edits and tests the model settings", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Model settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const url = within(dialog).getByLabelText("Server address") as HTMLInputElement;
    await waitFor(() => expect(url.value).toBe("http://127.0.0.1:8000/v1"));
    expect((within(dialog).getByLabelText("Model") as HTMLInputElement).value).toBe("Qwen3.6-35B-A3B-4bit");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect((await within(dialog).findByRole("status")).textContent).toMatch(/Demo mode/);
    await user.clear(url);
    await user.type(url, "http://127.0.0.1:11434/v1");
    const key = within(dialog).getByLabelText(/API key/) as HTMLInputElement;
    expect(key.type).toBe("password");
    await user.type(key, "sk-omlx-demo");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Reopened: the key shows as saved, never as text.
    await user.click(screen.getByRole("button", { name: "Model settings" }));
    const again = screen.getByRole("dialog", { name: "Settings" });
    expect(await within(again).findByLabelText("API key (saved)")).toHaveProperty("value", "");
    expect(within(again).getByRole("checkbox", { name: "Remove the saved key" })).toBeTruthy();
  });

  it("offers the files of a session without a project: show them, or save them to a folder", async () => {
    const calls: string[] = [];
    const agent: AgentApi = {
      ...createDemoAgentApi({ stepMs: 0 }),
      sessionFiles: async () => ({ count: 3, names: ["index.html", "styles.css", "script.js"], page: "index.html" }),
      openSessionPage: async (id) => void calls.push(`open ${id}`),
      showSessionFiles: async (id) => void calls.push(`show ${id}`),
      saveSessionFiles: async () => ({ path: "/Users/me/Desktop/seo-landing-page", copied: 3 }),
    };
    const seed = demoSeed(new Date(2026, 10, 1, 9, 0).getTime());
    seed.sessions!.push({ session: { id: "ses_scratch", title: "SEO landing page", status: "done", messageCount: 0, createdAt: NOW, updatedAt: NOW }, messages: [] });
    const { user } = setup(agent, seed);
    await user.click(await screen.findByRole("button", { name: /^SEO landing page/ }));
    const bar = await screen.findByRole("region", { name: "Files from this session" });
    expect(bar.textContent).toMatch(/3 files in this session's own folder: index\.html, styles\.css, script\.js\. Sessions without a project can't write anywhere else\./);
    await user.click(within(bar).getByRole("button", { name: "Open index.html in browser" }));
    await user.click(within(bar).getByRole("button", { name: "Show in Finder" }));
    expect(calls).toEqual(["open ses_scratch", "show ses_scratch"]);
    await user.click(within(bar).getByRole("button", { name: "Save to folder…" }));
    expect((await within(bar).findByRole("status")).textContent).toBe("Saved 3 files to /Users/me/Desktop/seo-landing-page");

    // A project session has no such bar.
    await user.click(screen.getByRole("button", { name: /^Add cart badge/ }));
    await screen.findByRole("article");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Files from this session" })).toBeNull());
  });

  it("keeps the user's own standards in settings", async () => {
    const { user, agent } = setup();
    await user.click(await screen.findByRole("button", { name: "Model settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("tab", { name: "Standards" }));
    const box = (await within(dialog).findByLabelText("Your standards")) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    await user.type(box, "- Mobile first");
    expect(within(dialog).getByText(/14 of 6,000 characters · saves when you leave the field/)).toBeTruthy();
    await user.tab();
    await waitFor(async () => expect((await agent.getSettings()).standards).toBe("- Mobile first"));
  });

  it("offers the model settings when the model server can't be reached", async () => {
    const demo = createDemoAgentApi({ stepMs: 0 });
    const listeners = new Set<(e: AgentStatusEvent) => void>();
    const failing: AgentApi = {
      ...demo,
      async start(input) {
        const ref = { runId: "r1", sessionId: input.sessionId! };
        queueMicrotask(() => {
          listeners.forEach((cb) => cb({ ...ref, type: "started" }));
          listeners.forEach((cb) =>
            cb({ ...ref, type: "finished", status: "error", message: "model server unreachable at http://127.0.0.1:8000/v1" }),
          );
        });
        return ref;
      },
      onStatus(cb) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    };
    const { user } = setup(failing);
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    await user.type(await screen.findByLabelText("Message"), "Go");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const result = await screen.findByRole("status");
    expect(result.textContent).toMatch(/Something went wrong[\s\S]*unreachable/);
    await user.click(within(result).getByRole("button", { name: "Model settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("shows why a message couldn't be sent", async () => {
    const demo = createDemoAgentApi({ stepMs: 0 });
    const refusing: AgentApi = {
      ...demo,
      start: async () => {
        throw new MemoryApiError("invalid", "The project folder ~/Projects/shop-app can't be opened. Was it moved?");
      },
    };
    const { user } = setup(refusing);
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    await user.type(await screen.findByLabelText("Message"), "Go");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Was it moved/);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Go");
  });
});
