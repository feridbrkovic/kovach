import type { Candidate, EvidenceItem, Memory, MemoryEvent, MemoryKind, MemoryPatch, MemoryStatus, ReviewStats } from "@kovach-dev/memory-contract";
import { isMemoryApiError } from "@kovach-dev/memory-contract";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "../../../shared/agent";
import type { HistoryApi } from "../../../shared/ipc";
import {
  errorText,
  eventLabel,
  expiresLabel,
  KIND_LABELS,
  KINDS,
  TRUST_LABELS,
  usesLabel,
} from "../memory-format";
import { relativeTime } from "../time";
import { DocsPanel } from "./DocsPanel";
import { FixesPanel } from "./FixesPanel";
import { AlertIcon, FolderIcon, GlobeIcon, PinIcon, PlusIcon, SearchIcon, XIcon } from "./icons";

/** Which memory to open; a new object each time, so asking for the same one twice still opens it. */
export interface MemoryFocus {
  id: string;
}

export interface MemoryViewProps {
  api: HistoryApi;
  projects: ProjectInfo[];
  now: () => number;
  focus?: MemoryFocus | undefined;
  /** Debounce for the search box, in ms. */
  searchDelay?: number;
  /** Open a session at a message (evidence). */
  onOpenSession?: (sessionId: string, messageId?: string) => void;
}

type Scope = "all" | "global" | string;
type Tab = "memories" | "review" | "fixes" | "docs";

export function MemoryView({ api, projects, now, focus, searchDelay = 200, onOpenSession }: MemoryViewProps) {
  const [tab, setTab] = useState<Tab>("memories");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Filters.
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [kind, setKind] = useState<MemoryKind | undefined>();
  const [showSuperseded, setShowSuperseded] = useState(false);

  // Results.
  const [active, setActive] = useState<Memory[]>([]);
  const [activeCursor, setActiveCursor] = useState<string | undefined>();
  const [old, setOld] = useState<Memory[]>([]);
  const [oldCursor, setOldCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [candidates, setCandidates] = useState<Candidate[] | undefined>();
  const [candidateError, setCandidateError] = useState<string | undefined>();

  const [selectedId, setSelectedId] = useState<string | undefined>(focus?.id);
  const closeDetail = useCallback(() => setSelectedId(undefined), []);
  const [creating, setCreating] = useState(false);

  // Live updates from the service (and from our own writes).
  useEffect(
    () =>
      api.onChange((e) => {
        if (e.type === "memory" || e.type === "candidate") refresh();
      }),
    [api, refresh],
  );

  useEffect(() => {
    if (!focus) return;
    setTab("memories");
    setSelectedId(focus.id);
  }, [focus]);

  useEffect(() => {
    if (query === debounced) return;
    const timer = setTimeout(() => setDebounced(query), searchDelay);
    return () => clearTimeout(timer);
  }, [query, debounced, searchDelay]);

  const keep = useCallback(
    (m: Memory) =>
      scope === "all" ? true : scope === "global" ? m.scope === "global" : m.scope === "project" && m.projectId === scope,
    [scope],
  );

  const baseFilter = useMemo(() => {
    const text = debounced.trim();
    return {
      ...(text ? { query: text } : {}),
      ...(kind ? { kind } : {}),
      // The service's project filter also returns global memories; `keep` narrows to the project.
      ...(scope !== "all" && scope !== "global" ? { projectId: scope } : {}),
    };
  }, [debounced, kind, scope]);

  // How many rows each list showed, so a refresh after a change keeps the pages already loaded.
  const shown = useRef({ filter: "", active: 0, old: 0 });
  shown.current.active = active.length;
  shown.current.old = old.length;

  useEffect(() => {
    let cancelled = false;
    const filterKey = JSON.stringify([baseFilter, scope, showSuperseded]);
    const isRefresh = shown.current.filter === filterKey;
    shown.current.filter = filterKey;
    const loadUpTo = async (status: MemoryStatus, min: number) => {
      let page = await api.listMemories({ ...baseFilter, status });
      const items = page.items.filter(keep);
      while (page.nextCursor && items.length < min) {
        page = await api.listMemories({ ...baseFilter, status, cursor: page.nextCursor });
        items.push(...page.items.filter(keep));
      }
      return { items, nextCursor: page.nextCursor };
    };
    setLoading(true);
    (async () => {
      try {
        const [a, s, st] = await Promise.all([
          loadUpTo("active", isRefresh ? shown.current.active : 0),
          showSuperseded ? loadUpTo("superseded", isRefresh ? shown.current.old : 0) : undefined,
          // Research whose source changed: listed first, so it gets a re-check.
          api.listMemories({ ...baseFilter, status: "stale" }).then((p) => p.items.filter(keep)),
        ]);
        if (cancelled) return;
        setActive([...st, ...a.items]);
        setActiveCursor(a.nextCursor);
        setOld(s?.items ?? []);
        setOldCursor(s?.nextCursor);
        setError(undefined);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, baseFilter, keep, scope, showSuperseded, version]);

  useEffect(() => {
    let cancelled = false;
    api.listCandidates().then(
      (list) => {
        if (cancelled) return;
        setCandidates(list);
        setCandidateError(undefined);
      },
      (err) => !cancelled && setCandidateError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, version]);

  const loadMore = async () => {
    try {
      const [a, s] = await Promise.all([
        activeCursor ? api.listMemories({ ...baseFilter, status: "active", cursor: activeCursor }) : undefined,
        oldCursor ? api.listMemories({ ...baseFilter, status: "superseded", cursor: oldCursor }) : undefined,
      ]);
      const add = (prev: Memory[], next: Memory[]) => [...prev, ...next.filter((m) => keep(m) && !prev.some((p) => p.id === m.id))];
      if (a) {
        setActive((prev) => add(prev, a.items));
        setActiveCursor(a.nextCursor);
      }
      if (s) {
        setOld((prev) => add(prev, s.items));
        setOldCursor(s.nextCursor);
      }
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Projects the app knows, plus any a memory or proposal mentions that it doesn't.
  const allProjects = useMemo(() => {
    const list = [...projects];
    for (const item of [...active, ...old, ...(candidates ?? [])]) {
      if (item.projectId && !list.some((p) => p.id === item.projectId)) {
        list.push({ id: item.projectId, name: item.projectId, path: "" });
      }
    }
    return list;
  }, [projects, active, old, candidates]);
  const projectName = (id: string | undefined) => (id ? (allProjects.find((p) => p.id === id)?.name ?? id) : "Global");

  const filtered = debounced.trim() !== "" || kind !== undefined || scope !== "all";
  const t = now();

  const rowProps = (m: Memory) => ({
    memory: m,
    projectName: projectName(m.projectId),
    now: t,
    selected: m.id === selectedId,
    onOpen: () => setSelectedId(m.id),
    onPin: async (pinned: boolean) => {
      await api.setPinned(m.id, pinned);
      refresh();
    },
    onSave: async (patch: MemoryPatch) => {
      const next = await api.updateMemory(m.id, patch);
      if (selectedId === m.id) setSelectedId(next.id);
      refresh();
    },
    onDelete: async () => {
      await api.deleteMemory(m.id);
      if (selectedId === m.id) setSelectedId(undefined);
      refresh();
    },
  });

  return (
    <section className="memory-view" aria-labelledby="memory-title">
      <header className="memory-header">
        <div>
          <h1 id="memory-title">Memory</h1>
          <p className="meta">What Local Kovach remembers about you and your projects. Edits keep a history; deletes are permanent.</p>
        </div>
        <button
          type="button"
          className="primary small"
          onClick={() => {
            setTab("memories");
            setCreating(true);
          }}
          disabled={creating && tab === "memories"}
        >
          <PlusIcon size={13} /> New memory
        </button>
      </header>

      <div className={`memory-body${selectedId && tab === "memories" ? " with-detail" : ""}`}>
        <div className="memory-scroll">
          <div className="memory-content">
            <div className="tabs" role="tablist" aria-label="Memory sections">
              <button
                type="button"
                role="tab"
                id="memory-tab-memories"
                aria-selected={tab === "memories"}
                aria-controls="memory-panel"
                className={tab === "memories" ? "on" : ""}
                onClick={() => setTab("memories")}
              >
                Memories
              </button>
              <button
                type="button"
                role="tab"
                id="memory-tab-review"
                aria-selected={tab === "review"}
                aria-controls="memory-panel"
                className={tab === "review" ? "on" : ""}
                onClick={() => setTab("review")}
              >
                Review
                {candidates && candidates.length > 0 && <span className="tab-count">{candidates.length}</span>}
              </button>
              <button
                type="button"
                role="tab"
                id="memory-tab-fixes"
                aria-selected={tab === "fixes"}
                aria-controls="memory-panel"
                className={tab === "fixes" ? "on" : ""}
                onClick={() => setTab("fixes")}
              >
                Fixes
              </button>
              <button
                type="button"
                role="tab"
                id="memory-tab-docs"
                aria-selected={tab === "docs"}
                aria-controls="memory-panel"
                className={tab === "docs" ? "on" : ""}
                onClick={() => setTab("docs")}
              >
                Docs
              </button>
            </div>

            <div id="memory-panel" role="tabpanel" aria-labelledby={`memory-tab-${tab}`}>
              {tab === "fixes" ? (
                <FixesPanel api={api} projects={projects} now={t} searchDelay={searchDelay} />
              ) : tab === "docs" ? (
                <DocsPanel api={api} projects={projects} now={t} onReview={() => setTab("review")} />
              ) : tab === "review" ? (
                <ReviewList
                  api={api}
                  candidates={candidates}
                  error={candidateError}
                  projectName={projectName}
                  now={t}
                  onResolved={refresh}
                  onOpenSession={onOpenSession}
                />
              ) : (
                <>
                  {creating && (
                    <NewMemoryForm
                      projects={allProjects}
                      defaultProjectId={scope !== "all" && scope !== "global" ? scope : undefined}
                      onCancel={() => setCreating(false)}
                      onCreate={async (input) => {
                        const m = await api.createMemory(input);
                        setCreating(false);
                        setSelectedId(m.id);
                        refresh();
                      }}
                    />
                  )}

                  <div className="memory-filters">
                    <div className="search memory-search">
                      <SearchIcon size={14} />
                      <label htmlFor="memory-search" className="visually-hidden">
                        Search memories
                      </label>
                      <input
                        id="memory-search"
                        type="search"
                        placeholder="Search memories"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <label htmlFor="memory-scope" className="visually-hidden">
                      Scope
                    </label>
                    <select id="memory-scope" className="pill-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                      <option value="all">All scopes</option>
                      <option value="global">Global</option>
                      {allProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <label className="switch compact">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={showSuperseded}
                        onChange={(e) => setShowSuperseded(e.target.checked)}
                      />
                      <span className="track" aria-hidden="true" />
                      <span>Show superseded</span>
                    </label>
                  </div>

                  <div className="kind-chips" role="group" aria-label="Kind">
                    <button type="button" className={`toggle${kind === undefined ? " on" : ""}`} aria-pressed={kind === undefined} onClick={() => setKind(undefined)}>
                      All kinds
                    </button>
                    {KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={`toggle${kind === k ? " on" : ""}`}
                        aria-pressed={kind === k}
                        onClick={() => setKind(kind === k ? undefined : k)}
                      >
                        {KIND_LABELS[k]}
                      </button>
                    ))}
                  </div>

                  {error && (
                    <p className="form-error" role="alert">
                      Couldn't load memories: {error}
                    </p>
                  )}

                  {!loading && !error && active.length === 0 && old.length === 0 && (
                    <div className="memory-empty">
                      {filtered ? (
                        <p>No memories match these filters.</p>
                      ) : (
                        <>
                          <p>
                            <strong>Nothing remembered yet.</strong>
                          </p>
                          <p className="meta">Add one with New memory, or accept what the agent proposes in Review.</p>
                        </>
                      )}
                    </div>
                  )}

                  {active.length > 0 && (
                    <ul className="memory-list" aria-label="Memories" aria-busy={loading || undefined}>
                      {active.map((m) => (
                        <MemoryRow key={m.id} {...rowProps(m)} />
                      ))}
                    </ul>
                  )}

                  {showSuperseded && old.length > 0 && (
                    <>
                      <h2 className="group memory-group">Superseded versions</h2>
                      <ul className="memory-list" aria-label="Superseded memories">
                        {old.map((m) => (
                          <MemoryRow key={m.id} {...rowProps(m)} />
                        ))}
                      </ul>
                    </>
                  )}

                  {(activeCursor || oldCursor) && (
                    <button type="button" className="more" onClick={() => void loadMore()}>
                      Load more
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {selectedId && tab === "memories" && (
          <MemoryDetail
            api={api}
            id={selectedId}
            version={version}
            now={t}
            projectName={projectName}
            onClose={closeDetail}
            onOpen={setSelectedId}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ScopeChip({ projectId, name }: { projectId: string | undefined; name: string }) {
  return (
    <span className="chip" title={projectId ? `Only in ${name}` : "In every project"}>
      {projectId ? <FolderIcon size={11} /> : <GlobeIcon size={11} />} {name}
    </span>
  );
}

function MemoryChips({ memory: m, projectName }: { memory: Memory; projectName: string }) {
  return (
    <>
      <span className={`chip kind-${m.kind}`}>{KIND_LABELS[m.kind]}</span>
      <ScopeChip projectId={m.projectId} name={projectName} />
      <span className={`chip trust-${m.trust}`} title="How much the agent trusts this">
        {TRUST_LABELS[m.trust]}
      </span>
      {m.status === "stale" ? (
        <span className="chip warn" title="Its source page no longer supports it; the agent doesn't use it until you confirm it">
          Needs a re-check
        </span>
      ) : (
        m.status !== "active" && <span className="chip status-chip">{m.status === "pending_review" ? "Pending review" : m.status[0]!.toUpperCase() + m.status.slice(1)}</span>
      )}
    </>
  );
}

function MemoryRow(props: {
  memory: Memory;
  projectName: string;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onPin: (pinned: boolean) => Promise<void>;
  onSave: (patch: MemoryPatch) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { memory: m } = props;
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [error, setError] = useState<string | undefined>();
  const ref = useRef<HTMLLIElement>(null);
  const current = m.status === "active";
  const keyId = `memory-key-${m.id}`;

  useEffect(() => {
    if (props.selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.selected]);

  const act = async (fn: () => Promise<void>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (mode === "edit") {
    return (
      <li ref={ref}>
        <MemoryEditor
          label={`Edit ${m.key}`}
          idPrefix={`edit-${m.id}`}
          initial={{ key: m.key, body: m.body }}
          submitLabel="Save"
          note="Saving keeps the current wording as an earlier version."
          onCancel={() => setMode("view")}
          onSubmit={async (draft) => {
            const patch: MemoryPatch = {};
            if (draft.key !== m.key) patch.key = draft.key;
            if (draft.body !== m.body) patch.body = draft.body;
            if (Object.keys(patch).length > 0) await props.onSave(patch);
            setMode("view");
          }}
        />
      </li>
    );
  }

  return (
    <li ref={ref}>
      <article
        className={`memory-card${props.selected ? " selected" : ""}${current ? "" : " superseded"}${m.pinned ? " pinned" : ""}`}
        aria-labelledby={keyId}
      >
        <button type="button" className="memory-open" onClick={props.onOpen} aria-current={props.selected ? "true" : undefined}>
          <span className="memory-key" id={keyId}>
            {m.key}
          </span>
          <span className="memory-text">{m.body}</span>
        </button>
        {current && (
          <button
            type="button"
            className={`icon-btn pin${m.pinned ? " on" : ""}`}
            aria-label={`${m.pinned ? "Unpin" : "Pin"} ${m.key}`}
            title={m.pinned ? "Pinned: always in the agent's context" : "Pin: always include in the agent's context"}
            onClick={() => void act(() => props.onPin(!m.pinned))}
          >
            <PinIcon />
          </button>
        )}
        <div className="memory-meta">
          <MemoryChips memory={m} projectName={props.projectName} />
          <span className="meta">
            {usesLabel(m.useCount)} · updated {relativeTime(m.updatedAt, props.now)}
          </span>
          <span className="spacer" />
          {mode === "confirm-delete" ? (
            <span className="memory-confirm" role="group" aria-label={`Delete ${m.key}`}>
              <strong>Delete permanently?</strong>
              <button type="button" className="danger small" onClick={() => void act(props.onDelete)}>
                Delete
              </button>
              <button type="button" className="secondary small" onClick={() => setMode("view")} autoFocus>
                Cancel
              </button>
            </span>
          ) : (
            <span className="memory-actions">
              {m.status === "stale" && (
                <button type="button" className="secondary small" onClick={() => void act(() => props.onSave({ body: m.body }))} aria-label={`${m.key} is still true`}>
                  Still true
                </button>
              )}
              {m.status === "stale" && (
                <button type="button" className="ghost small" onClick={() => setMode("edit")} aria-label={`Edit ${m.key}`}>
                  Edit
                </button>
              )}
              {current && (
                <button type="button" className="ghost small" onClick={() => setMode("edit")} aria-label={`Edit ${m.key}`}>
                  Edit
                </button>
              )}
              <button type="button" className="ghost small" onClick={() => setMode("confirm-delete")} aria-label={`Delete ${m.key}`}>
                Delete
              </button>
            </span>
          )}
        </div>
        {mode === "confirm-delete" && <p className="meta memory-confirm-note">Removes this memory and its earlier versions. This can't be undone.</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </article>
    </li>
  );
}

/** Key and text fields, shared by editing a memory and editing a proposal before accepting it. */
function MemoryEditor(props: {
  label: string;
  idPrefix: string;
  initial: { key: string; body: string };
  submitLabel: string;
  note?: string;
  onCancel: () => void;
  onSubmit: (draft: { key: string; body: string }) => Promise<void>;
}) {
  const [key, setKey] = useState(props.initial.key);
  const [body, setBody] = useState(props.initial.body);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await props.onSubmit({ key: key.trim(), body: body.trim() });
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <form className="memory-editor" aria-label={props.label} onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
      <label className="field-label" htmlFor={`${props.idPrefix}-key`}>
        Key
      </label>
      <input id={`${props.idPrefix}-key`} className="mono-input" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoFocus />
      <label className="field-label" htmlFor={`${props.idPrefix}-body`}>
        Text
      </label>
      <textarea id={`${props.idPrefix}-body`} value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {props.note && <span className="meta">{props.note}</span>}
        <span className="spacer" />
        <button type="button" className="secondary small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary small" disabled={saving}>
          {props.submitLabel}
        </button>
      </div>
    </form>
  );
}

function NewMemoryForm(props: {
  projects: ProjectInfo[];
  defaultProjectId: string | undefined;
  onCancel: () => void;
  onCreate: (input: { kind: MemoryKind; scope: "global" | "project"; projectId?: string; key: string; body: string; pinned: boolean }) => Promise<void>;
}) {
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [scope, setScope] = useState<string>(props.defaultProjectId ?? "global");
  const [key, setKey] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await props.onCreate({
        kind,
        ...(scope === "global" ? { scope: "global" as const } : { scope: "project" as const, projectId: scope }),
        key: key.trim(),
        body: body.trim(),
        pinned,
      });
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <form className="memory-editor new-memory" aria-label="New memory" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && props.onCancel()}>
      <h2>New memory</h2>
      <div className="field-row">
        <div>
          <label className="field-label" htmlFor="new-memory-kind">
            Kind
          </label>
          <select id="new-memory-kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="new-memory-scope">
            Applies to
          </label>
          <select id="new-memory-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">Global (every project)</option>
            {props.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="field-label" htmlFor="new-memory-key">
        Key
      </label>
      <input
        id="new-memory-key"
        className="mono-input"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="style.semicolons"
        aria-describedby="new-memory-key-hint"
        spellCheck={false}
        autoFocus
      />
      <p className="meta field-hint" id="new-memory-key-hint">
        A short subject, e.g. style.semicolons. A new memory with the same key replaces the old one.
      </p>
      <label className="field-label" htmlFor="new-memory-body">
        Text
      </label>
      <textarea
        id="new-memory-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="No semicolons in TypeScript."
      />
      <label className="check-option">
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        Pin: always include it in the agent's context
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span className="spacer" />
        <button type="button" className="secondary small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary small" disabled={saving}>
          Save memory
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function MemoryDetail(props: {
  api: HistoryApi;
  id: string;
  version: number;
  now: number;
  projectName: (id: string | undefined) => string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onOpenSession?: ((sessionId: string, messageId?: string) => void) | undefined;
}) {
  const { api, id, version, onClose } = props;
  const [data, setData] = useState<{ memory: Memory; history: Memory[]; events: MemoryEvent[] } | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api.getMemory(id).then(
      (d) => {
        if (cancelled) return;
        setData(d);
        setError(undefined);
      },
      (err) => {
        if (cancelled) return;
        if (isMemoryApiError(err, "not_found")) onClose();
        else setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, version, onClose]);

  const shown = data?.memory.id === id ? data : undefined;
  const m = shown?.memory;
  // Newest first; within the same instant, what happened to this version before what happened to older ones.
  const events = shown
    ? [...shown.events].sort(
        (a, b) => b.at - a.at || Number(b.memoryId === shown.memory.id) - Number(a.memoryId === shown.memory.id) || b.id - a.id,
      )
    : [];

  return (
    <aside className="memory-detail" aria-label="Memory details" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <header>
        <span className="detail-eyebrow">Memory</span>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <XIcon />
        </button>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!m ? (
        !error && <p className="meta" aria-busy="true">Loading…</p>
      ) : (
        <>
          <h2 className="memory-key">{m.key}</h2>
          <p className="detail-body">{m.body}</p>
          <div className="detail-chips">
            <MemoryChips memory={m} projectName={props.projectName(m.projectId)} />
            {m.pinned && (
              <span className="chip pinned-chip">
                <PinIcon size={11} /> Pinned
              </span>
            )}
          </div>
          <dl className="detail-facts">
            <dt>Used</dt>
            <dd>
              {usesLabel(m.useCount)}
              {m.lastUsedAt !== undefined && `, last ${relativeTime(m.lastUsedAt, props.now)}`}
            </dd>
            <dt>Created</dt>
            <dd>{relativeTime(m.createdAt, props.now)}</dd>
            <dt>Updated</dt>
            <dd>{relativeTime(m.updatedAt, props.now)}</dd>
            {m.appliesTo && Object.keys(m.appliesTo).length > 0 && (
              <>
                <dt>Applies to</dt>
                <dd>
                  {Object.entries(m.appliesTo).map(([lib, v]) => (
                    <code key={lib} className="applies">
                      {lib} {v}
                    </code>
                  ))}
                </dd>
              </>
            )}
            <dt>Evidence</dt>
            <dd>
              {m.evidence.length === 0 ? (
                "None (added by hand)"
              ) : (
                <Evidence api={api} id={m.id} count={m.evidence.length} onOpenSession={props.onOpenSession} />
              )}
            </dd>
            {m.reviewAfter !== undefined && (
              <>
                <dt>Review</dt>
                <dd>{m.reviewAfter > props.now ? "Scheduled" : "Due"} · {new Date(m.reviewAfter).toLocaleDateString("en", { day: "numeric", month: "short" })}</dd>
              </>
            )}
          </dl>

          <section className="detail-section" aria-label="Version history">
            <h3>Version history</h3>
            {shown.history.length === 0 ? (
              <p className="meta">This is the first version.</p>
            ) : (
              <ol className="versions">
                {shown.history.map((v) => (
                  <li key={v.id}>
                    <button type="button" className="version" onClick={() => props.onOpen(v.id)}>
                      {v.key !== m.key && <span className="memory-key">{v.key}</span>}
                      <span className="version-body">{v.body}</span>
                      <span className="meta">
                        {TRUST_LABELS[v.trust]} · {relativeTime(v.createdAt, props.now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="detail-section" aria-label="Activity">
            <h3>Activity</h3>
            {events.length === 0 ? (
              <p className="meta">No activity recorded yet.</p>
            ) : (
              <ol className="timeline">
                {events.map((e) => (
                  <li key={e.id} className={`ev-${e.action}`}>
                    <span className="dot" aria-hidden="true" />
                    <span>
                      {eventLabel(e)}
                      {e.memoryId !== m.id && <span className="meta"> (earlier version)</span>}
                    </span>
                    <span className="meta">{relativeTime(e.at, props.now)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------

function ReviewList(props: {
  api: HistoryApi;
  candidates: Candidate[] | undefined;
  error: string | undefined;
  projectName: (id: string | undefined) => string;
  now: number;
  onResolved: () => void;
  onOpenSession?: ((sessionId: string, messageId?: string) => void) | undefined;
}) {
  if (props.error) {
    return (
      <p className="form-error" role="alert">
        Couldn't load proposals: {props.error}
      </p>
    );
  }
  if (!props.candidates) return <p className="meta" aria-busy="true">Loading…</p>;
  if (props.candidates.length === 0) {
    return (
      <div className="memory-empty">
        <p>Nothing to review. Memories the agent proposes on its own will appear here.</p>
        <ReviewPrecision api={props.api} after={props.candidates} />
      </div>
    );
  }
  return (
    <>
      <p className="meta review-intro">
        Proposed from what you said in finished sessions (with the messages as evidence), or found in your projects' AGENTS.md, CLAUDE.md and README.
        Nothing here is used until you accept it; unanswered proposals expire after 30 days.
      </p>
      <ReviewPrecision api={props.api} after={props.candidates} />
      <ul className="memory-list" aria-label="Proposed memories">
        {props.candidates.map((c) => (
          <CandidateCard key={c.id} {...props} candidate={c} />
        ))}
      </ul>
    </>
  );
}

/** Below this many decisions the share says little, so it isn't shown. */
const MIN_DECISIONS = 5;
/** MASTER_PLAN › Targets: at least 85% of proposals accepted in review. */
const PRECISION_GOAL = 0.85;

/** How many proposals from sessions were accepted: the plan's extraction precision, on real decisions. */
function ReviewPrecision(props: { api: HistoryApi; after: unknown }) {
  const [stats, setStats] = useState<ReviewStats>();
  useEffect(() => {
    let cancelled = false;
    props.api
      .reviewStats()
      .then((s) => !cancelled && setStats(s))
      .catch(() => undefined); // only a hint; the inbox works without it
    return () => {
      cancelled = true;
    };
    // Reload after every decision (the candidate list changes).
  }, [props.api, props.after]);
  const t = stats?.fromSessions;
  if (!t) return null;
  const decided = t.accepted + t.rejected;
  if (decided < MIN_DECISIONS) return null;
  const share = t.accepted / decided;
  return (
    <p className="meta review-precision" aria-label="Review precision">
      From sessions, you've accepted {t.accepted} of {decided} proposals in the last 90 days ({Math.round(share * 100)}%)
      {t.edited ? `, ${t.edited} after an edit` : ""}.{share < PRECISION_GOAL ? ` The goal is ${Math.round(PRECISION_GOAL * 100)}% or more.` : ""}
    </p>
  );
}

function CandidateCard(props: {
  api: HistoryApi;
  candidate: Candidate;
  projectName: (id: string | undefined) => string;
  now: number;
  onResolved: () => void;
  onOpenSession?: ((sessionId: string, messageId?: string) => void) | undefined;
}) {
  const { api, candidate: c } = props;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Memory | undefined>();
  const keyId = `candidate-key-${c.id}`;

  useEffect(() => {
    if (!c.conflictsWith) return;
    let cancelled = false;
    api.getMemory(c.conflictsWith).then(
      (d) => !cancelled && setConflict(d.memory),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, c.conflictsWith]);

  const resolve = async (resolution: Parameters<HistoryApi["resolveCandidate"]>[1]) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.resolveCandidate(c.id, resolution);
      props.onResolved();
    } catch (err) {
      // The editor shows its own error; the card shows errors from its buttons.
      if (!editing) setError(errorText(err));
      setBusy(false);
      throw err;
    }
  };

  if (editing) {
    return (
      <li>
        <MemoryEditor
          label={`Edit ${c.key}`}
          idPrefix={`cand-${c.id}`}
          initial={{ key: c.key, body: c.body }}
          submitLabel="Accept"
          note="Accepting saves your wording as a memory you set."
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            const patch: MemoryPatch = {};
            if (draft.key !== c.key) patch.key = draft.key;
            if (draft.body !== c.body) patch.body = draft.body;
            await resolve(Object.keys(patch).length > 0 ? { edit: patch } : "accept");
          }}
        />
      </li>
    );
  }

  const evidence = c.evidence.length;
  // A web finding cites the fetch_page call along with its page; a seeded convention cites only its file.
  const hasSource = c.evidence.some((e) => e.type === "source");
  const origin = !hasSource ? undefined : c.evidence.some((e) => e.type === "tool_call") ? "From a web page" : "From a project file";
  // Same subject as something the user set themselves: ask, don't just propose.
  if (conflict && conflict.trust === "user") {
    return (
      <li>
        <article className="memory-card candidate question" aria-labelledby={keyId}>
          <p className="candidate-question" id={keyId}>
            <AlertIcon /> Which is right now for <code>{c.key}</code>?
          </p>
          <div className="question-options">
            <div>
              <span className="meta">You said before</span>
              <p className="memory-text">{conflict.body}</p>
            </div>
            <div>
              <span className="meta">A recent session suggests</span>
              <p className="memory-text">{c.body}</p>
            </div>
          </div>
          <div className="memory-meta">
            <ScopeChip projectId={c.projectId} name={props.projectName(c.projectId)} />
            <span className="meta">{expiresLabel(c.expiresAt, props.now)}</span>
            <span className="spacer" />
            <span className="memory-actions">
              <button type="button" className="ghost small" disabled={busy} onClick={() => void resolve("reject").catch(() => undefined)}>
                Keep what I said
              </button>
              <button type="button" className="secondary small" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="primary small" disabled={busy} onClick={() => void resolve("accept").catch(() => undefined)}>
                Use the new one
              </button>
            </span>
          </div>
          <Evidence api={api} id={c.id} count={evidence} onOpenSession={props.onOpenSession} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </article>
      </li>
    );
  }
  return (
    <li>
      <article className="memory-card candidate" aria-labelledby={keyId}>
        <div className="memory-open static">
          <span className="memory-key" id={keyId}>
            {c.key}
          </span>
          <span className="memory-text">{c.body}</span>
        </div>
        {c.conflictsWith && (
          <p className="candidate-conflict">
            <AlertIcon />
            <span>
              Replaces a memory you set{conflict ? <>: “{conflict.body}”</> : "."}
            </span>
          </p>
        )}
        <div className="memory-meta">
          <span className={`chip kind-${c.kind}`}>{KIND_LABELS[c.kind]}</span>
          <ScopeChip projectId={c.projectId} name={props.projectName(c.projectId)} />
          {origin && <span className="chip">{origin}</span>}
          <span className="meta">
            seen in {c.seenInSessions} session{c.seenInSessions === 1 ? "" : "s"} · {expiresLabel(c.expiresAt, props.now)}
          </span>
          <span className="spacer" />
          <span className="memory-actions">
            <button type="button" className="ghost small" disabled={busy} onClick={() => void resolve("reject").catch(() => undefined)}>
              Reject
            </button>
            <button type="button" className="secondary small" disabled={busy} onClick={() => setEditing(true)}>
              Edit &amp; accept
            </button>
            <button type="button" className="primary small" disabled={busy} onClick={() => void resolve("accept").catch(() => undefined)}>
              Accept
            </button>
          </span>
        </div>
        <Evidence api={api} id={c.id} count={evidence} onOpenSession={props.onOpenSession} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </article>
    </li>
  );
}

const EVIDENCE_WHO: Record<string, string> = { user: "You said", assistant: "The agent", tool: "Tool output", system: "System" };

/** Why something is remembered or proposed: the messages, commands and pages behind it, on request. */
function Evidence(props: {
  api: HistoryApi;
  id: string;
  count: number;
  onOpenSession?: ((sessionId: string, messageId?: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EvidenceItem[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (!open || items) return;
    let cancelled = false;
    props.api.getEvidence(props.id).then(
      (r) => !cancelled && setItems(r),
      (err) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, items, props.api, props.id]);
  const label = `${props.count} piece${props.count === 1 ? "" : "s"} of evidence`;
  return (
    <div className="evidence">
      <button type="button" className="ghost small evidence-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide evidence" : `Show ${label}`}
      </button>
      {open && error && (
        <p className="form-error" role="alert">
          Couldn't load the evidence: {error}
        </p>
      )}
      {open && !error && !items && <p className="meta" aria-busy="true">Loading…</p>}
      {open && items && (
        <ul className="evidence-list" aria-label={label}>
          {items.map((e) => (
            <li key={`${e.type}:${e.id}`}>
              {e.missing ? (
                <span className="meta">Deleted since (with its session or page).</span>
              ) : (
                <>
                  <span className="meta">
                    {e.type === "source" ? (e.url ? "From a page or file" : "Source") : e.type === "tool_call" ? "A command the agent ran" : e.type === "episode" ? "A verified fix" : EVIDENCE_WHO[e.role ?? "user"]}
                  </span>
                  <blockquote className="evidence-excerpt">{e.excerpt || "(empty)"}</blockquote>
                  {e.url && <span className="meta evidence-url">{e.title ? `${e.title} · ` : ""}{e.url}</span>}
                  {e.sessionId && props.onOpenSession && (
                    <button type="button" className="link small" onClick={() => props.onOpenSession?.(e.sessionId!, e.messageId)}>
                      Open in session
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
