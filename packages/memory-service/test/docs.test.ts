import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  breakingVersion,
  chunkMarkdown,
  createHistoryStore,
  createJobRunner,
  createMemoryStore,
  type Db,
  extractItems,
  fetchDocs,
  findConventions,
  type HistoryStore,
  type MemoryStore,
  migrate,
  openDatabase,
  parseGithubRepo,
  pickTag,
  planDocs,
  seedKey,
  selectFiles,
} from "../src/index.js";
import { fakeDocsFetcher, RN_REPO } from "./helpers/fake-docs.js";
import { fakeEmbedder } from "./helpers/fake-embedder.js";

let dir: string;
let db: Db;
let h: HistoryStore;
let t: number;
let n: number;
const ids = (p: string) => `${p}_${String(++n).padStart(6, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-docs-"));
  db = openDatabase(":memory:");
  migrate(db);
  t = 1_000;
  n = 0;
  h = createHistoryStore(db, { blobs: new BlobStore(dir), now: () => ++t, newId: ids });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(name: string, deps: Record<string, string>, files: Record<string, string> = {}) {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, dependencies: deps }));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return { root, id: h.ensureProject({ path: root, name }) };
}

describe("chunking", () => {
  it("splits a page by heading, with the heading path, anchors and cleaned MDX", () => {
    const md = [
      "---",
      "title: Using FlatList",
      "---",
      "import Tabs from '@theme/Tabs';",
      "",
      "Intro text that is long enough to stand on its own as a section of the page.",
      "",
      "## Props",
      "",
      "<Tabs>",
      "### initialNumToRender",
      "How many items to render in the initial batch, enough to fill the screen.",
      "</Tabs>",
      "",
      ":::note",
      "Keep this small on low-end Android devices.",
      ":::",
      "",
      "```js",
      "## not a heading inside code",
      "<FlatList initialNumToRender={10} />",
      "```",
    ].join("\n");
    const chunks = chunkMarkdown(md, { path: "docs/flatlist.md", pageUrl: "https://x/flatlist" });
    expect(chunks.map((c) => c.heading)).toEqual(["Using FlatList", "Using FlatList › Props › initialNumToRender"]);
    expect(chunks[1]!.url).toBe("https://x/flatlist#initialnumtorender");
    expect(chunks[1]!.text).toContain("## not a heading inside code");
    expect(chunks[1]!.text).toContain("**Note:**");
    expect(chunks.map((c) => c.text).join("\n")).not.toMatch(/import Tabs|<Tabs>|<\/Tabs>/);
  });

  it("keeps long sections under the size limit without splitting code", () => {
    const code = "```ts\n" + "const x = 1;\n".repeat(40) + "```";
    const md = `## Big\n\n${"Words in a paragraph. ".repeat(60)}\n\n${code}\n\n${"More words here. ".repeat(60)}`;
    const chunks = chunkMarkdown(md, { path: "big.md", pageUrl: "u" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect((c.text.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe("docs sources", () => {
  it("reads versions, tags and repo URLs", () => {
    expect(breakingVersion("0.76.3")).toBe("0.76");
    expect(breakingVersion("^19.1.0")).toBe("19");
    expect(pickTag(["v22.1.0", "v22.11.0", "v22.9.0", "v23.0.0", "v22.12.0-rc.1"], "22")).toBe("v22.11.0");
    expect(pickTag(["zustand@4.5.0"], "4", "zustand@")).toBe("zustand@4.5.0");
    expect(parseGithubRepo("git+https://github.com/pmndrs/zustand.git")).toBe("pmndrs/zustand");
    expect(parseGithubRepo("github:facebook/react")).toBe("facebook/react");
    expect(parseGithubRepo("https://gitlab.com/x/y")).toBeUndefined();
  });

  it("finds the exact React Native docs, the nearest when a version is gone, and the unreleased ones for a newer version", async () => {
    const f = fakeDocsFetcher({ "facebook/react-native-website": RN_REPO });
    expect(await planDocs("react-native", "0.76.3", f)).toMatchObject({ include: ["website/versioned_docs/version-0.76/"], docsVersion: "0.76" });
    const near = await planDocs("react-native", "0.75.0", f);
    expect(near).toMatchObject({ docsVersion: "0.76", note: expect.stringMatching(/nearest/) });
    expect(await planDocs("react-native", "0.80.0", f)).toMatchObject({ include: ["docs/"], docsVersion: "next" });
  });

  it("picks the release tag for Node.js and a library's own docs folder from npm", async () => {
    const f = fakeDocsFetcher(
      {
        "nodejs/node": { "v22.11.0": { "doc/api/fs.md": "# File system\n\n## fs.readFile(path)\n\nReads the entire contents of a file asynchronously." } },
        "pmndrs/zustand": { "v5.0.1": { "docs/guides/slices.md": "# Slices\n\nSplit a big store into smaller slices that you combine into one bound store with the create function.", "README.md": "# Zustand\n\nA small, fast and scalable bearbones state management solution for React." } },
        "acme/monorepo": { "": { "packages/ui/README.md": "# UI\n\nThe UI kit's readme, long enough to be a section." } },
      },
      {
        tags: { "nodejs/node": ["v22.10.0", "v22.11.0", "v23.1.0"], "pmndrs/zustand": ["v5.0.0", "v5.0.1"], "acme/monorepo": [] },
        npm: { "zustand@5.0.1": { repo: "pmndrs/zustand" }, "@acme/ui@1.2.0": { repo: "acme/monorepo", directory: "packages/ui" } },
      },
    );
    expect(await planDocs("node", "22.3.0", f)).toMatchObject({ ref: "v22.11.0", include: ["doc/api/"] });
    const z = await fetchDocs("zustand", "5.0.1", f);
    expect(z.plan).toMatchObject({ ref: "v5.0.1", include: ["docs/", "README.md"] });
    expect(z.chunks.map((c) => c.heading)).toContain("Slices");
    expect(z.chunks[0]!.url).toMatch(/^https:\/\/github\.com\/pmndrs\/zustand\/blob\/v5\.0\.1\//);
    const mono = await planDocs("@acme/ui", "1.2.0", f);
    expect(mono).toMatchObject({ include: ["packages/ui/README.md"], note: expect.stringMatching(/default branch/) });
  });

  it("indexes pages only: no partials, blog posts or changelogs", () => {
    const plan = { repo: "r", include: ["docs/"], docsVersion: "1", pageUrl: (p: string) => p };
    expect(selectFiles(plan, ["docs/a.md", "docs/_partial.md", "docs/blog/post.md", "docs/CHANGELOG.md", "docs/img.png", "src/x.md"])).toEqual(["docs/a.md"]);
  });
});

describe("job queue", () => {
  it("runs jobs one at a time, pauses while the user works, retries once and survives a restart", async () => {
    const events: string[] = [];
    let clock = 1_000;
    const jobs = createJobRunner(db, { now: () => clock, newId: ids, onChange: (j) => events.push(`${j.id}:${j.status}`) });
    const order: string[] = [];
    let flaky = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jobs.register("embedding", async (p, ctx) => {
      if (p.name === "slow") await gate;
      await ctx.checkpoint();
      if (p.name === "flaky" && flaky++ === 0) throw new Error("socket hang up");
      order.push(String(p.name));
    });
    jobs.start();
    jobs.enqueue("embedding", { name: "slow" });
    jobs.enqueue("embedding", { name: "flaky" });
    jobs.pause();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // paused at the checkpoint
    jobs.resume();
    await jobs.idle();
    expect(order).toEqual(["slow"]); // flaky failed once and waits a minute
    clock += 61_000;
    jobs.enqueue("embedding", { name: "last" });
    await jobs.idle();
    expect(order).toEqual(["slow", "flaky", "last"]);
    expect(events.filter((e) => e.endsWith(":done"))).toHaveLength(3);

    // A job still "running" when the app quit runs again on start.
    db.prepare("INSERT INTO jobs (id, kind, status, payload_json, run_after, created_at, updated_at) VALUES ('job_x', 'embedding', 'running', '{\"name\":\"resumed\"}', 0, 0, 0)").run();
    const again = createJobRunner(db, { now: () => clock, newId: ids });
    again.register("embedding", async (p) => void order.push(String(p.name)));
    again.start();
    await again.idle();
    expect(order.at(-1)).toBe("resumed");
  });
});

describe("docs packs", () => {
  const fetcherFor = () => fakeDocsFetcher({ "facebook/react-native-website": RN_REPO });

  async function store(f = fetcherFor(), extra: Parameters<typeof createMemoryStore>[1] = {}) {
    const mem = createMemoryStore(db, { now: () => ++t, newId: ids, docsFetcher: () => f, ...extra });
    mem.jobs.start();
    return mem;
  }

  it("builds a pack for the version a project uses and searches it", async () => {
    const f = fetcherFor();
    const mem = await store(f);
    const shop = project("shop", { "react-native": "0.76.3" });
    const job = await mem.buildDocPack(shop.id, "react-native", "0.76.3");
    expect(job).toMatchObject({ kind: "doc_pack", status: "queued" });
    await mem.jobs.idle();
    const [pack] = await mem.listDocPacks(shop.id);
    expect(pack).toMatchObject({ library: "react-native", version: "0.76", status: "ready", label: "React Native", sourceUrl: "https://github.com/facebook/react-native-website" });
    expect(pack!.chunkCount).toBeGreaterThan(1);
    const hits = await mem.searchDocs({ projectId: shop.id, query: "initialNumToRender default" });
    expect(hits[0]).toMatchObject({ library: "react-native", docsVersion: "0.76", possiblyOutdated: false });
    expect(hits[0]!.heading).toBe("FlatList › Props › initialNumToRender");
    expect(hits[0]!.url).toMatch(/version-0\.76\/flatlist\.md#initialnumtorender$/);
    // No partials were read.
    expect(f.reads.some((r) => r.includes("_partial"))).toBe(false);
  });

  it("suggests the libraries a project uses and builds the curated ones without asking", async () => {
    const f = fetcherFor();
    const mem = await store(f);
    const shop = project("shop", { "react-native": "0.76.3", zustand: "5.0.1", "left-pad": "1.3.0" });
    const before = await mem.suggestDocPacks(shop.id);
    expect(before.map((s) => [s.library, s.auto, !!s.pack])).toEqual([
      ["react-native", true, false],
      ["zustand", false, false],
    ]);
    const jobs = mem.ensureDocPacks(shop.id);
    expect(jobs).toHaveLength(1);
    await mem.jobs.idle();
    expect((await mem.suggestDocPacks(shop.id))[0]!.pack).toMatchObject({ status: "ready", current: true });
    expect(mem.ensureDocPacks(shop.id)).toEqual([]); // nothing new to build

    // A second project on the same version reuses the pack.
    const reads = f.reads.length;
    const other = project("other", { "react-native": "0.76.9" });
    expect(mem.ensureDocPacks(other.id)).toEqual([]);
    expect(f.reads.length).toBe(reads);
    expect((await mem.listDocPacks(other.id))[0]).toMatchObject({ status: "ready", version: "0.76" });
  });

  it("says when a pack is waiting its turn rather than building", async () => {
    const mem = await store(fetcherFor());
    const shop = project("shop", { "react-native": "0.76.3" });
    mem.jobs.pause();
    mem.ensureDocPacks(shop.id);
    expect((await mem.listDocPacks(shop.id))[0]).toMatchObject({ status: "building", progress: "Waiting for other background work" });
    mem.jobs.resume();
    await mem.jobs.idle();
    expect((await mem.listDocPacks(shop.id))[0]).toMatchObject({ status: "ready" });
    expect((await mem.listDocPacks(shop.id))[0]!.progress).toBeUndefined();
  });

  it("shows why a build failed, and a failed rebuild keeps the docs it had", async () => {
    const f = fetcherFor();
    const mem = await store(f);
    const shop = project("shop", { "react-native": "0.76.3" });
    await mem.buildDocPack(shop.id, "react-native", "0.76.3");
    await mem.jobs.idle();
    f.failNext = "No React Native docs here";
    await mem.buildDocPack(shop.id, "react-native", "0.76.3");
    await mem.jobs.idle();
    const [pack] = await mem.listDocPacks(shop.id);
    expect(pack!.status).toBe("ready");
    expect(pack!.chunkCount).toBeGreaterThan(0);

    const bad = project("bad", { "left-pad": "1.3.0" });
    await mem.buildDocPack(bad.id, "left-pad", "1.3.0");
    await mem.jobs.idle();
    expect((await mem.listDocPacks(bad.id))[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/npm has no left-pad/) });
    await expect(mem.buildDocPack(bad.id, "left-pad", "latest")).rejects.toMatchObject({ code: "invalid" });
  });

  it("embeds docs and only puts them in a task's context when keywords and meaning agree", async () => {
    const emb = fakeEmbedder({ synonyms: { batch: "render", initial: "render" } });
    const mem = await store(fetcherFor(), { embedder: emb });
    await mem.reindex();
    const shop = project("shop", { "react-native": "0.76.3" });
    await mem.buildDocPack(shop.id, "react-native", "0.76.3");
    await mem.jobs.idle();
    expect((db.prepare("SELECT count(*) AS n FROM doc_vec").get() as { n: number }).n).toBeGreaterThan(0);
    const task = await mem.taskContext({ projectId: shop.id, text: "how many items does FlatList initialNumToRender render in the initial batch" });
    expect(task.items.some((i) => i.ref.type === "doc")).toBe(true);
    expect(task.text).toMatch(/\[d:[a-f0-9]{6}\] \(doc, official\) React Native 0\.76 docs — FlatList › Props › initialNumToRender/);
    const smallTalk = await mem.taskContext({ projectId: shop.id, text: "thanks, that's all for today" });
    expect(smallTalk.items.some((i) => i.ref.type === "doc")).toBe(false);
    // A model change resets docs vectors with the memory ones, then refills them.
    mem.setEmbedder(fakeEmbedder({ model: "other", dims: 64 }));
    const r = await mem.reindex();
    expect(r.docs).toBeGreaterThan(0);
  });
});

describe("T9: docs pack versioning", () => {
  it("an upgrade marks the old pack stale for that project only, and retrieval prefers the new one", async () => {
    const f = fakeDocsFetcher({ "facebook/react-native-website": RN_REPO });
    const mem = createMemoryStore(db, { now: () => ++t, newId: ids, docsFetcher: () => f });
    mem.jobs.start();
    const shop = project("shop", { "react-native": "0.76.3" });
    const other = project("other", { "react-native": "0.76.3" });
    mem.ensureDocPacks(shop.id);
    mem.ensureDocPacks(other.id);
    await mem.jobs.idle();

    // shop upgrades to 0.77.
    writeFileSync(join(shop.root, "package.json"), JSON.stringify({ name: "shop", dependencies: { "react-native": "0.77.1" } }));
    expect(mem.ensureDocPacks(shop.id)).toHaveLength(1);
    await mem.jobs.idle();
    const packs = await mem.listDocPacks(shop.id);
    expect(packs.map((p) => [p.version, p.status])).toEqual([
      ["0.77", "ready"],
      ["0.76", "stale"],
    ]);
    expect((await mem.listDocPacks(other.id)).map((p) => [p.version, p.status])).toEqual([["0.76", "ready"]]);

    // Retrieval in shop only uses 0.77; the other project still gets 0.76.
    const r = await mem.retrieve({ projectId: shop.id, text: "FlatList initialNumToRender default" });
    const docs = r.items.filter((i) => i.ref.type === "doc");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.text.startsWith("React Native 0.77 docs"))).toBe(true);
    expect(docs.every((d) => !d.possiblyOutdated)).toBe(true);
    const o = await mem.retrieve({ projectId: other.id, text: "FlatList initialNumToRender default" });
    expect(o.items.filter((i) => i.ref.type === "doc").every((d) => d.text.startsWith("React Native 0.76 docs"))).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(1200);
    expect(r.items.length).toBeLessThanOrEqual(6);
  });
});

describe("project seeding", () => {
  const files = {
    "CLAUDE.md": "# Project rules\n\n## Testing\n\n- Run `pnpm test` before every commit\n- Mock the network in unit tests\n  - use msw, never real servers\n\n```sh\n- not a bullet in code\n```\n\n## Secrets\n\n- The staging api key is sk-live-7f3a9c2e1b8d4f60a5e7b2c4\n",
    "README.md": "# Shop\n\n## Installation\n\n- Install Xcode 16 first\n\n## Coding style\n\n- Components are function components with hooks\n- Name files in kebab-case\n",
    ".cursor/rules/state.mdc": "---\ndescription: state\n---\n- Keep global state in Zustand stores under src/stores\n",
  };

  it("proposes conventions from the project's own files once, for review", async () => {
    const mem = createMemoryStore(db, { now: () => ++t, newId: ids });
    const shop = project("shop", { "react-native": "0.76.3" }, files);
    const res = await mem.seedProject(shop.id);
    expect(res.files.sort()).toEqual([".cursor/rules/state.mdc", "CLAUDE.md", "README.md"]);
    const cands = await mem.listCandidates();
    const bodies = cands.map((c) => c.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        "Run `pnpm test` before every commit",
        "Mock the network in unit tests; use msw, never real servers",
        "Components are function components with hooks",
        "Name files in kebab-case",
        "Keep global state in Zustand stores under src/stores",
      ]),
    );
    expect(bodies.some((b) => /Xcode/.test(b))).toBe(false); // README installation steps aren't conventions
    expect(bodies.some((b) => /sk-live/.test(b))).toBe(false); // secrets never become proposals
    expect(bodies.some((b) => /not a bullet/.test(b))).toBe(false);
    expect(cands.every((c) => c.kind === "convention" && c.scope === "project" && c.projectId === shop.id)).toBe(true);
    expect(cands.find((c) => c.body.startsWith("Run `pnpm test`"))!.key).toBe("claude.testing.run-pnpm-test-before");

    // Once per project; again on request, without repeating what is already proposed.
    expect(await mem.seedProject(shop.id)).toEqual({ created: 0, files: [] });
    expect((await mem.seedProject(shop.id, { again: true })).created).toBe(0);

    // Accepting one makes it a user-trusted project convention in the always-on block.
    const c = cands.find((x) => x.body === "Name files in kebab-case")!;
    await mem.resolveCandidate(c.id, "accept");
    expect((await mem.alwaysOn(shop.id)).text).toContain("Name files in kebab-case");
  });

  it("skips read-only projects and finds nothing in a project without such files", async () => {
    const mem = createMemoryStore(db, { now: () => ++t, newId: ids });
    const client = project("client", {}, files);
    await mem.updateSettings({ projectModes: { [client.id]: "read_only" } });
    expect(await mem.seedProject(client.id)).toEqual({ created: 0, files: [] });
    const empty = project("empty", {});
    expect(await mem.seedProject(empty.id)).toEqual({ created: 0, files: [] });
    expect(findConventions(join(dir, "empty"))).toEqual([]);
    expect(extractItems("## Notes\n- short\n- A long enough convention line", "AGENTS.md", false).map((i) => i.text)).toEqual(["A long enough convention line"]);
    expect(seedKey({ file: ".github/copilot-instructions.md", heading: "Style", text: "Prefer named exports" })).toBe("copilot.style.prefer-named-exports");
  });
});
