import type { Episode } from "@kovach-dev/memory-contract";
import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../../../shared/agent";
import type { HistoryApi } from "../../../shared/ipc";
import { errorText } from "../memory-format";
import { relativeTime } from "../time";
import { CheckIcon, SearchIcon, XIcon } from "./icons";

const VERIFIED: Record<Episode["verifiedBy"], string> = {
  test: "Verified by tests",
  typecheck: "Verified by the typecheck",
  build: "Verified by the build",
  run: "Verified by a passing command",
  user: "Confirmed by you",
};

/**
 * Experience memory (MASTER_PLAN › Phase 4 UI): fixes that were verified by a
 * check turning green, with the attempts before it. Other projects only ever
 * see a fix's lesson.
 */
export function FixesPanel(props: { api: HistoryApi; projects: ProjectInfo[]; now: number; searchDelay?: number }) {
  const { api } = props;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [items, setItems] = useState<Episode[] | undefined>();
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<string | undefined>();
  const [version, setVersion] = useState(0);

  useEffect(() => api.onChange((e) => e.type === "episode" && setVersion((v) => v + 1)), [api]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), props.searchDelay ?? 200);
    return () => clearTimeout(t);
  }, [query, props.searchDelay]);

  useEffect(() => {
    let live = true;
    api
      .listEpisodes({ ...(projectId ? { projectId } : {}), ...(debounced.trim() ? { query: debounced.trim() } : {}) })
      .then((p) => {
        if (!live) return;
        setItems(p.items);
        setCursor(p.nextCursor);
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [api, projectId, debounced, version]);

  const more = useCallback(async () => {
    if (!cursor) return;
    const p = await api.listEpisodes({ ...(projectId ? { projectId } : {}), ...(debounced.trim() ? { query: debounced.trim() } : {}), cursor });
    setItems((prev) => [...(prev ?? []), ...p.items]);
    setCursor(p.nextCursor);
  }, [api, cursor, projectId, debounced]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteEpisode(id);
        setItems((prev) => prev?.filter((e) => e.id !== id));
        setConfirm(undefined);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [api],
  );

  const projectName = (id: string | undefined) => (id ? (props.projects.find((p) => p.id === id)?.name ?? "Another project") : "No project");

  return (
    <div className="fixes-panel">
      <div className="fixes-filters">
        <div className="search memory-search">
          <SearchIcon size={14} />
          <input type="search" aria-label="Search fixes" placeholder="Search fixes" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <p className="meta">
        When a check fails during a task and passes after the agent's changes, the fix is kept here. The same error later brings it back, in any project; other
        projects only see its lesson, never your code or paths.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!items ? (
        <p className="meta" aria-busy="true">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <div className="memory-empty">
          <p>{debounced || projectId ? "No fixes match." : "No fixes yet. They appear after a task where a failing check turned green."}</p>
        </div>
      ) : (
        <ul className="doc-list" aria-label="Fixes">
          {items.map((e) => {
            const expanded = open === e.id;
            return (
              <li key={e.id} className="doc-row fix-row" aria-label={e.problem}>
                <button type="button" className="fix-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : e.id)}>
                  <CheckIcon />
                  <span className="doc-name">{e.problem}</span>
                </button>
                {e.lesson && (
                  <p className="fix-lesson">
                    <span className="meta">Lesson:</span> {e.lesson}
                  </p>
                )}
                <div className="doc-meta meta">
                  <span className="chip ready">{VERIFIED[e.verifiedBy]}</span>
                  <span>{projectName(e.projectId)}</span>
                  <span>{relativeTime(e.createdAt, props.now)}</span>
                  {e.attempts.length > 1 && <span>{e.attempts.length} attempts</span>}
                </div>
                {expanded && (
                  <div className="fix-detail">
                    {e.errorSignature && (
                      <>
                        <h4>Error</h4>
                        <pre className="fix-error">{e.errorSignature}</pre>
                      </>
                    )}
                    <h4>Fix</h4>
                    <p>{e.fixSummary}</p>
                    <h4>Attempts</h4>
                    <ol className="fix-attempts">
                      {e.attempts.map((a, i) => (
                        <li key={i} className={a.outcome}>
                          {a.outcome === "passed" ? <CheckIcon /> : <XIcon />} {a.approach}
                        </li>
                      ))}
                    </ol>
                    {e.files.length > 0 && (
                      <>
                        <h4>Files changed</h4>
                        <ul className="fix-files">
                          {e.files.map((f) => (
                            <li key={f}>
                              <code>{f}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {Object.keys(e.env).length > 0 && (
                      <p className="meta">
                        With{" "}
                        {Object.entries(e.env)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(", ")}
                      </p>
                    )}
                    <div className="doc-meta">
                      {confirm === e.id ? (
                        <>
                          <span className="meta">Delete permanently?</span>
                          <button type="button" className="secondary small danger" onClick={() => void remove(e.id)}>
                            Delete
                          </button>
                          <button type="button" className="link" onClick={() => setConfirm(undefined)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="link" onClick={() => setConfirm(e.id)}>
                          Delete this fix
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button type="button" className="secondary small" onClick={() => void more()}>
          Load more
        </button>
      )}
    </div>
  );
}
