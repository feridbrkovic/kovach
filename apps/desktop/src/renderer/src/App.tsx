import type { MessageHit, SessionSummary } from "@kovach-dev/memory-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentApi, ApprovalDecision, ApprovalPrompt, ProjectInfo, SettingsView } from "../../shared/agent";
import type { HistoryApi } from "../../shared/ipc";
import type { DataSource } from "./api";
import { Composer, type ComposerSubmit } from "./components/Composer";
import { Mark } from "./components/icons";
import { AttachmentContext } from "./components/Markdown";
import { type MemoryFocus, MemoryView } from "./components/MemoryView";
import { SessionView } from "./components/SessionView";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar, untitled } from "./components/Sidebar";
import { reduceRun, type RunOutcome, type RunState } from "./run-state";

export interface AppProps {
  api: HistoryApi;
  /** The agent; without it the app is a history browser. */
  agent?: AgentApi;
  source: DataSource;
  /** Clock for relative times; injectable for tests. */
  now?: () => number;
  /** Debounce for search-as-you-type, in ms. */
  searchDelay?: number;
}

export function App({ api, agent, source, now = Date.now, searchDelay = 200 }: AppProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MessageHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [view, setView] = useState<"session" | "new" | "memory">(agent ? "new" : "session");
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [focusMessageId, setFocusMessageId] = useState<string | undefined>();
  /** Bumped when the open session changes, so its view reloads. */
  const [revision, setRevision] = useState(0);

  // Agent state.
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [run, setRun] = useState<RunState | undefined>();
  const [runStartedAt, setRunStartedAt] = useState<number | undefined>();
  const [settings, setSettings] = useState<SettingsView | undefined>();
  const [newProjectId, setNewProjectId] = useState<string | undefined>();
  const [approval, setApproval] = useState<ApprovalPrompt | undefined>();
  const [outcomes, setOutcomes] = useState<Record<string, RunOutcome>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const loadFirstPage = useCallback(async () => {
    try {
      const page = await api.listSessions({});
      setSessions(page.items);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadFirstPage();
    return api.onChange((e) => {
      if (e.type !== "session") return;
      void loadFirstPage();
      if (e.id === selectedRef.current) {
        if (e.action === "deleted") setSelectedId(undefined);
        else setRevision((r) => r + 1);
      }
    });
  }, [api, loadFirstPage]);

  useEffect(() => {
    if (!agent) return;
    void agent.listProjects().then(setProjects);
    void agent.getSettings().then(setSettings);
    void agent.activeRun().then((ref) => ref && setRun((r) => r ?? ref));
    const offStatus = agent.onStatus((e) => {
      setRun((r) => reduceRun(r, e));
      if (e.type === "started") setRunStartedAt(Date.now());
      if (e.type === "started") setOutcomes(({ [e.sessionId]: _drop, ...rest }) => rest);
      if (e.type === "finished") {
        setOutcomes((o) => ({ ...o, [e.sessionId]: { status: e.status, message: e.message } }));
        setApproval((a) => (a?.runId === e.runId ? undefined : a));
        if (e.sessionId === selectedRef.current) setRevision((r) => r + 1);
      }
    });
    const offApproval = agent.onApproval(setApproval);
    return () => {
      offStatus();
      offApproval();
    };
  }, [agent]);

  // Search as you type, debounced.
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const page = await api.searchMessages({ query: text });
        if (!cancelled) setHits(page.items);
      } catch {
        // A query with no searchable words is not an error to show; it just finds nothing.
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, searchDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, query, searchDelay]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const page = await api.listSessions({ cursor: nextCursor });
    setSessions((prev) => [...prev, ...page.items.filter((s) => !prev.some((p) => p.id === s.id))]);
    setNextCursor(page.nextCursor);
  };

  const select = (id: string, messageId?: string) => {
    setView("session");
    setSelectedId(id);
    setFocusMessageId(messageId);
  };

  const openMemory = (id?: string) => {
    setView("memory");
    setMemoryFocus(id ? { id } : undefined);
  };

  const decide = (decision: ApprovalDecision) => {
    if (!agent || !approval) return;
    const id = approval.requestId;
    setApproval(undefined);
    void agent.respond(id, decision).catch(() => undefined);
  };

  const runningTitle = run ? untitled(sessions.find((s) => s.id === run.sessionId) ?? {}) : undefined;

  const startInput = (input: ComposerSubmit) => ({
    text: input.text,
    ...(input.images.length ? { images: input.images } : {}),
    ...(input.computerUse ? { computerUse: true } : {}),
    ...(input.allowFailingChecks ? { allowFailingChecks: true } : {}),
  });
  const addProject = async () => {
    if (!agent) return undefined;
    const p = await agent.addProject();
    if (p) setProjects((list) => [p, ...list.filter((x) => x.id !== p.id)]);
    return p;
  };

  return (
    <AttachmentContext.Provider value={agent ? agent.readAttachment : undefined}>
    <div className="app">
      <Sidebar
        sessions={sessions}
        loading={loading}
        error={error}
        hasMore={nextCursor !== undefined}
        onLoadMore={loadMore}
        selectedId={view === "session" ? selectedId : undefined}
        onSelect={(id) => select(id)}
        onRename={(id, title) => api.renameSession(id, title)}
        onDelete={(id) => api.deleteSession(id)}
        query={query}
        onQuery={setQuery}
        hits={hits}
        searching={searching}
        onOpenHit={(hit) => select(hit.sessionId, hit.messageId)}
        source={source}
        now={now}
        onOpenMemory={() => openMemory()}
        memoryActive={view === "memory"}
        {...(agent
          ? {
              onNewSession: () => setView("new"),
              newSessionActive: view === "new",
              runningSessionId: run?.sessionId,
              onOpenSettings: () => setSettingsOpen(true),
            }
          : {})}
      />
      <main className="main">
        {view === "memory" ? (
          <MemoryView api={api} projects={projects} now={now} focus={memoryFocus} searchDelay={searchDelay} onOpenSession={select} />
        ) : view === "new" && agent ? (
          <section className="start" aria-label="New session">
            <div className="start-inner">
              <Mark size={40} />
              <h1>What should we work on?</h1>
              <p className="meta">
                Pick a project folder, or start without one for questions, research and quick scripts. Paste or drop screenshots to show what you mean.
              </p>
              <Composer
                agent={agent}
                mode="new"
                projects={projects}
                projectId={newProjectId}
                onProjectChange={setNewProjectId}
                onAddProject={addProject}
                disabledReason={run ? `Another task is running in “${runningTitle}”.` : undefined}
                computerUse={settings?.computerUse ?? false}
                autoFocus
                onSubmit={async (input) => {
                  const ref = await agent.start({ ...startInput(input), ...(newProjectId ? { projectId: newProjectId } : {}) });
                  select(ref.sessionId);
                }}
              />
            </div>
          </section>
        ) : selectedId ? (
          <SessionView
            key={selectedId}
            api={api}
            sessionId={selectedId}
            revision={revision}
            focusMessageId={focusMessageId}
            now={now}
            projects={projects}
            onOpenMemory={openMemory}
            {...(agent
              ? {
                  agent: {
                    api: agent,
                    run,
                    runStartedAt,
                    approval,
                    outcome: outcomes[selectedId],
                    busyElsewhere: run && run.sessionId !== selectedId ? runningTitle : undefined,
                    computerUse: settings?.computerUse ?? false,
                    onSend: async (input) => {
                      // A message opened from search or evidence was for reading; a new turn goes to the end.
                      setFocusMessageId(undefined);
                      await agent.start({ sessionId: selectedId, ...startInput(input) });
                    },
                    onStop: () => run && void agent.stop(run.runId),
                    onDecide: decide,
                    onOpenSettings: () => setSettingsOpen(true),
                  },
                }
              : {})}
          />
        ) : (
          <div className="empty">
            <h1>Your history</h1>
            <p>Pick a session on the left, or search everything you've discussed.</p>
          </div>
        )}
      </main>
      {settingsOpen && agent && (
        <SettingsDialog
          agent={agent}
          api={api}
          projects={projects}
          onClose={() => {
            setSettingsOpen(false);
            void agent.getSettings().then(setSettings);
          }}
        />
      )}
    </div>
    </AttachmentContext.Provider>
  );
}
