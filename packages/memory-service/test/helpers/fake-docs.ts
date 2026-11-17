import type { DocsFetcher } from "../../src/index.js";

/**
 * Docs repos in memory: repo → ref ("" = default branch) → path → content.
 * Counts what was fetched so tests can tell a rebuild from a reuse.
 */
export function fakeDocsFetcher(
  repos: Record<string, Record<string, Record<string, string>>>,
  extra: { tags?: Record<string, string[]>; npm?: Record<string, { repo?: string; directory?: string; version?: string }>; fail?: boolean } = {},
): DocsFetcher & { reads: string[]; failNext?: string } {
  const self: DocsFetcher & { reads: string[]; failNext?: string } = {
    reads: [],
    async list(repo, ref) {
      if (extra.fail) throw new Error("network down");
      if (self.failNext) {
        const m = self.failNext;
        self.failNext = undefined;
        throw new Error(m);
      }
      const files = repos[repo]?.[ref ?? ""];
      if (!files) throw new Error(`Remote branch ${ref} not found in ${repo}`);
      return Object.keys(files);
    },
    async tags(repo, pattern) {
      const all = extra.tags?.[repo] ?? [];
      if (pattern === "*") return all;
      const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
      return all.filter((t) => re.test(t));
    },
    async read(repo, ref, paths) {
      const files = repos[repo]?.[ref ?? ""] ?? {};
      const out = new Map<string, string>();
      for (const p of paths) {
        self.reads.push(`${repo}@${ref ?? ""}:${p}`);
        if (files[p] !== undefined) out.set(p, files[p]!);
      }
      return out;
    },
    async npm(pkg, version) {
      const m = extra.npm?.[`${pkg}@${version}`] ?? extra.npm?.[pkg];
      if (!m) throw new Error(`npm has no ${pkg}@${version}`);
      return { ...m, ...(version !== "latest" && !m.version ? { version } : {}) };
    },
  };
  return self;
}

const page = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;

/** React Native docs for 0.76 and 0.77, as the website repo lays them out. */
export const RN_REPO = {
  "": {
    "website/versioned_docs/version-0.76/flatlist.md": page(
      "FlatList",
      "A performant interface for rendering basic, flat lists.\n\n## Props\n\n### initialNumToRender\n\nHow many items to render in the initial batch. This should be enough to fill the screen but not much more. Default 10 in React Native 0.76.\n\n### removeClippedSubviews\n\nThis may improve scroll performance for large lists on older versions of the list component.",
    ),
    "website/versioned_docs/version-0.77/flatlist.md": page(
      "FlatList",
      "A performant interface for rendering basic, flat lists.\n\n## Props\n\n### initialNumToRender\n\nHow many items to render in the initial batch. In 0.77 the default changed: the list measures the window and renders enough rows to fill it.\n\n### maintainVisibleContentPosition\n\nKeeps the visible content in place when items are added above it, for chat style lists.",
    ),
    "website/versioned_docs/version-0.77/_partial.md": "# Partial\n\nNot a page of its own, only included by others, so never indexed.",
    "docs/flatlist.md": page("FlatList", "## Props\n\nThe unreleased docs for the next version of the list component and its props."),
  },
};
