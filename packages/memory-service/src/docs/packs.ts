/**
 * Docs packs (MASTER_PLAN › Write path, "Docs packs and project seeding";
 * Read path step 2). Official docs for the library versions a project uses,
 * kept in their own index, apart from memories, and searched separately.
 */
import { createHash } from "node:crypto";
import { type DocPack, type JobRef, MemoryApiError, type MemoryChangeEvent } from "@kovach-dev/memory-contract";
import type { Db } from "../db.js";
import type { Embedder } from "../embeddings.js";
import type { JobRunner } from "../jobs.js";
import type { ProjectCard } from "../scanner.js";
import { AUTO_LIBRARIES, type DocsFetcher, docsLabel, fetchDocs, packVersion, RECIPES } from "./sources.js";

export interface DocPackView extends DocPack {
  label: string;
  /** The docs version actually used, when it differs from the project's (e.g. "0.77" for 0.76). */
  docsVersion?: string;
  note?: string;
  error?: string;
  /** Progress of a running build, e.g. "Embedding 320 of 2,100". */
  progress?: string;
}

export interface DocSuggestion {
  library: string;
  label: string;
  /** The version the project uses. */
  version: string;
  /** Built automatically when a project uses it. */
  auto: boolean;
  /** This project's pack for the library, if any, and whether it matches the version in use. */
  pack?: { id: string; status: DocPack["status"]; version: string; current: boolean };
}

export interface DocHit {
  id: string;
  handle: string;
  library: string;
  label: string;
  docsVersion: string;
  heading: string;
  text: string;
  url: string;
  score: number;
  possiblyOutdated: boolean;
  /** Found by keywords and by meaning. */
  agreed: boolean;
}

interface PackRow {
  id: string;
  library: string;
  version: string;
  status: DocPack["status"];
  source_url: string;
  retrieved_at: number | null;
  note: string | null;
  last_error: string | null;
  ref: string | null;
  docs_version: string | null;
  repo: string | null;
}

const RRF_K = 60;
const EMBED_BATCH = 32;
export const docHandle = (id: string) => `d:${createHash("sha256").update(id).digest("hex").slice(0, 6)}`;

/** The project's version of a library, as the scanner saw it ("node" comes from engines/.nvmrc). */
const projectVersion = (card: ProjectCard | undefined, library: string) => card?.versions[library];

export function createDocsIndex(
  db: Db,
  deps: {
    now: () => number;
    newId: (prefix: string) => string;
    emit: (e: MemoryChangeEvent) => void;
    jobs: JobRunner;
    projectCard: (projectId: string) => ProjectCard | undefined;
    projectMode: (projectId: string | undefined) => "on" | "read_only" | "off";
    terms: (text: string) => string[];
    embedder: () => Embedder | undefined;
    /** Model and dims of the vector index, when it is usable with the current embedder. */
    vectorMeta: () => { model: string; dims: number } | undefined;
    fetcher?: () => DocsFetcher;
  },
) {
  const { now, newId, emit, jobs } = deps;

  const pack = (id: string) => db.prepare("SELECT * FROM doc_packs WHERE id = ?").get(id) as PackRow | undefined;
  const chunkCount = (id: string) => (db.prepare("SELECT count(*) AS n FROM doc_chunks WHERE pack_id = ?").get(id) as { n: number }).n;
  const assertProject = (projectId: string) => {
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) throw new MemoryApiError("not_found", `project ${projectId} not found`);
  };
  const defaultSource = (library: string) =>
    library === "node" ? "https://nodejs.org/docs/" : `https://www.npmjs.com/package/${library.split("/").map(encodeURIComponent).join("/")}`;

  const view = (r: PackRow, linkStatus: "active" | "stale"): DocPackView => {
    const job = jobs.pending().find((j) => j.kind === "doc_pack" && j.payload.packId === r.id);
    return {
      id: r.id,
      library: r.library,
      version: r.version,
      status: linkStatus === "stale" ? "stale" : r.status,
      chunkCount: chunkCount(r.id),
      sourceUrl: r.source_url,
      ...(r.retrieved_at ? { retrievedAt: r.retrieved_at } : {}),
      label: docsLabel(r.library),
      ...(r.docs_version && r.docs_version !== r.version ? { docsVersion: r.docs_version } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.last_error && r.status === "failed" ? { error: r.last_error } : {}),
      // Background work runs one job at a time: say when this one is still waiting its turn.
      ...(job?.progress ? { progress: job.progress } : job?.status === "queued" ? { progress: "Waiting for other background work" } : {}),
    };
  };

  const listDocPacks = (projectId: string): DocPackView[] => {
    const rows = db
      .prepare(
        `SELECT p.*, l.status AS link_status FROM project_doc_packs l JOIN doc_packs p ON p.id = l.pack_id
         WHERE l.project_id = ? ORDER BY l.status, p.library, p.version DESC`,
      )
      .all(projectId) as (PackRow & { link_status: "active" | "stale" })[];
    return rows.map((r) => view(r, r.link_status));
  };

  /** Link a project to the pack for (library, version); its other packs of that library go stale (T9). */
  const link = (projectId: string, library: string, version: string): { pack: PackRow; created: boolean } => {
    const v = packVersion(library, version);
    let row = db.prepare("SELECT * FROM doc_packs WHERE library = ? AND version = ?").get(library, v) as PackRow | undefined;
    let created = false;
    db.transaction(() => {
      if (!row) {
        const id = newId("pack");
        db.prepare("INSERT INTO doc_packs (id, library, version, status, source_url) VALUES (?, ?, ?, 'building', ?)").run(id, library, v, defaultSource(library));
        row = pack(id)!;
        created = true;
      }
      db.prepare(
        `UPDATE project_doc_packs SET status = 'stale'
         WHERE project_id = ? AND pack_id IN (SELECT id FROM doc_packs WHERE library = ? AND id != ?)`,
      ).run(projectId, library, row.id);
      db.prepare(
        `INSERT INTO project_doc_packs (project_id, pack_id, status, linked_at) VALUES (?, ?, 'active', ?)
         ON CONFLICT(project_id, pack_id) DO UPDATE SET status = 'active'`,
      ).run(projectId, row.id, now());
    })();
    return { pack: row!, created };
  };

  const queueBuild = (packId: string): JobRef => {
    const running = jobs.pending().find((j) => j.kind === "doc_pack" && j.payload.packId === packId);
    if (running) return { id: running.id, kind: running.kind, status: running.status };
    db.prepare("UPDATE doc_packs SET status = 'building', last_error = NULL WHERE id = ?").run(packId);
    return jobs.enqueue("doc_pack", { packId });
  };

  const buildDocPack = (projectId: string, library: string, version: string): JobRef => {
    assertProject(projectId);
    const lib = library.trim();
    const ver = version.trim();
    if (!lib || !/^[@\w./-]+$/.test(lib)) throw new MemoryApiError("invalid", "Give a library name, e.g. react-native");
    if (!/^\d/.test(ver)) throw new MemoryApiError("invalid", "Give a version number, e.g. 0.76.3");
    const { pack: p } = link(projectId, lib, ver);
    return queueBuild(p.id);
  };

  /** Libraries worth a pack in this project: the curated ones and the stack the card names. */
  const suggestDocPacks = (projectId: string): DocSuggestion[] => {
    assertProject(projectId);
    const card = deps.projectCard(projectId);
    if (!card) return [];
    const packs = listDocPacks(projectId);
    const wanted = new Set<string>([...Object.keys(RECIPES), ...(card.stackLibraries ?? [])]);
    const out: DocSuggestion[] = [];
    for (const library of wanted) {
      const version = card.versions[library];
      if (!version) continue;
      const mine = packs.filter((p) => p.library === library);
      const current = mine.find((p) => p.version === packVersion(library, version) && p.status !== "stale");
      const shown = current ?? mine[0];
      out.push({
        library,
        label: docsLabel(library),
        version,
        auto: AUTO_LIBRARIES.has(library),
        ...(shown ? { pack: { id: shown.id, status: shown.status, version: shown.version, current: !!current } } : {}),
      });
    }
    return out.sort((a, b) => Number(b.auto) - Number(a.auto) || a.label.localeCompare(b.label));
  };

  /** Build the curated packs a project needs: new ones, and new versions after an upgrade. */
  const ensureDocPacks = (projectId: string): JobRef[] => {
    if (deps.projectMode(projectId) === "off") return [];
    const out: JobRef[] = [];
    for (const s of suggestDocPacks(projectId)) {
      if (!s.auto) continue;
      if (s.pack?.current && s.pack.status !== "failed") continue;
      // A pack another project already built for this version is just linked, not rebuilt.
      const { pack: p, created } = link(projectId, s.library, s.version);
      if (!created && p.status === "ready" && chunkCount(p.id) > 0) {
        emit({ type: "job", job: { id: `link_${p.id}`, kind: "doc_pack", status: "done" } });
        continue;
      }
      if (p.status === "failed" && !created) continue; // shown in the UI with its error; rebuilt on request
      out.push(queueBuild(p.id));
    }
    return out;
  };

  // -- building --------------------------------------------------------------

  const embedChunks = async (
    rows: { id: string; pack_id: string; heading: string; text: string }[],
    ctx?: { signal?: AbortSignal; checkpoint?: () => Promise<void>; progress?: (t: string) => void },
  ): Promise<number> => {
    const e = deps.embedder();
    const m = deps.vectorMeta();
    if (!e || !m || m.model !== e.model) return 0;
    let done = 0;
    for (let i = 0; i < rows.length; i += EMBED_BATCH) {
      await ctx?.checkpoint?.();
      const batch = rows.slice(i, i + EMBED_BATCH);
      const vecs = await e.embed(
        batch.map((r) => `${r.heading}\n${r.text}`.slice(0, 2000)),
        "document",
        ctx?.signal,
      );
      // The model may have changed while we waited; then the next reindex picks these up.
      const now = deps.vectorMeta();
      if (!now || now.model !== e.model || deps.embedder() !== e) return done;
      db.transaction(() => {
        batch.forEach((r, j) => {
          const v = vecs[j];
          if (!v || v.length !== now.dims) return;
          if (!db.prepare("SELECT 1 FROM doc_chunks WHERE id = ?").get(r.id)) return;
          db.prepare("DELETE FROM doc_vec WHERE chunk_id = ?").run(r.id);
          db.prepare("INSERT INTO doc_vec (chunk_id, pack_id, embedding) VALUES (?, ?, ?)").run(r.id, r.pack_id, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        });
      })();
      done += batch.length;
      ctx?.progress?.(`Indexing ${Math.min(i + EMBED_BATCH, rows.length).toLocaleString("en")} of ${rows.length.toLocaleString("en")} sections`);
    }
    return done;
  };

  jobs.register("doc_pack", async (payload, ctx) => {
    const p = pack(String(payload.packId));
    if (!p) return;
    const fetcher = deps.fetcher?.();
    if (!fetcher) throw new Error("Docs can't be downloaded here (git is missing)");
    try {
      ctx.progress("Downloading the docs");
      const built = await fetchDocs(p.library, p.version, fetcher, ctx.signal);
      await ctx.checkpoint();
      const t = now();
      const rows: { id: string; pack_id: string; heading: string; text: string }[] = [];
      db.transaction(() => {
        db.prepare("DELETE FROM doc_chunks WHERE pack_id = ?").run(p.id);
        const ins = db.prepare("INSERT INTO doc_chunks (id, pack_id, heading, text, path, url) VALUES (?, ?, ?, ?, ?, ?)");
        for (const c of built.chunks) {
          const id = newId("doc");
          ins.run(id, p.id, c.heading, c.text, c.path, c.url);
          rows.push({ id, pack_id: p.id, heading: c.heading, text: c.text });
        }
        db.prepare(
          `UPDATE doc_packs SET status = 'ready', retrieved_at = ?, source_url = ?, note = ?, last_error = NULL, ref = ?, docs_version = ?, repo = ? WHERE id = ?`,
        ).run(t, `https://github.com/${built.plan.repo}`, built.plan.note ?? null, built.plan.ref ?? null, built.plan.docsVersion, built.plan.repo, p.id);
      })();
      emit({ type: "job", job: { id: `pack_${p.id}`, kind: "doc_pack", status: "running" } });
      await embedChunks(rows, { signal: ctx.signal, checkpoint: ctx.checkpoint, progress: ctx.progress });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const had = chunkCount(p.id) > 0;
      // A failed rebuild keeps the docs it had.
      db.prepare("UPDATE doc_packs SET status = ?, last_error = ? WHERE id = ?").run(had ? "ready" : "failed", message, p.id);
      throw err;
    } finally {
      fetcher.dispose?.();
    }
  });

  /** Embed chunks without vectors (after a model change, or when a build ran without the model). */
  const embedMissing = async (signal?: AbortSignal): Promise<number> => {
    const rows = db
      .prepare(
        `SELECT c.id, c.pack_id, c.heading, c.text FROM doc_chunks c JOIN doc_packs p ON p.id = c.pack_id
         WHERE p.status = 'ready' AND c.id NOT IN (SELECT chunk_id FROM doc_vec)`,
      )
      .all() as { id: string; pack_id: string; heading: string; text: string }[];
    if (rows.length === 0) return 0;
    return embedChunks(rows, signal ? { signal } : {});
  };

  /** New model or dimensions: the docs vectors start over. */
  const resetVectors = (dims: number) => {
    db.exec("DROP TABLE IF EXISTS doc_vec");
    db.exec(`CREATE VIRTUAL TABLE doc_vec USING vec0(chunk_id TEXT PRIMARY KEY, pack_id TEXT partition key, embedding float[${dims}] distance_metric=cosine)`);
  };

  // -- searching ---------------------------------------------------------------

  /**
   * Search a project's docs: keywords and meaning, fused. Only packs linked to
   * the project; a stale pack only when the project has no current one for
   * that library (then labelled possibly outdated).
   */
  const search = async (req: { projectId?: string; query: string; library?: string; k?: number; excerpt?: number }): Promise<DocHit[]> => {
    if (!req.projectId || deps.projectMode(req.projectId) === "off") return [];
    const links = db
      .prepare(
        `SELECT p.*, l.status AS link_status FROM project_doc_packs l JOIN doc_packs p ON p.id = l.pack_id
         WHERE l.project_id = ? AND p.status = 'ready'`,
      )
      .all(req.projectId) as (PackRow & { link_status: "active" | "stale" })[];
    const activeLibs = new Set(links.filter((l) => l.link_status === "active").map((l) => l.library));
    const usable = links.filter((l) => (l.link_status === "active" || !activeLibs.has(l.library)) && (!req.library || l.library === req.library || docsLabel(l.library).toLowerCase() === req.library.toLowerCase()));
    if (usable.length === 0) return [];
    const packs = new Map(usable.map((p) => [p.id, p]));
    const ids = [...packs.keys()];
    const ranks = new Map<string, { score: number; fts: boolean; vec: boolean }>();
    const add = (id: string, rank: number, via: "fts" | "vec") => {
      const r = ranks.get(id) ?? { score: 0, fts: false, vec: false };
      r.score += 1 / (RRF_K + rank);
      r[via] = true;
      ranks.set(id, r);
    };

    const terms = deps.terms(req.query);
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const hits = db
        .prepare(
          `SELECT f.chunk_id AS id FROM doc_fts f JOIN doc_chunks c ON c.id = f.chunk_id
           WHERE doc_fts MATCH ? AND c.pack_id IN (${ids.map(() => "?").join(",")})
           ORDER BY bm25(doc_fts, 0.0, 3.0, 1.0) LIMIT 20`,
        )
        .all(match, ...ids) as { id: string }[];
      hits.forEach((h, i) => add(h.id, i + 1, "fts"));
    }

    const e = deps.embedder();
    const m = deps.vectorMeta();
    if (e && m && m.model === e.model) {
      try {
        const [q] = await e.embed([req.query.slice(0, 2000)], "query");
        if (q && q.length === m.dims) {
          const hits = db
            .prepare(
              `SELECT chunk_id AS id, distance FROM doc_vec WHERE embedding MATCH ? AND k = 20 AND pack_id IN (${ids.map(() => "?").join(",")}) ORDER BY distance`,
            )
            .all(Buffer.from(q.buffer, q.byteOffset, q.byteLength), ...ids) as { id: string; distance: number }[];
          hits.forEach((h, i) => add(h.id, i + 1, "vec"));
        }
      } catch {
        // keywords still stand
      }
    }

    const card = deps.projectCard(req.projectId);
    const excerpt = req.excerpt ?? 1500;
    const out: DocHit[] = [];
    for (const [id, r] of [...ranks].sort((a, b) => b[1].score - a[1].score).slice(0, req.k ?? 3)) {
      const c = db.prepare("SELECT * FROM doc_chunks WHERE id = ?").get(id) as { pack_id: string; heading: string; text: string; url: string } | undefined;
      const p = c && packs.get(c.pack_id);
      if (!c || !p) continue;
      const have = projectVersion(card, p.library);
      const docsV = p.docs_version ?? p.version;
      const comparable = /^\d/.test(docsV);
      const outdated = p.link_status === "stale" || (!!have && comparable && packVersion(p.library, docsV) !== packVersion(p.library, have));
      out.push({
        id,
        handle: docHandle(id),
        library: p.library,
        label: docsLabel(p.library),
        docsVersion: docsV,
        heading: c.heading,
        text: c.text.length > excerpt ? `${c.text.slice(0, excerpt - 1)}…` : c.text,
        url: c.url,
        score: r.score,
        possiblyOutdated: outdated,
        agreed: r.fts && r.vec,
      });
    }
    return out;
  };

  return { listDocPacks, buildDocPack, suggestDocPacks, ensureDocPacks, search, embedMissing, resetVectors };
}

export type DocsIndex = ReturnType<typeof createDocsIndex>;
