import type { DocPack, DocSuggestion } from "@kovach-dev/memory-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectInfo } from "../../../shared/agent";
import type { HistoryApi } from "../../../shared/ipc";
import { errorText } from "../memory-format";
import { relativeTime } from "../time";
import { AlertIcon, BookIcon } from "./icons";

/**
 * Docs packs per project (MASTER_PLAN › Phase 3 UI): official docs for the
 * versions a project uses, what's building, what went stale after an upgrade,
 * and importing conventions from the project's own files.
 */
export function DocsPanel(props: { api: HistoryApi; projects: ProjectInfo[]; now: number; onReview: () => void }) {
  const { api, projects } = props;
  const [projectId, setProjectId] = useState<string | undefined>(projects[0]?.id);
  const [packs, setPacks] = useState<DocPack[] | undefined>();
  const [suggestions, setSuggestions] = useState<DocSuggestion[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [seed, setSeed] = useState<string | undefined>();
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Builds report progress as job events; refresh at most twice a second.
  useEffect(
    () =>
      api.onChange((e) => {
        if (e.type !== "job" || e.job.kind !== "doc_pack" || timer.current) return;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setVersion((v) => v + 1);
        }, 400);
      }),
    [api],
  );
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    Promise.all([api.listDocPacks(projectId), api.suggestDocPacks(projectId)])
      .then(([p, s]) => {
        if (!live) return;
        setPacks(p);
        setSuggestions(s);
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [api, projectId, version]);

  const build = useCallback(
    async (library: string, v: string) => {
      if (!projectId) return;
      setBusy(library);
      try {
        await api.buildDocPack(projectId, library, v);
        setVersion((x) => x + 1);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(undefined);
      }
    },
    [api, projectId],
  );

  const importConventions = useCallback(async () => {
    if (!projectId) return;
    setBusy("seed");
    try {
      const r = await api.seedProject(projectId, { again: true });
      setSeed(
        r.created === 0
          ? "Nothing new to propose. Conventions come from AGENTS.md, CLAUDE.md, editor rule files and the README's guideline sections."
          : `Proposed ${r.created} convention${r.created === 1 ? "" : "s"} from ${r.files.join(", ")}.`,
      );
    } catch (err) {
      setSeed(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }, [api, projectId]);

  if (projects.length === 0) {
    return (
      <div className="memory-empty">
        <p>Add a project folder first. Local Kovach then fetches the official docs for the library versions it uses.</p>
      </div>
    );
  }

  const missing = suggestions.filter((s) => !s.pack?.current);
  return (
    <div className="docs-panel">
      <div className="doc-filters">
        <label className="field-inline">
          <span>Project</span>
          <select aria-label="Project" value={projectId} onChange={(e) => (setProjectId(e.target.value), setSeed(undefined))}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="meta">
        Official docs for the exact versions this project uses, read from each library's own repository. The agent searches them before relying on an API, and
        cites them.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <h3 className="section-title">Docs packs</h3>
      {!packs ? (
        <p className="meta" aria-busy="true">
          Loading…
        </p>
      ) : packs.length === 0 ? (
        <p className="meta">No packs yet. They build in the background when you work in this project, or build one below.</p>
      ) : (
        <ul className="doc-list" aria-label="Docs packs">
          {packs.map((p) => (
            <li key={p.id} className={`doc-row ${p.status}`} aria-label={`${p.label ?? p.library} ${p.version}`}>
              <div className="doc-head">
                <BookIcon />
                <span className="doc-name">
                  {p.label ?? p.library} {p.version}
                </span>
                <PackStatus pack={p} />
              </div>
              {p.note && <p className="meta">{p.note}</p>}
              {p.status === "failed" && p.error && (
                <p className="form-error">
                  <AlertIcon /> {p.error}
                </p>
              )}
              <div className="doc-meta meta">
                {p.retrievedAt ? <span>Fetched {relativeTime(p.retrievedAt, props.now)}</span> : null}
                <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                  Source
                </a>
                {p.status !== "stale" && p.status !== "building" && (
                  <button type="button" className="link" disabled={busy === p.library} onClick={() => void build(p.library, p.version)}>
                    {p.status === "failed" ? "Try again" : "Rebuild"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <>
          <h3 className="section-title">Libraries without current docs</h3>
          <ul className="doc-list" aria-label="Libraries without docs">
            {missing.map((s) => (
              <li key={s.library} className="doc-row" aria-label={`${s.label} ${s.version}`}>
                <div className="doc-head">
                  <span className="doc-name">
                    {s.label} {s.version}
                  </span>
                  {s.pack && !s.pack.current && <span className="chip">docs for {s.pack.version} are stale</span>}
                  <button type="button" className="secondary small" disabled={busy === s.library} onClick={() => void build(s.library, s.version)}>
                    Build docs
                  </button>
                </div>
                {s.auto && !s.pack && <p className="meta">Builds automatically the next time you work in this project.</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="section-title">Conventions from project files</h3>
      <p className="meta">Bullet points from AGENTS.md, CLAUDE.md, Cursor or Copilot rule files and the README's guideline sections become proposals for you to review.</p>
      <div className="doc-meta">
        <button type="button" className="secondary small" disabled={busy === "seed"} onClick={() => void importConventions()}>
          Import conventions
        </button>
        {seed && (
          <span className="meta" role="status">
            {seed}{" "}
            {/^Proposed/.test(seed) && (
              <button type="button" className="link" onClick={props.onReview}>
                Review them
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function PackStatus({ pack: p }: { pack: DocPack }) {
  if (p.status === "building") return <span className="chip building">{p.progress ?? "Building…"}</span>;
  if (p.status === "stale") return <span className="chip stale">Stale: the project moved to a newer version</span>;
  if (p.status === "failed") return <span className="chip failed">Failed</span>;
  return (
    <span className="chip ready">
      Ready · {p.chunkCount.toLocaleString("en")} sections
      {p.docsVersion ? ` (docs ${p.docsVersion})` : ""}
    </span>
  );
}
