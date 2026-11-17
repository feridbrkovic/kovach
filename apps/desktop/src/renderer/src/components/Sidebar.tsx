import type { MessageHit, SessionSummary } from "@kovach-dev/memory-contract";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { DataSource } from "../api";
import { type DayGroup, dayGroup, relativeTime } from "../time";
import { GearIcon, Mark, MemoryIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon } from "./icons";

export interface SidebarProps {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | undefined;
  hasMore: boolean;
  onLoadMore: () => void;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  query: string;
  onQuery: (q: string) => void;
  hits: MessageHit[] | null;
  searching: boolean;
  onOpenHit: (hit: MessageHit) => void;
  source: DataSource;
  now: () => number;
  /** Agent features; absent when the agent isn't available. */
  onNewSession?: () => void;
  newSessionActive?: boolean;
  runningSessionId?: string | undefined;
  onOpenSettings?: () => void;
  /** Opens the memory browser. */
  onOpenMemory?: () => void;
  memoryActive?: boolean;
}

const GROUPS: DayGroup[] = ["Today", "Yesterday", "Previous 7 days", "Older"];

export const untitled = (s: { title?: string | undefined }) => s.title ?? "Untitled session";

export function Sidebar(props: SidebarProps) {
  const { sessions, query, hits, now } = props;
  const t = now();
  const titleOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return s ? untitled(s) : "Session";
  };

  return (
    <aside className="sidebar" aria-label="History">
      <header className="brand">
        <Mark />
        <span className="brand-name">
          <span className="brand-local">Local</span> Kovach
        </span>
      </header>

      {props.onNewSession && (
        <button
          type="button"
          className={`new-button${props.newSessionActive ? " active" : ""}`}
          onClick={props.onNewSession}
          aria-current={props.newSessionActive ? "page" : undefined}
        >
          <PlusIcon /> New session
        </button>
      )}

      <div className="search">
        <SearchIcon />
        <label htmlFor="history-search" className="visually-hidden">
          Search history
        </label>
        <input
          id="history-search"
          type="search"
          placeholder="Search history"
          value={query}
          onChange={(e) => props.onQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <nav className="list" aria-label={hits ? "Search results" : "Sessions"}>
        {hits ? (
          <SearchResults hits={hits} searching={props.searching} titleOf={titleOf} onOpen={props.onOpenHit} now={t} />
        ) : (
          <>
            {props.error && (
              <p className="notice" role="alert">
                Couldn't load history: {props.error}
              </p>
            )}
            {!props.loading && !props.error && sessions.length === 0 && (
              <p className="notice">No sessions yet. They appear here as you work.</p>
            )}
            {GROUPS.map((group) => {
              const items = sessions.filter((s) => dayGroup(s.updatedAt, t) === group);
              if (items.length === 0) return null;
              return (
                <section key={group} aria-label={group}>
                  <h2 className="group">{group}</h2>
                  <ul>
                    {items.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        selected={s.id === props.selectedId}
                        onSelect={() => props.onSelect(s.id)}
                        onRename={(title) => props.onRename(s.id, title)}
                        onDelete={() => props.onDelete(s.id)}
                        running={s.id === props.runningSessionId}
                        now={t}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
            {props.hasMore && (
              <button type="button" className="more" onClick={props.onLoadMore}>
                Load older sessions
              </button>
            )}
          </>
        )}
      </nav>

      {(props.source === "demo" || props.onOpenSettings || props.onOpenMemory) && (
        <footer className="source">
          <span className="source-note">{props.source === "demo" ? "Demo data · not connected to the app" : ""}</span>
          {props.onOpenMemory && (
            <button
              type="button"
              className={`footer-btn${props.memoryActive ? " active" : ""}`}
              aria-label="Memory"
              title="What Local Kovach remembers"
              aria-current={props.memoryActive ? "page" : undefined}
              onClick={props.onOpenMemory}
            >
              <MemoryIcon /> <span aria-hidden="true">Memory</span>
            </button>
          )}
          {props.onOpenSettings && (
            <button type="button" className="icon" aria-label="Model settings" onClick={props.onOpenSettings}>
              <GearIcon />
            </button>
          )}
        </footer>
      )}
    </aside>
  );
}

function SearchResults(props: {
  hits: MessageHit[];
  searching: boolean;
  titleOf: (id: string) => string;
  onOpen: (hit: MessageHit) => void;
  now: number;
}) {
  if (props.hits.length === 0) {
    return <p className="notice">{props.searching ? "Searching…" : "No messages match."}</p>;
  }
  return (
    <ul>
      {props.hits.map((hit) => (
        <li key={hit.messageId}>
          <button type="button" className="hit" onClick={() => props.onOpen(hit)}>
            <span className="hit-title">{props.titleOf(hit.sessionId)}</span>
            <span className="hit-snippet">{hit.snippet.replace(/`/g, "")}</span>
            <span className="meta">{relativeTime(hit.createdAt, props.now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionRow(props: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  running?: boolean;
  now: number;
}) {
  const { session } = props;
  const [mode, setMode] = useState<"view" | "rename" | "confirm-delete">("view");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
  }, [mode]);

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (!title || title === session.title) return setMode("view");
    try {
      await props.onRename(title);
      setMode("view");
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (mode === "rename") {
    return (
      <li className="row editing">
        <form onSubmit={submitRename} className="rename">
          <label htmlFor={`rename-${session.id}`} className="visually-hidden">
            Session title
          </label>
          <input
            id={`rename-${session.id}`}
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setMode("view")}
            onBlur={(e) => void submitRename(e)}
          />
        </form>
        {error && <p className="row-error">{error}</p>}
      </li>
    );
  }

  if (mode === "confirm-delete") {
    return (
      <li className="row confirm" role="group" aria-label={`Delete ${untitled(session)}`}>
        <p>Delete “{untitled(session)}”? Its messages and tool output are removed for good.</p>
        <div className="confirm-actions">
          <button type="button" className="danger" onClick={() => void props.onDelete()}>
            Delete
          </button>
          <button type="button" onClick={() => setMode("view")} autoFocus>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`row${props.selected ? " selected" : ""}`}>
      <button type="button" className="row-main" onClick={props.onSelect} aria-current={props.selected ? "true" : undefined}>
        <span className="row-title">{untitled(session)}</span>
        <span className="meta">
          {props.running ? (
            <span className="working">Working…</span>
          ) : (
            <>
              {relativeTime(session.updatedAt, props.now)} · {session.messageCount} message{session.messageCount === 1 ? "" : "s"}
            </>
          )}
        </span>
      </button>
      <div className="row-actions">
        <button
          type="button"
          className="icon"
          aria-label={`Rename ${untitled(session)}`}
          onClick={() => {
            setDraft(session.title ?? "");
            setMode("rename");
          }}
        >
          <PencilIcon />
        </button>
        <button type="button" className="icon" aria-label={`Delete ${untitled(session)}`} onClick={() => setMode("confirm-delete")}>
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}
