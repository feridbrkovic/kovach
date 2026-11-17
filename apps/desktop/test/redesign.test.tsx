// @vitest-environment jsdom
import { createMockMemoryApi, demoSeed, type MockSeed } from "@kovach-dev/memory-contract/mock";

type SessionSeed = NonNullable<MockSeed["sessions"]>[number];
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App";
import { createDemoAgentApi } from "../src/renderer/src/demo-agent";
import type { AgentApi, StartInput } from "../src/shared/agent";

const NOW = new Date(2026, 10, 8, 20, 0).getTime();
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function setup(opts: { agent?: AgentApi; extraSessions?: SessionSeed[] } = {}) {
  const seed = demoSeed(new Date(2026, 10, 1, 9, 0).getTime());
  seed.sessions!.push(...(opts.extraSessions ?? []));
  const api = createMockMemoryApi({ seed, now: () => NOW });
  const user = userEvent.setup();
  const agent = opts.agent ?? createDemoAgentApi({ stepMs: 0 });
  render(<App api={api} agent={agent} source="demo" now={() => NOW} searchDelay={0} />);
  return { user, agent };
}

/** A demo agent that records what start() received. */
function recording(overrides: Partial<AgentApi> = {}) {
  const demo = createDemoAgentApi({ stepMs: 0 });
  const starts: StartInput[] = [];
  const agent: AgentApi = {
    ...demo,
    ...overrides,
    start: async (input) => {
      starts.push(input);
      return demo.start(input);
    },
  };
  return { agent, starts };
}

afterEach(cleanup);

describe("start screen", () => {
  it("opens by default and starts a session without a project", async () => {
    const { agent, starts } = recording();
    const { user } = setup({ agent });
    const start = await screen.findByRole("region", { name: "New session" });
    expect(within(start).getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
    await user.type(within(start).getByLabelText("Message"), "What does sqlite-vec do?{Enter}");
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({ text: "What does sqlite-vec do?" });
  });

  it("attaches images, can remove one, and sends the rest", async () => {
    const { agent, starts } = recording();
    const { user } = setup({ agent });
    const start = await screen.findByRole("region", { name: "New session" });
    const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
    await user.upload(within(start).getByLabelText("Attach images", { selector: "input" }), [png("a.png"), png("b.png")]);
    const list = await within(start).findByRole("list", { name: "Attached images" });
    await waitFor(() => expect(within(list).getAllByRole("img")).toHaveLength(2));
    await user.click(within(list).getByRole("button", { name: "Remove a.png" }));
    await user.type(within(start).getByLabelText("Message"), "Build this screen{Enter}");
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.images).toEqual([{ mediaType: "image/png", data: "iVBORw==", name: "b.png" }]);
  });

  it("refuses files that aren't images", async () => {
    setup();
    const start = await screen.findByRole("region", { name: "New session" });
    // Drag-and-drop skips the file picker's filter, so the composer checks types itself.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(within(start).getByLabelText("Attach images", { selector: "input" }), new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    expect((await within(start).findByRole("alert")).textContent).toMatch(/Only PNG, JPEG, WebP and GIF/);
  });
});

describe("computer use switch", () => {
  it("appears only when computer use is on, and asks for it per task", async () => {
    const { agent, starts } = recording();
    await agent.saveSettings({ computerUse: true });
    const { user } = setup({ agent });
    const start = await screen.findByRole("region", { name: "New session" });
    const toggle = await within(start).findByRole("button", { name: /Computer/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.type(within(start).getByLabelText("Message"), "Open Notes{Enter}");
    await waitFor(() => expect(starts[0]).toMatchObject({ text: "Open Notes", computerUse: true }));
  });

  it("is not offered while computer use is off", async () => {
    setup();
    const start = await screen.findByRole("region", { name: "New session" });
    expect(within(start).queryByRole("button", { name: /Computer/ })).toBeNull();
  });
});

describe("transcript", () => {
  const T = NOW - 60_000;
  const session: SessionSeed = {
    session: { id: "ses_rich", title: "Rich transcript", status: "done", messageCount: 3, createdAt: T, updatedAt: T },
    messages: [
      { id: "u1", sessionId: "ses_rich", role: "user", content: "Make it match\n\n![shot.png](attachment:" + "a".repeat(64) + ".png)", createdAt: T, toolCalls: [] },
      { id: "p1", sessionId: "ses_rich", role: "assistant", content: "Plan: Fix the total\n1. Read src/cart.ts (src/cart.ts)\n2. Return a number", createdAt: T + 1, toolCalls: [] },
      {
        id: "a1",
        sessionId: "ses_rich",
        role: "assistant",
        content: "Changed **total()**:\n\n```ts\nreturn Math.round(sum);\n```",
        createdAt: T + 2,
        toolCalls: [
          {
            id: "c1",
            name: "edit_file",
            args: { path: "src/cart.ts", edits: [{ old: "  return sum.toFixed(2);", new: "  return Math.round(sum * 100) / 100;" }] },
            exitCode: 0,
            outputExcerpt: "Edited src/cart.ts (1 line changed).",
            createdAt: T + 2,
          },
          {
            id: "c2",
            name: "computer_screenshot",
            args: {},
            exitCode: 0,
            outputExcerpt: "Screenshot taken.\n\n![computer_screenshot 1](attachment:" + "b".repeat(64) + ".png)",
            createdAt: T + 3,
          },
          { id: "c3", name: "run_command", args: { command: "npm test" }, command: "npm test", createdAt: T + 4 },
        ],
      },
    ],
  };

  it("renders markdown, the plan, diffs, running tools and attachment images", async () => {
    const reads: string[] = [];
    const demo = createDemoAgentApi({ stepMs: 0 });
    const agent: AgentApi = {
      ...demo,
      readAttachment: async (name) => {
        reads.push(name);
        return PNG_URL;
      },
    };
    const { user } = setup({ agent, extraSessions: [session] });
    await user.click(await screen.findByRole("button", { name: /^Rich transcript/ }));
    const article = await screen.findByRole("article");

    // User image from history, loaded through the agent.
    expect((await within(article).findByRole("img", { name: "shot.png" })).getAttribute("src")).toBe(PNG_URL);
    // The plan is a card, not raw text.
    const plan = within(article).getByRole("region", { name: "Plan" });
    expect(within(plan).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Read src/cart.ts (src/cart.ts)", "Return a number"]);
    // Markdown: bold and a code block with a copy button.
    expect(within(article).getByText("total()").tagName).toBe("STRONG");
    expect(within(article).getByText("return Math.round(sum);").closest(".codeblock")).toBeTruthy();
    expect(within(article).getByRole("button", { name: "Copy" })).toBeTruthy();
    // Edit row with a line count, opening to a diff.
    expect(within(article).getByText("+1 −1")).toBeTruthy();
    const diff = within(article).getByLabelText("Changes");
    expect(diff.querySelector(".del")!.textContent).toContain("return sum.toFixed(2);");
    expect(diff.querySelector(".add")!.textContent).toContain("return Math.round(sum * 100) / 100;");
    // A command without a result yet shows as running.
    expect(within(article).getByRole("status", { name: "Running" })).toBeTruthy();
    // The screenshot from tool output shows as an image.
    expect(await within(article).findByRole("img", { name: "computer_screenshot 1" })).toBeTruthy();
    expect(reads.sort()).toEqual([`${"a".repeat(64)}.png`, `${"b".repeat(64)}.png`]);
  });
});

describe("tools settings", () => {
  it("switches tools and installs image generation with live output", async () => {
    const demo = createDemoAgentApi({ stepMs: 0 });
    let progress: ((line: string) => void) | undefined;
    let installed = false;
    const agent: AgentApi = {
      ...demo,
      mediaStatus: async () => (installed ? { state: "installed", modelDownloaded: false, detail: "mflux 0.24.0" } : { state: "not_installed" }),
      installMedia: async () => {
        progress?.("$ uv venv --python 3.12");
        progress?.("Installed mflux");
        installed = true;
        await demo.saveSettings({ imageGeneration: true });
        return { state: "installed", modelDownloaded: false, detail: "mflux 0.24.0" };
      },
      onMediaProgress: (cb) => {
        progress = cb;
        return () => (progress = undefined);
      },
    };
    const { user } = setup({ agent });
    await user.click(await screen.findByRole("button", { name: "Model settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("tab", { name: "Tools" }));

    const web = await within(dialog).findByRole("switch", { name: "Web search" });
    expect(web).toHaveProperty("checked", true);
    await user.click(web);
    await waitFor(async () => expect((await agent.getSettings()).webSearch).toBe(false));

    const images = within(dialog).getByRole("switch", { name: "Image generation" });
    expect(images).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("button", { name: "Install image generation" }));
    expect((await within(dialog).findByLabelText("Install output")).textContent).toContain("Installed mflux");
    expect(await within(dialog).findByText(/Installed \(mflux 0.24.0\)/)).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole("switch", { name: "Image generation" })).toHaveProperty("checked", true));
  });

  it("shows missing computer permissions with a way to grant them", async () => {
    const demo = createDemoAgentApi({ stepMs: 0 });
    const opened: string[] = [];
    const agent: AgentApi = {
      ...demo,
      computerPermissions: async () => ({ screenRecording: true, accessibility: false }),
      openPermissionSettings: async (which) => void opened.push(which),
    };
    await agent.saveSettings({ computerUse: true });
    const { user } = setup({ agent });
    await user.click(await screen.findByRole("button", { name: "Model settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("tab", { name: "Tools" }));
    expect(await within(dialog).findByText("Granted")).toBeTruthy();
    expect(within(dialog).getByText("Not granted")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Open System Settings" }));
    expect(opened).toEqual(["accessibility"]);
  });
});
