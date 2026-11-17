// @vitest-environment jsdom
import type { Candidate, Memory, RetrievedItem } from "@kovach-dev/memory-contract";
import { createMockMemoryApi, type MockSeed } from "@kovach-dev/memory-contract/mock";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App";
import { Markdown, stripCitations } from "../src/renderer/src/components/Markdown";
import { ApprovalCard } from "../src/renderer/src/components/RunPanel";
import { createDemoAgentApi } from "../src/renderer/src/demo-agent";
import type { HistoryApi } from "../src/shared/ipc";

const NOW = new Date(2026, 10, 8, 20, 0).getTime();
const HOUR = 3600_000;
const SHOP = "proj_shop_app";
const BILLING = "proj_billing_api";

function memory(id: string, o: Partial<Memory> & Pick<Memory, "key" | "body">): Memory {
  const projectId = o.projectId;
  return {
    id,
    kind: "preference",
    scope: projectId ? "project" : "global",
    trust: "user",
    status: "active",
    pinned: false,
    evidence: [],
    useCount: 0,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    ...o,
  };
}

function seed(): MockSeed {
  const memories: Memory[] = [
    memory("mem_1", { key: "style.semicolons", body: "No semicolons in TypeScript.", pinned: true, useCount: 4 }),
    memory("mem_2", { key: "state.library", body: "Use Zustand for client state; no Redux.", kind: "decision", projectId: SHOP }),
    memory("mem_3", { key: "tests.location", body: "Tests live next to the file as *.test.tsx.", kind: "convention", projectId: SHOP }),
    memory("mem_4", { key: "pkg.manager", body: "Use npm.", status: "superseded", updatedAt: NOW - 3 * HOUR }),
    { ...memory("mem_5", { key: "pkg.manager", body: "Use pnpm for all new projects." }), supersedesId: "mem_4" },
  ];
  const candidates: Candidate[] = [
    {
      id: "cand_1",
      kind: "convention",
      scope: "project",
      projectId: SHOP,
      key: "dates.timezone",
      body: "Format customer-facing dates in the customer's timezone.",
      evidence: [{ type: "message", id: "ses_1_m0" }, { type: "message", id: "ses_1_m1" }],
      seenInSessions: 2,
      expiresAt: NOW + 12 * 24 * HOUR,
      createdAt: NOW - HOUR,
    },
    {
      id: "cand_2",
      kind: "preference",
      scope: "global",
      key: "reply.tone",
      body: "Keep answers short.",
      evidence: [{ type: "message", id: "ses_1_m0" }],
      seenInSessions: 1,
      expiresAt: NOW + 3 * 24 * HOUR,
      createdAt: NOW - 2 * HOUR,
    },
  ];
  const used: RetrievedItem[] = [
    {
      ref: { type: "memory", id: "mem_2" },
      text: "Use Zustand for client state; no Redux.",
      score: 3,
      reasons: ["keyword_match", "trust:user"],
      possiblyOutdated: false,
      tokens: 10,
    },
    {
      ref: { type: "episode", id: "epi_1" },
      text: "After upgrading Reanimated, clear the Metro cache before debugging native code.",
      score: 2,
      reasons: ["error_signature_match"],
      possiblyOutdated: true,
      tokens: 20,
    },
  ];
  return {
    sessions: [
      {
        session: {
          id: "ses_1",
          projectId: SHOP,
          title: "Add cart badge",
          status: "done",
          messageCount: 2,
          createdAt: NOW - HOUR,
          updatedAt: NOW - HOUR,
        },
        messages: [
          { id: "ses_1_m0", sessionId: "ses_1", role: "user", content: "Add a cart badge.", toolCalls: [], createdAt: NOW - HOUR },
          { id: "ses_1_m1", sessionId: "ses_1", role: "assistant", content: "Added `CartBadge` reading the cart store.", toolCalls: [], createdAt: NOW - HOUR + 60_000 },
        ],
      },
    ],
    memories,
    candidates,
    usedMemories: { ses_1_m1: used },
    settings: { autoExtract: true, autoAcceptRecurring: false, projectModes: { [SHOP]: "on" }, embeddingModel: "embeddinggemma" },
  };
}

function setup(opts: { wrap?: (api: HistoryApi) => HistoryApi; seed?: MockSeed } = {}) {
  const mock = createMockMemoryApi({ seed: opts.seed ?? seed(), now: () => NOW });
  const api = opts.wrap ? opts.wrap(mock) : mock;
  const user = userEvent.setup();
  render(<App api={api} agent={createDemoAgentApi({ stepMs: 0 })} source="demo" now={() => NOW} searchDelay={0} />);
  return { api, user };
}

async function openMemory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Memory" }));
  const view = await screen.findByRole("region", { name: "Memory" });
  await within(view).findByRole("list", { name: "Memories" });
  return view;
}

const card = (key: string) => screen.getByRole("article", { name: key });
const keysIn = (list: HTMLElement) => within(list).getAllByRole("article").map((a) => a.querySelector(".memory-key")?.textContent);

afterEach(cleanup);

describe("memory view", () => {
  it("opens from the sidebar and lists active memories, pinned first", async () => {
    const { user } = setup();
    const view = await openMemory(user);
    expect(within(view).getByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    expect(within(view).getByText(/Edits keep a history; deletes are permanent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Memory" }).getAttribute("aria-current")).toBe("page");

    const list = within(view).getByRole("list", { name: "Memories" });
    expect(keysIn(list)).toEqual(["style.semicolons", "state.library", "tests.location", "pkg.manager"]);
    // Kind, scope (project name or Global) and trust are shown on each row.
    const row = card("state.library");
    expect(within(row).getByText("Decision")).toBeTruthy();
    expect(within(row).getByText("shop-app")).toBeTruthy();
    expect(within(row).getByText("Set by you")).toBeTruthy();
    expect(within(card("style.semicolons")).getByText("Global")).toBeTruthy();
    expect(within(card("style.semicolons")).getByText(/Used 4 times · updated 5 hours ago/)).toBeTruthy();
    // The superseded version is hidden until asked for.
    expect(within(view).queryByText("Use npm.")).toBeNull();
    await user.click(within(view).getByRole("switch", { name: "Show superseded" }));
    const old = await within(view).findByRole("list", { name: "Superseded memories" });
    expect(within(old).getByText("Use npm.")).toBeTruthy();
    expect(within(old).getByText("Superseded")).toBeTruthy();
    // Old versions can't be edited.
    expect(within(old).queryByRole("button", { name: "Edit pkg.manager" })).toBeNull();
  });

  it("filters by search text, scope and kind", async () => {
    const { user } = setup();
    const view = await openMemory(user);
    await user.type(within(view).getByLabelText("Search memories"), "zustand");
    await waitFor(() => expect(keysIn(within(view).getByRole("list", { name: "Memories" }))).toEqual(["state.library"]));
    await user.clear(within(view).getByLabelText("Search memories"));
    await waitFor(() => expect(within(view).getAllByRole("article")).toHaveLength(4));

    await user.selectOptions(within(view).getByLabelText("Scope"), "Global");
    await waitFor(() => expect(keysIn(within(view).getByRole("list", { name: "Memories" }))).toEqual(["style.semicolons", "pkg.manager"]));
    await user.selectOptions(within(view).getByLabelText("Scope"), "shop-app");
    await waitFor(() => expect(keysIn(within(view).getByRole("list", { name: "Memories" }))).toEqual(["state.library", "tests.location"]));

    await user.click(within(within(view).getByRole("group", { name: "Kind" })).getByRole("button", { name: "Convention" }));
    await waitFor(() => expect(keysIn(within(view).getByRole("list", { name: "Memories" }))).toEqual(["tests.location"]));
    await user.click(within(view).getByRole("button", { name: "Lesson" }));
    expect(await within(view).findByText("No memories match these filters.")).toBeTruthy();
  });

  it("paginates with Load more", async () => {
    const many = seed();
    for (let i = 0; i < 25; i++) {
      many.memories!.push(memory(`mem_x${i}`, { key: `extra.k${i}`, body: `Extra ${i}`, updatedAt: NOW - (10 + i) * HOUR }));
    }
    const { user } = setup({ seed: many });
    const view = await openMemory(user);
    expect(within(view).getAllByRole("article")).toHaveLength(20);
    await user.click(within(view).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(view).getAllByRole("article")).toHaveLength(29));
    expect(within(view).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("creates a memory, and shows the service's validation error for an invalid one", async () => {
    const { api, user } = setup();
    const view = await openMemory(user);
    await user.click(within(view).getByRole("button", { name: "New memory" }));
    const form = within(view).getByRole("form", { name: "New memory" });
    expect(within(form).getByText(/a short subject, e.g. style.semicolons/i)).toBeTruthy();

    // Empty key: the API rejects it and the form says why.
    await user.type(within(form).getByLabelText("Text"), "Prefer early returns.");
    await user.click(within(form).getByRole("button", { name: "Save memory" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Key can't be empty.");

    await user.type(within(form).getByLabelText("Key"), "style.returns");
    await user.selectOptions(within(form).getByLabelText("Kind"), "Convention");
    await user.selectOptions(within(form).getByLabelText("Applies to"), "shop-app");
    await user.click(within(form).getByLabelText(/Pin: always include/));
    await user.click(within(form).getByRole("button", { name: "Save memory" }));

    await waitFor(() => expect(within(view).queryByRole("form", { name: "New memory" })).toBeNull());
    const row = await screen.findByRole("article", { name: "style.returns" });
    expect(within(row).getByText("Prefer early returns.")).toBeTruthy();
    expect(within(row).getByText("Convention")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Unpin style.returns" })).toBeTruthy();
    const page = await api.listMemories({ query: "early returns" });
    expect(page.items[0]).toMatchObject({ scope: "project", projectId: SHOP, kind: "convention", pinned: true, trust: "user" });
  });

  it("explains when a project's memory mode forbids saving", async () => {
    const s = seed();
    s.settings!.projectModes[BILLING] = "read_only";
    const { user } = setup({ seed: s });
    const view = await openMemory(user);
    await user.click(within(view).getByRole("button", { name: "New memory" }));
    const form = within(view).getByRole("form", { name: "New memory" });
    await user.selectOptions(within(form).getByLabelText("Applies to"), "billing-api");
    await user.type(within(form).getByLabelText("Key"), "db.engine");
    await user.type(within(form).getByLabelText("Text"), "Postgres 16.");
    await user.click(within(form).getByRole("button", { name: "Save memory" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/read only or off/);
  });

  it("edits a memory into a new version and shows the old one in its history", async () => {
    const { user } = setup();
    const view = await openMemory(user);
    await user.click(within(card("state.library")).getByRole("button", { name: "Edit state.library" }));
    const form = within(view).getByRole("form", { name: "Edit state.library" });
    const text = within(form).getByLabelText("Text");
    await user.clear(text);
    await user.type(text, "Use Zustand with persist middleware.");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    const row = await screen.findByRole("article", { name: "state.library" });
    await within(row).findByText("Use Zustand with persist middleware.");
    expect(within(view).queryByText("Use Zustand for client state; no Redux.")).toBeNull();

    await user.click(within(row).getByText("Use Zustand with persist middleware."));
    const detail = await screen.findByRole("complementary", { name: "Memory details" });
    const history = await within(detail).findByRole("region", { name: "Version history" });
    expect(within(history).getByText("Use Zustand for client state; no Redux.")).toBeTruthy();
    const activity = within(detail).getByRole("region", { name: "Activity" });
    const events = within(activity).getAllByRole("listitem").map((li) => li.textContent);
    expect(events[0]).toMatch(/^Edited by you/);
    expect(events.some((e) => /Replaced by a newer version \(earlier version\)/.test(e ?? ""))).toBe(true);
  });

  it("opens a memory's details and closes them", async () => {
    const { user } = setup();
    const view = await openMemory(user);
    await user.click(within(card("pkg.manager")).getByText("Use pnpm for all new projects."));
    const detail = await screen.findByRole("complementary", { name: "Memory details" });
    expect(within(detail).getByRole("heading", { name: "pkg.manager" })).toBeTruthy();
    expect(await within(detail).findByText("Use npm.")).toBeTruthy();
    await user.click(within(detail).getByRole("button", { name: "Close details" }));
    expect(within(view).queryByRole("complementary")).toBeNull();
  });

  it("pins and unpins", async () => {
    const { api, user } = setup();
    await openMemory(user);
    await user.click(within(card("tests.location")).getByRole("button", { name: "Pin tests.location" }));
    await within(card("tests.location")).findByRole("button", { name: "Unpin tests.location" });
    expect((await api.getMemory("mem_3")).memory.pinned).toBe(true);
    await user.click(within(card("style.semicolons")).getByRole("button", { name: "Unpin style.semicolons" }));
    await within(card("style.semicolons")).findByRole("button", { name: "Pin style.semicolons" });
    expect((await api.getMemory("mem_1")).memory.pinned).toBe(false);
  });

  it("deletes only after confirming", async () => {
    const { api, user } = setup();
    const view = await openMemory(user);
    await user.click(within(card("tests.location")).getByRole("button", { name: "Delete tests.location" }));
    const confirm = within(card("tests.location")).getByRole("group", { name: "Delete tests.location" });
    expect(within(confirm).getByText("Delete permanently?")).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(card("tests.location")).queryByText("Delete permanently?")).toBeNull();

    await user.click(within(card("tests.location")).getByRole("button", { name: "Delete tests.location" }));
    await user.click(within(within(card("tests.location")).getByRole("group")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(view).queryByRole("article", { name: "tests.location" })).toBeNull());
    await expect(api.getMemory("mem_3")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refreshes when memory changes elsewhere", async () => {
    const { api, user } = setup();
    const view = await openMemory(user);
    await api.createMemory({ kind: "lesson", scope: "global", key: "debug.metro", body: "Clear the Metro cache first." });
    expect(await within(view).findByRole("article", { name: "debug.metro" })).toBeTruthy();
  });
});

describe("review inbox", () => {
  it("lists proposals and accepts, edits-and-accepts or rejects them", async () => {
    const { api, user } = setup();
    const view = await openMemory(user);
    await user.click(within(view).getByRole("tab", { name: /^Review/ }));
    const list = await within(view).findByRole("list", { name: "Proposed memories" });
    const tz = within(list).getByRole("article", { name: "dates.timezone" });
    expect(within(tz).getByText("Format customer-facing dates in the customer's timezone.")).toBeTruthy();
    expect(within(tz).getByText("Convention")).toBeTruthy();
    expect(within(tz).getByText("shop-app")).toBeTruthy();
    expect(within(tz).getByText("seen in 2 sessions · expires in 12 days")).toBeTruthy();

    // The evidence: what was said, by whom, and a way to it in history.
    await user.click(within(tz).getByRole("button", { name: "Show 2 pieces of evidence" }));
    const shown = await within(tz).findByRole("list", { name: "2 pieces of evidence" });
    expect(within(shown).getByText("You said")).toBeTruthy();
    expect(within(shown).getByText("Add a cart badge.")).toBeTruthy();
    expect(within(shown).getByText("The agent")).toBeTruthy();
    expect(within(shown).getAllByRole("button", { name: "Open in session" })).toHaveLength(2);
    await user.click(within(tz).getByRole("button", { name: "Hide evidence" }));
    expect(within(tz).queryByRole("list", { name: "2 pieces of evidence" })).toBeNull();

    await user.click(within(tz).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(within(list).queryByRole("article", { name: "dates.timezone" })).toBeNull());
    expect((await api.listMemories({ query: "timezone" })).items[0]).toMatchObject({ key: "dates.timezone", trust: "user" });

    await user.click(within(within(list).getByRole("article", { name: "reply.tone" })).getByRole("button", { name: "Reject" }));
    expect(await within(view).findByText("Nothing to review. Memories the agent proposes on its own will appear here.")).toBeTruthy();
    expect((await api.listMemories({ query: "short" })).items).toHaveLength(0);
  });

  it("opens the session a piece of evidence comes from, at that message", async () => {
    const { user } = setup();
    const view = await openMemory(user);
    await user.click(within(view).getByRole("tab", { name: /^Review/ }));
    const tz = await within(view).findByRole("article", { name: "dates.timezone" });
    await user.click(within(tz).getByRole("button", { name: "Show 2 pieces of evidence" }));
    const [first] = await within(tz).findAllByRole("button", { name: "Open in session" });
    await user.click(first!);
    const session = await screen.findByRole("article");
    expect(within(session).getByText("Add a cart badge.")).toBeTruthy();
  });

  it("edits a proposal before accepting it", async () => {
    const { api, user } = setup();
    const view = await openMemory(user);
    await user.click(within(view).getByRole("tab", { name: /^Review/ }));
    const tone = await within(view).findByRole("article", { name: "reply.tone" });
    await user.click(within(tone).getByRole("button", { name: "Edit & accept" }));
    const form = within(view).getByRole("form", { name: "Edit reply.tone" });
    await user.clear(within(form).getByLabelText("Text"));
    await user.type(within(form).getByLabelText("Text"), "Keep answers short; code first.");
    await user.click(within(form).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(within(view).queryByRole("form")).toBeNull());
    expect((await api.listMemories({ query: "code first" })).items[0]).toMatchObject({ key: "reply.tone", body: "Keep answers short; code first." });
  });
});

describe("used memories under answers", () => {
  it("lists what an answer used and opens a memory from there", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    const article = await screen.findByRole("article");
    const summary = await within(article).findByText("Used 2 memories");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(within(details).getByText("possibly outdated")).toBeTruthy();
    expect(within(details).getByText("keyword match")).toBeTruthy();
    expect(within(details).getByText("trust: user")).toBeTruthy();
    // Only the user's message and one assistant message: one disclosure.
    expect(within(article).getAllByText(/^Used \d+ memor/)).toHaveLength(1);

    await user.click(within(details).getByRole("button", { name: /Use Zustand for client state/ }));
    const detail = await screen.findByRole("complementary", { name: "Memory details" });
    expect(within(detail).getByRole("heading", { name: "state.library" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "state.library" }).className).toContain("selected");
  });

  it("asks once per message and stays quiet when the service fails", async () => {
    const calls: string[] = [];
    setup({
      wrap: (api) => ({
        ...api,
        getUsedMemories: async (id) => {
          calls.push(id);
          throw new Error("unavailable");
        },
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    const article = await screen.findByRole("article");
    await within(article).findByText(/CartBadge/);
    await waitFor(() => expect(calls).toEqual(["ses_1_m1"]));
    expect(within(article).queryByText(/^Used \d+ memor/)).toBeNull();
    expect(within(article).queryByRole("alert")).toBeNull();
  });

  it("truncates long items", async () => {
    const s = seed();
    s.usedMemories = {
      ses_1_m1: [{ ref: { type: "doc", id: "doc_1" }, text: "x".repeat(300), score: 1, reasons: [], possiblyOutdated: false, tokens: 80 }],
    };
    const { user } = setup({ seed: s });
    await user.click(await screen.findByRole("button", { name: /^Add cart badge/ }));
    const summary = await screen.findByText("Used 1 memory");
    const text = summary.closest("details")!.querySelector(".used-text")!;
    expect(text.textContent!.length).toBe(140);
    expect(text.textContent!.endsWith("…")).toBe(true);
  });
});

describe("memory settings", () => {
  it("saves per-project modes, the switches and the embedding model", async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Model settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("tab", { name: "Memory" }));

    expect(await within(dialog).findByText(/saves nothing new/)).toBeTruthy();
    const billing = within(dialog).getByLabelText("billing-api") as HTMLSelectElement;
    expect(billing.value).toBe("on");
    await user.selectOptions(billing, "Off");
    await waitFor(async () => expect((await api.getSettings()).projectModes).toEqual({ [SHOP]: "on", [BILLING]: "off" }));
    await user.selectOptions(within(dialog).getByLabelText("shop-app"), "Read only");
    await waitFor(async () => expect((await api.getSettings()).projectModes[SHOP]).toBe("read_only"));

    const recurring = within(dialog).getByRole("switch", { name: "Accept proposals that recur across sessions" });
    expect((recurring as HTMLInputElement).checked).toBe(false);
    await user.click(recurring);
    await waitFor(async () => expect((await api.getSettings()).autoAcceptRecurring).toBe(true));
    await user.click(within(dialog).getByRole("switch", { name: "Learn from finished tasks automatically" }));
    await waitFor(async () => expect((await api.getSettings()).autoExtract).toBe(false));
    expect(within(dialog).getAllByText(/proposed memories wait in the Review tab/i)).toHaveLength(2);

    const model = within(dialog).getByLabelText("Embedding model");
    await user.clear(model);
    await user.type(model, "nomic-embed-text");
    // Saved on blur, not on every keystroke.
    expect((await api.getSettings()).embeddingModel).toBe("embeddinggemma");
    await user.tab();
    await waitFor(async () => expect((await api.getSettings()).embeddingModel).toBe("nomic-embed-text"));
  });
});

describe("memory approvals", () => {
  it("asks before the agent saves a memory", async () => {
    const decisions: string[] = [];
    const user = userEvent.setup();
    render(
      <ApprovalCard
        approval={{ runId: "r1", sessionId: "s1", requestId: "q1", kind: "memory", command: "style.quotes: Prefer double quotes.", cwd: "~/Projects/shop-app" }}
        onDecide={(d) => decisions.push(d)}
      />,
    );
    const card = screen.getByRole("alertdialog", { name: "Save this to memory?" });
    expect(within(card).getByText(/Prefer double quotes/)).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Deny" }));
    expect(decisions).toEqual(["deny"]);
    // Memory saves are approved one at a time.
    expect(within(card).queryByRole("button", { name: /for this session/ })).toBeNull();
  });
});

describe("memory citations in answers", () => {
  it("hides citation tags, real or made up, but keeps markdown links", () => {
    expect(stripCitations("Use pnpm [m:4f2a9c] and short commits [m:global:commit_messages].")).toBe("Use pnpm and short commits.");
    expect(stripCitations("Seen before [e:a1b2c3]")).toBe("Seen before");
    expect(stripCitations("[m:docs](https://example.com)")).toBe("[m:docs](https://example.com)");
    // Code is left alone.
    expect(stripCitations("Use `s[m:len(s)]` here")).toBe("Use `s[m:len(s)]` here");
    expect(stripCitations("```py\nprint(s[m:n])\n```\nDone [m:4f2a9c].")).toBe("```py\nprint(s[m:n])\n```\nDone.");
    expect(stripCitations("x = arr[m:n]")).toBe("x = arr[m:n]");
  });

  it("renders answers without the tags", () => {
    render(<Markdown text="Use pnpm [m:4f2a9c]." />);
    expect(screen.getByText("Use pnpm.")).toBeTruthy();
    expect(screen.queryByText(/m:4f2a9c/)).toBeNull();
  });
});

describe("docs panel", () => {
  const projects = [
    { id: SHOP, name: "shop-app", path: "/p/shop" },
    { id: BILLING, name: "billing-api", path: "/p/billing" },
  ];
  const docsApi = () =>
    createMockMemoryApi({
      now: () => NOW,
      jobStepMs: 1,
      seed: {
        projectVersions: { [SHOP]: { "react-native": "0.77.1", zustand: "5.0.1" } },
        docPacks: {
          [SHOP]: [
            { id: "pack_new", library: "react-native", version: "0.77", status: "ready", chunkCount: 2100, sourceUrl: "https://github.com/facebook/react-native-website", retrievedAt: NOW - HOUR, label: "React Native" },
            { id: "pack_old", library: "react-native", version: "0.76", status: "stale", chunkCount: 2050, sourceUrl: "https://github.com/facebook/react-native-website", label: "React Native" },
            { id: "pack_bad", library: "expo", version: "52", status: "failed", chunkCount: 0, sourceUrl: "https://www.npmjs.com/package/expo", label: "Expo SDK", error: "network down" },
          ],
        },
      },
    });

  it("shows a project's packs, what went stale, what failed and why", async () => {
    const { DocsPanel } = await import("../src/renderer/src/components/DocsPanel");
    render(<DocsPanel api={docsApi() as unknown as HistoryApi} projects={projects} now={NOW} onReview={() => {}} />);
    const list = await screen.findByRole("list", { name: "Docs packs" });
    expect(within(list).getByRole("listitem", { name: "React Native 0.77" }).textContent).toMatch(/Ready · 2,100 sections/);
    expect(within(list).getByRole("listitem", { name: "React Native 0.76" }).textContent).toMatch(/Stale: the project moved to a newer version/);
    const bad = within(list).getByRole("listitem", { name: "Expo SDK 52" });
    expect(bad.textContent).toMatch(/network down/);
    expect(within(bad).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(list).getByRole("listitem", { name: "React Native 0.76" }).querySelector("button")).toBeNull(); // stale: nothing to rebuild
  });

  it("builds docs for a library without a current pack", async () => {
    const user = userEvent.setup();
    const api = docsApi();
    const { DocsPanel } = await import("../src/renderer/src/components/DocsPanel");
    render(<DocsPanel api={api as unknown as HistoryApi} projects={projects} now={NOW} onReview={() => {}} />);
    const missing = await screen.findByRole("list", { name: "Libraries without docs" });
    const row = within(missing).getByRole("listitem", { name: "zustand 5.0.1" });
    await user.click(within(row).getByRole("button", { name: "Build docs" }));
    await waitFor(async () => expect((await api.listDocPacks(SHOP)).some((p) => p.library === "zustand")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Libraries without docs" })).toBeNull());
    expect(within(screen.getByRole("list", { name: "Docs packs" })).getByRole("listitem", { name: "zustand 5.0.1" })).toBeTruthy();
  });

  it("imports conventions and points to the Review tab", async () => {
    const user = userEvent.setup();
    const api = docsApi() as unknown as HistoryApi;
    let reviewed = 0;
    const seeded = { ...api, seedProject: async () => ({ created: 3, files: ["CLAUDE.md", "README.md"] }) } as HistoryApi;
    const { DocsPanel } = await import("../src/renderer/src/components/DocsPanel");
    render(<DocsPanel api={seeded} projects={projects} now={NOW} onReview={() => reviewed++} />);
    await user.click(await screen.findByRole("button", { name: "Import conventions" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Proposed 3 conventions from CLAUDE\.md, README\.md/);
    await user.click(screen.getByRole("button", { name: "Review them" }));
    expect(reviewed).toBe(1);
  });

  it("asks for a project folder when there is none", async () => {
    const { DocsPanel } = await import("../src/renderer/src/components/DocsPanel");
    render(<DocsPanel api={docsApi() as unknown as HistoryApi} projects={[]} now={NOW} onReview={() => {}} />);
    expect(screen.getByText(/Add a project folder first/)).toBeTruthy();
  });
});

describe("fixes panel", () => {
  const episode = (id: string, o: Partial<import("@kovach-dev/memory-contract").Episode> = {}): import("@kovach-dev/memory-contract").Episode => ({
    id,
    projectId: SHOP,
    problem: "The order list crashed when items were missing.",
    errorSignature: "TypeError: Cannot read properties of undefined (reading 'map')",
    env: { "react-native": "0.77.1" },
    attempts: [
      { approach: "Still failing: TypeError …", outcome: "failed" },
      { approach: "Changed src/orders.tsx", outcome: "passed" },
    ],
    fixSummary: "Defaulted items to [] in src/orders.tsx.",
    files: ["src/orders.tsx"],
    verifiedBy: "test",
    lesson: "Default optional arrays before .map().",
    status: "active",
    createdAt: NOW - HOUR,
    ...o,
  });
  const projects = [{ id: SHOP, name: "shop-app", path: "/p/shop" }];

  it("lists verified fixes with their lesson, and shows attempts, files and versions on open", async () => {
    const user = userEvent.setup();
    const api = createMockMemoryApi({ now: () => NOW, seed: { episodes: [episode("ep_1"), episode("ep_2", { problem: "Build broke on a missing env type", lesson: undefined, verifiedBy: "build", createdAt: NOW - 2 * HOUR })] } });
    const { FixesPanel } = await import("../src/renderer/src/components/FixesPanel");
    render(<FixesPanel api={api as unknown as HistoryApi} projects={projects} now={NOW} searchDelay={0} />);
    const list = await screen.findByRole("list", { name: "Fixes" });
    const first = within(list).getByRole("listitem", { name: "The order list crashed when items were missing." });
    expect(first.textContent).toMatch(/Lesson: Default optional arrays before \.map\(\)\./);
    expect(first.textContent).toMatch(/Verified by tests/);
    expect(first.textContent).toMatch(/2 attempts/);
    await user.click(within(first).getByRole("button", { name: /order list crashed/ }));
    expect(first.textContent).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(first.textContent).toMatch(/src\/orders\.tsx/);
    expect(first.textContent).toMatch(/With react-native 0\.77\.1/);
    expect(within(list).getByRole("listitem", { name: "Build broke on a missing env type" }).textContent).toMatch(/Verified by the build/);
  });

  it("searches, and deletes a fix after confirming", async () => {
    const user = userEvent.setup();
    const api = createMockMemoryApi({ now: () => NOW, seed: { episodes: [episode("ep_1"), episode("ep_2", { problem: "Build broke on a missing env type", lesson: undefined })] } });
    const { FixesPanel } = await import("../src/renderer/src/components/FixesPanel");
    render(<FixesPanel api={api as unknown as HistoryApi} projects={projects} now={NOW} searchDelay={0} />);
    await user.type(await screen.findByRole("searchbox", { name: "Search fixes" }), "env type");
    await waitFor(() => expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("fix-row"))).toHaveLength(1));
    const row = screen.getByRole("listitem", { name: "Build broke on a missing env type" });
    await user.click(within(row).getByRole("button", { name: /Build broke/ }));
    await user.click(within(row).getByRole("button", { name: "Delete this fix" }));
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Build broke on a missing env type" })).toBeNull());
    expect((await api.listEpisodes({})).items.map((e) => e.id)).toEqual(["ep_1"]);
  });

  it("explains what appears here when there are no fixes yet", async () => {
    const { FixesPanel } = await import("../src/renderer/src/components/FixesPanel");
    render(<FixesPanel api={createMockMemoryApi({ now: () => NOW }) as unknown as HistoryApi} projects={projects} now={NOW} searchDelay={0} />);
    expect(await screen.findByText(/No fixes yet/)).toBeTruthy();
  });
});

describe("proposals from sessions (Phase 5)", () => {
  it("shows how many proposals from sessions you accepted, once there are enough decisions", async () => {
    const s = seed();
    s.candidates = Array.from({ length: 6 }, (_, i) => ({
      id: `cand_p${i}`,
      kind: "preference" as const,
      scope: "global" as const,
      key: `pref.p${i}`,
      body: `Preference number ${i}.`,
      evidence: [{ type: "message" as const, id: "ses_1_m0" }],
      seenInSessions: 1,
      expiresAt: NOW + 20 * 24 * HOUR,
      createdAt: NOW - HOUR,
    }));
    const { api, user } = setup({ seed: s });
    // Nothing shown before there are enough decisions to mean something.
    const view = await openMemory(user);
    await user.click(within(view).getByRole("tab", { name: /^Review/ }));
    await within(view).findByRole("article", { name: "pref.p0" });
    expect(within(view).queryByLabelText("Review precision")).toBeNull();
    for (let i = 0; i < 4; i++) await api.resolveCandidate(`cand_p${i}`, "accept");
    await api.resolveCandidate("cand_p4", { edit: { body: "Preference four, reworded." } });
    await api.resolveCandidate("cand_p5", "reject");
    const line = await within(view).findByLabelText("Review precision");
    expect(line.textContent).toBe("From sessions, you've accepted 5 of 6 proposals in the last 90 days (83%), 1 after an edit. The goal is 85% or more.");
  });

  it("asks which value is right when a proposal contradicts something you set, and keeps yours if you say so", async () => {
    const s = seed();
    s.candidates = [
      {
        id: "cand_q",
        kind: "preference",
        scope: "global",
        key: "pkg.manager",
        body: "Use bun for new projects.",
        evidence: [{ type: "message", id: "ses_1_m0" }],
        conflictsWith: "mem_5",
        seenInSessions: 1,
        expiresAt: NOW + 20 * 24 * HOUR,
        createdAt: NOW - HOUR,
      },
      {
        id: "cand_web",
        kind: "research",
        scope: "project",
        projectId: SHOP,
        key: "flatlist.window",
        body: "FlatList windowSize defaults to 21.",
        evidence: [
          { type: "tool_call", id: "tc_1" },
          { type: "source", id: "src_1" },
        ],
        seenInSessions: 1,
        expiresAt: NOW + 20 * 24 * HOUR,
        createdAt: NOW - HOUR,
      },
      {
        id: "cand_file",
        kind: "convention",
        scope: "project",
        projectId: SHOP,
        key: "agents.state",
        body: "Keep global state in Zustand stores.",
        evidence: [{ type: "source", id: "src_2" }],
        seenInSessions: 1,
        expiresAt: NOW + 20 * 24 * HOUR,
        createdAt: NOW - HOUR,
      },
    ];
    const { api, user } = setup({ seed: s });
    const view = await openMemory(user);
    await user.click(within(view).getByRole("tab", { name: /^Review/ }));
    const q = await within(view).findByRole("article", { name: /Which is right now for/ });
    expect(q.textContent).toMatch(/You said before\s*Use pnpm for all new projects\./);
    expect(q.textContent).toMatch(/A recent session suggests\s*Use bun for new projects\./);
    expect(within(view).getByRole("article", { name: "flatlist.window" }).textContent).toMatch(/From a web page/);
    const fromFile = within(view).getByRole("article", { name: "agents.state" }).textContent;
    expect(fromFile).toMatch(/From a project file/);
    expect(fromFile).not.toMatch(/From a web page/);
    await user.click(within(q).getByRole("button", { name: "Keep what I said" }));
    await waitFor(() => expect(within(view).queryByRole("article", { name: /Which is right now/ })).toBeNull());
    expect((await api.getMemory("mem_5")).memory.status).toBe("active");
  });

  it("flags research whose source changed, and 'Still true' brings it back", async () => {
    const s = seed();
    s.memories = [
      ...(s.memories ?? []),
      memory("mem_r", { key: "flatlist.window", body: "FlatList windowSize defaults to 21.", kind: "research", projectId: SHOP, status: "stale" }),
    ];
    const { api, user } = setup({ seed: s });
    const view = await openMemory(user);
    const card = await within(view).findByRole("article", { name: "flatlist.window" });
    expect(card.textContent).toMatch(/Needs a re-check/);
    await user.click(within(card).getByRole("button", { name: "flatlist.window is still true" }));
    await waitFor(async () => expect((await api.listMemories({ query: "windowSize" })).items.some((m) => m.status === "active")).toBe(true));
  });
});

describe("tables in answers", () => {
  it("renders a Markdown table as a table, and leaves a lone pipe in prose alone", () => {
    const { container } = render(<Markdown text={"What to fill in:\n\n| Placeholder | Where |\n|---|---|\n| `[Phone]` | Contact, footer |\n| [Address] | Hero |\n\nUse a | b here."} />);
    const table = container.querySelector(".md-table table")!;
    expect([...table.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["Placeholder", "Where"]);
    expect([...table.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
      ["[Phone]", "Contact, footer"],
      ["[Address]", "Hero"],
    ]);
    expect(table.querySelector("td code")!.textContent).toBe("[Phone]");
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.textContent).toContain("Use a | b here.");
  });
});
