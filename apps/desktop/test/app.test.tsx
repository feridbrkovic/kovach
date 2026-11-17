// @vitest-environment jsdom
import { createMockMemoryApi, demoSeed } from "@kovach-dev/memory-contract/mock";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App";
import { parsePlan } from "../src/renderer/src/components/SessionView";
import { dayGroup, relativeTime } from "../src/renderer/src/time";

// Demo sessions are updated on 6, 7 and 8 Nov 2026; "now" is the 8th in the evening.
const NOW = new Date(2026, 10, 8, 20, 0).getTime();

function setup() {
  const api = createMockMemoryApi({ seed: demoSeed(new Date(2026, 10, 1, 9, 0).getTime()), now: () => NOW });
  const user = userEvent.setup();
  render(<App api={api} source="demo" now={() => NOW} searchDelay={0} />);
  return { api, user };
}

afterEach(cleanup);

describe("plan cards", () => {
  it("reads the plan the agent records, with its brief when there is one", () => {
    expect(parsePlan("Plan: Fix it\n1. Edit cart.js (src/cart.js)\n2. Run checks")).toEqual({ summary: "Fix it", steps: ["Edit cart.js (src/cart.js)", "Run checks"] });
    const withBrief = parsePlan(
      "Plan: Build the page\n1. Write index.html\n\nBrief\nGoal: A page that books SEO audits.\nDeliver: index.html\nDeliver: styles.css\nMust: One h1\nDone when: index.html has one h1\nAssuming: Dark colour scheme",
    );
    expect(withBrief).toEqual({
      summary: "Build the page",
      steps: ["Write index.html"],
      brief: {
        goal: "A page that books SEO audits.",
        groups: [
          { label: "Deliverables", items: ["index.html", "styles.css"] },
          { label: "Requirements", items: ["One h1"] },
          { label: "Done when", items: ["index.html has one h1"] },
          { label: "Assumptions", items: ["Dark colour scheme"] },
        ],
      },
    });
    // An answer that merely starts like a plan is shown as text.
    expect(parsePlan("Plan: done\n1. Edited\n\nAll checks pass.")).toBeUndefined();
    expect(parsePlan("Plan: x\n1. y\n\nBrief\nSomething else")).toBeUndefined();
  });
});

describe("time helpers", () => {
  it("groups by day and formats relative times", () => {
    expect(dayGroup(NOW - 60_000, NOW)).toBe("Today");
    expect(dayGroup(NOW - 24 * 3600_000, NOW)).toBe("Yesterday");
    expect(dayGroup(NOW - 3 * 24 * 3600_000, NOW)).toBe("Previous 7 days");
    expect(dayGroup(NOW - 30 * 24 * 3600_000, NOW)).toBe("Older");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
  });
});

describe("history sidebar", () => {
  it("lists sessions newest first, grouped by day, and says when data is a demo", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "Sessions" });
    await within(nav).findByText("Invoice PDF timezone bug");
    const titles = within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t): t is string => !!t && !t.startsWith("Rename") && !t.startsWith("Delete"));
    expect(titles[0]).toContain("Invoice PDF timezone bug");
    expect(titles[2]).toContain("Fix Metro cache after Reanimated upgrade");
    expect(within(nav).getByRole("region", { name: "Today" })).toBeTruthy();
    expect(screen.getByText(/Demo data/)).toBeTruthy();
  });

  it("opens a session with its messages and tool calls", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Fix Metro cache/ }));
    const article = await screen.findByRole("article");
    expect(within(article).getByRole("heading", { level: 1 }).textContent).toBe("Fix Metro cache after Reanimated upgrade");
    expect(within(article).getByText(/crashes on start with a worklets error/)).toBeTruthy();
    // Inline `code` in the message renders as code; the same command also labels its tool call.
    const codes = within(article).getAllByText("npx expo start -c");
    expect(codes.map((c) => c.tagName)).toEqual(["CODE", "CODE"]);
    expect(within(article).getByText("exit 1", { exact: false })).toBeTruthy();
    expect(within(article).getByLabelText("Succeeded")).toBeTruthy();
  });

  it("opens a long session on its newest messages, with earlier ones a click away above", async () => {
    const api = createMockMemoryApi({ seed: demoSeed(new Date(2026, 10, 1, 9, 0).getTime()), now: () => NOW, pageSize: 1 });
    const user = userEvent.setup();
    render(<App api={api} source="demo" now={() => NOW} searchDelay={0} />);
    await user.click(await screen.findByRole("button", { name: /^Invoice PDF timezone bug/ }));
    const article = await screen.findByRole("article");
    await within(article).findByText(/Now using the customer's timezone/);
    expect(within(article).queryByText(/Invoices show yesterday's date/)).toBeNull();

    await user.click(within(article).getByRole("button", { name: "Load earlier messages" }));
    const question = await within(article).findByText(/Invoices show yesterday's date/);
    const answer = within(article).getByText(/Now using the customer's timezone/);
    // Earlier messages go above the later ones, and there is nothing earlier left to load.
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("renames a session inline", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Rename Add cart badge to tab bar" }));
    const input = screen.getByLabelText("Session title");
    await user.clear(input);
    await user.type(input, "Cart badge{Enter}");
    expect(await screen.findByRole("button", { name: /^Cart badge/ })).toBeTruthy();
    expect(screen.queryByText("Add cart badge to tab bar")).toBeNull();
  });

  it("deletes a session only after confirming", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Fix Metro cache/ }));
    await screen.findByRole("article");
    await user.click(screen.getByRole("button", { name: "Delete Fix Metro cache after Reanimated upgrade" }));
    const confirm = screen.getByRole("group", { name: "Delete Fix Metro cache after Reanimated upgrade" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: /^Fix Metro cache/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete Fix Metro cache after Reanimated upgrade" }));
    await user.click(
      within(screen.getByRole("group", { name: "Delete Fix Metro cache after Reanimated upgrade" })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Fix Metro cache/ })).toBeNull());
    // The open session closes with it.
    expect(screen.getByRole("heading", { name: "Your history" })).toBeTruthy();
  });

  it("searches messages and opens the session at the hit", async () => {
    const { user } = setup();
    await screen.findByRole("navigation", { name: "Sessions" });
    await user.type(screen.getByLabelText("Search history"), "timezone");
    const results = await screen.findByRole("navigation", { name: "Search results" });
    const hit = await within(results).findByRole("button", { name: /Invoice PDF timezone bug/ });
    await user.click(hit);
    const article = await screen.findByRole("article");
    const focused = article.querySelector(".message.focused");
    expect(focused?.textContent).toMatch(/timezone/i);

    await user.clear(screen.getByLabelText("Search history"));
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toBeTruthy();
  });

  it("shows no results for a query without words", async () => {
    const { user } = setup();
    await screen.findByRole("navigation", { name: "Sessions" });
    await user.type(screen.getByLabelText("Search history"), "zzqx");
    expect(await screen.findByText("No messages match.")).toBeTruthy();
  });

  it("without the agent it is a read-only history browser", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    await screen.findByRole("article");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByRole("button", { name: /New session/ })).toBeNull();
  });

  it("shows exit codes on tool calls", async () => {
    const api = createMockMemoryApi({
      seed: {
        sessions: [
          {
            session: { id: "s1", title: "Typecheck", status: "done", messageCount: 1, createdAt: NOW - 1000, updatedAt: NOW - 1000 },
            messages: [
              {
                id: "m1",
                sessionId: "s1",
                role: "assistant",
                content: "Running the typecheck.",
                createdAt: NOW - 1000,
                toolCalls: [
                  { id: "t1", name: "shell", command: "pnpm typecheck", exitCode: 2, durationMs: 2870, outputExcerpt: "error TS2322", createdAt: NOW - 1000 },
                  { id: "t2", name: "shell", command: "pnpm typecheck", exitCode: 0, durationMs: 410, createdAt: NOW - 900 },
                ],
              },
            ],
          },
        ],
      },
    });
    const user = userEvent.setup();
    render(<App api={api} source="app" now={() => NOW} searchDelay={0} />);
    await user.click(await screen.findByRole("button", { name: /^Typecheck/ }));
    await screen.findByRole("article");
    expect(screen.getByText("exit 2", { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("Succeeded")).toBeTruthy();
    expect(screen.getByText("2.9 s")).toBeTruthy();
    expect(screen.getByText("error TS2322")).toBeTruthy();
    expect(screen.queryByText(/Demo data/)).toBeNull();
  });
});
