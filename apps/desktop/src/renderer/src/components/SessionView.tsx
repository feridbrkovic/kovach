import { isMemoryApiError, type Message, type RetrievedItem, type SessionSummary } from "@kovach-dev/memory-contract";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentApi, ApprovalDecision, ApprovalPrompt, ProjectInfo, SessionFiles } from "../../../shared/agent";
import type { HistoryApi } from "../../../shared/ipc";
import type { RunOutcome, RunState } from "../run-state";
import { clockTime, relativeTime } from "../time";
import { Composer, type ComposerSubmit } from "./Composer";
import { UsedMemories } from "./UsedMemories";
import { FolderIcon } from "./icons";
import { Markdown } from "./Markdown";
import { ApprovalCard, LiveRun, OutcomeBanner } from "./RunPanel";
import { untitled } from "./Sidebar";
import { ToolCallView } from "./ToolCallView";

export interface SessionViewProps {
  api: HistoryApi;
  sessionId: string;
  revision: number;
  focusMessageId: string | undefined;
  now: () => number;
  projects?: ProjectInfo[];
  /** Opens the memory browser on one memory, from the "Used N memories" list under an answer. */
  onOpenMemory?: (id: string) => void;
  /** Present when the agent is available (inside the app, or the demo). */
  agent?: {
    api: AgentApi;
    run: RunState | undefined;
    runStartedAt: number | undefined;
    approval: ApprovalPrompt | undefined;
    outcome: RunOutcome | undefined;
    /** Title of a session where another task is running. */
    busyElsewhere: string | undefined;
    computerUse: boolean;
    onSend: (input: ComposerSubmit) => Promise<void>;
    onStop: () => void;
    onDecide: (decision: ApprovalDecision) => void;
    onOpenSettings: () => void;
  };
}

export function SessionView({ api, sessionId, revision, focusMessageId, now, agent, projects, onOpenMemory }: SessionViewProps) {
  const [session, setSession] = useState<SessionSummary | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Used memories per assistant message, fetched once per message while this session is open. */
  const usedCache = useRef(new Map<string, Promise<RetrievedItem[]>>());
  const usedMemories = useCallback(
    (messageId: string) => {
      let p = usedCache.current.get(messageId);
      if (!p) {
        // Older services or messages without retrieval have nothing to show; that's not an error.
        p = api.getUsedMemories(messageId).catch((): RetrievedItem[] => []);
        usedCache.current.set(messageId, p);
      }
      return p;
    },
    [api],
  );

  // Pages are newest first. Reloading (after a run, a rename…) keeps as many pages as were shown,
  // and goes back as far as it takes to reach a message opened from search.
  const pagesShown = useRef(1);
  useEffect(() => {
    pagesShown.current = 1;
  }, [sessionId]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let detail = await api.getSession(sessionId, { latest: true });
        let all = [...detail.messages.items];
        let pages = 1;
        while (detail.messages.nextCursor && (pages < pagesShown.current || (focusMessageId && !all.some((m) => m.id === focusMessageId)))) {
          detail = await api.getSession(sessionId, { latest: true, cursor: detail.messages.nextCursor });
          all = [...detail.messages.items, ...all];
          pages++;
        }
        if (cancelled) return;
        pagesShown.current = pages;
        setSession(detail.session);
        setMessages(all);
        setNextCursor(detail.messages.nextCursor);
        setError(undefined);
        setMissing(false);
      } catch (err) {
        if (cancelled) return;
        if (isMemoryApiError(err, "not_found")) setMissing(true);
        else setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, revision, focusMessageId]);

  const runHere = agent?.run && agent.run.sessionId === sessionId ? agent.run : undefined;
  const approvalHere = runHere && agent?.approval?.runId === runHere.runId ? agent.approval : undefined;

  // Opening a session, or starting a task in it, goes to the newest messages again.
  const runIdHere = runHere?.runId;
  useEffect(() => {
    if (focusMessageId) return;
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId, runIdHere, focusMessageId]);

  // Content also grows on its own (a reload after the run, memories that load later):
  // keep following it while the user is at the bottom.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current && !focusMessageId) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [focusMessageId, session !== undefined]);

  // Follow the conversation while the user is at the bottom; leave them alone if they scrolled up.
  useEffect(() => {
    if (focusMessageId) {
      document.getElementById(`msg-${focusMessageId}`)?.scrollIntoView?.({ block: "center" });
      return;
    }
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [focusMessageId, messages, runHere?.activity, approvalHere]);

  // Earlier messages go above; the view stays on what the user was reading.
  const keepPlace = useRef<number | undefined>(undefined);
  const loadEarlier = async () => {
    if (!nextCursor) return;
    const detail = await api.getSession(sessionId, { latest: true, cursor: nextCursor });
    const el = scroller.current;
    keepPlace.current = el ? el.scrollHeight - el.scrollTop : undefined;
    pagesShown.current++;
    setMessages((prev) => [...detail.messages.items, ...prev]);
    setNextCursor(detail.messages.nextCursor);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepPlace.current !== undefined) {
      el.scrollTop = el.scrollHeight - keepPlace.current;
      keepPlace.current = undefined;
    }
  }, [messages]);

  if (error) {
    return (
      <div className="empty" role="alert">
        <h1>Couldn't open this session</h1>
        <p>{error}</p>
      </div>
    );
  }
  // A session the agent just created may not be in the history the UI reads yet (the browser demo).
  if (missing && !runHere && !agent?.outcome) {
    return (
      <div className="empty" role="alert">
        <h1>This session no longer exists</h1>
      </div>
    );
  }
  if (!session && !missing) return <div className="empty" aria-busy="true" />;

  const project = session?.projectId ? projects?.find((p) => p.id === session.projectId) : undefined;
  const disabledReason = agent?.busyElsewhere ? `Another task is running in “${agent.busyElsewhere}”.` : undefined;

  return (
    <article className="session" aria-labelledby="session-title">
      <header className="session-header">
        <h1 id="session-title">{session ? untitled(session) : "New session"}</h1>
        {session && (
          <p className="meta session-meta">
            <span className="chip" title={project?.path}>
              <FolderIcon size={12} /> {session.projectId ? (project?.name ?? "Project") : "No project"}
            </span>
            {session.model && <span className="chip">{session.model}</span>}
            <span>
              {relativeTime(session.updatedAt, now())} · {session.messageCount} messages
            </span>
          </p>
        )}
      </header>

      <div
        className="transcript-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="transcript" ref={content}>
          {session?.summary && (
            <section className="summary" aria-label="Summary">
              <h2>Summary of earlier work</h2>
              <p>{session.summary}</p>
            </section>
          )}

          {nextCursor && (
            <button type="button" className="more" onClick={() => void loadEarlier()}>
              Load earlier messages
            </button>
          )}
          <ol className="messages">
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                focused={m.id === focusMessageId}
                usedMemories={usedMemories}
                onOpenMemory={onOpenMemory}
              />
            ))}
          </ol>

          {agent && runHere && agent.runStartedAt !== undefined && <LiveRun run={runHere} startedAt={agent.runStartedAt} />}
          {agent && approvalHere && <ApprovalCard approval={approvalHere} onDecide={agent.onDecide} />}
          {agent && !runHere && agent.outcome && <OutcomeBanner outcome={agent.outcome} onOpenSettings={agent.onOpenSettings} />}
          {agent && !runHere && session && !session.projectId && <SessionFilesBar agent={agent.api} sessionId={sessionId} revision={revision} />}
        </div>
      </div>

      {agent && session && (
        <div className="composer-dock">
          <Composer
            agent={agent.api}
            mode="continue"
            projectId={session.projectId}
            running={!!runHere}
            onStop={agent.onStop}
            disabledReason={disabledReason}
            computerUse={agent.computerUse}
            placeholder={`Reply to “${untitled(session)}”…`}
            onSubmit={agent.onSend}
          />
        </div>
      )}
    </article>
  );
}

function MessageView({
  message: m,
  focused,
  usedMemories,
  onOpenMemory,
}: {
  message: Message;
  focused: boolean;
  usedMemories: (messageId: string) => Promise<RetrievedItem[]>;
  onOpenMemory: ((id: string) => void) | undefined;
}) {
  const who = m.role === "user" ? "You" : m.role === "assistant" ? "Local Kovach" : m.role === "tool" ? "Checks" : m.role;
  const plan = m.role === "assistant" ? parsePlan(m.content) : undefined;
  return (
    <li id={`msg-${m.id}`} className={`message ${m.role}${focused ? " focused" : ""}`} aria-label={`${who} at ${clockTime(m.createdAt)}`}>
      {m.role === "user" ? (
        <div className="user-bubble">
          <Markdown text={m.content} citations="show" />
        </div>
      ) : plan ? (
        <section className="plan" aria-label="Plan">
          {plan.brief && (
            <div className="brief" role="group" aria-label="Brief">
              <h2>Brief</h2>
              <p className="plan-summary">{plan.brief.goal}</p>
              <details>
                <summary>How the request was understood</summary>
                {plan.brief.groups.map((g) => (
                  <div key={g.label} className="brief-group">
                    <h3>{g.label}</h3>
                    <ul>
                      {g.items.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            </div>
          )}
          <h2>Plan</h2>
          <p className="plan-summary">{plan.summary}</p>
          <ol>
            {plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      ) : m.role === "tool" ? (
        m.content && <pre className="tool-output system-note">{m.content}</pre>
      ) : (
        m.content && <Markdown text={m.content} />
      )}
      {m.toolCalls.length > 0 && (
        <div className="tool-calls">
          {m.toolCalls.map((c) => (
            <ToolCallView key={c.id} call={c} />
          ))}
        </div>
      )}
      {m.role === "assistant" && m.content && <UsedMemories messageId={m.id} load={usedMemories} onOpenMemory={onOpenMemory} />}
    </li>
  );
}

/**
 * A session without a project keeps its files in a private folder the user never sees:
 * this is the way to them, and to putting them somewhere of the user's choosing.
 */
function SessionFilesBar({ agent, sessionId, revision }: { agent: AgentApi; sessionId: string; revision: number }) {
  const [files, setFiles] = useState<SessionFiles | undefined>();
  const [note, setNote] = useState<{ text: string; error?: boolean } | undefined>();
  useEffect(() => {
    let cancelled = false;
    setNote(undefined);
    agent.sessionFiles(sessionId).then(
      (f) => !cancelled && setFiles(f),
      () => !cancelled && setFiles(undefined),
    );
    return () => {
      cancelled = true;
    };
  }, [agent, sessionId, revision]);
  if (!files || files.count === 0) return null;
  const run = async (action: () => Promise<string | undefined>) => {
    try {
      const text = await action();
      setNote(text ? { text } : undefined);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };
  const more = files.count - files.names.length;
  return (
    <section className="session-files" aria-label="Files from this session">
      <p>
        <strong>
          {files.count} file{files.count === 1 ? "" : "s"}
        </strong>{" "}
        in this session's own folder: <span className="session-file-names">{files.names.join(", ")}</span>
        {more > 0 ? ` and ${more} more` : ""}. Sessions without a project can't write anywhere else.
      </p>
      <div className="session-files-actions">
        {files.page && (
          <button type="button" className="secondary small" onClick={() => void run(async () => void (await agent.openSessionPage(sessionId)))}>
            Open {files.page} in browser
          </button>
        )}
        <button type="button" className="secondary small" onClick={() => void run(async () => void (await agent.showSessionFiles(sessionId)))}>
          Show in Finder
        </button>
        <button
          type="button"
          className="primary small"
          onClick={() =>
            void run(async () => {
              const saved = await agent.saveSessionFiles(sessionId);
              return saved ? `Saved ${saved.copied} file${saved.copied === 1 ? "" : "s"} to ${saved.path}` : undefined;
            })
          }
        >
          Save to folder…
        </button>
      </div>
      {note && (
        <p className={note.error ? "form-error" : "meta"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </section>
  );
}

export interface ParsedPlan {
  summary: string;
  steps: string[];
  /** The request restated as a ticket: goal, then labelled lists, in the order the agent wrote them. */
  brief?: { goal: string; groups: { label: string; items: string[] }[] };
}

const BRIEF_HEADINGS: Record<string, string> = {
  Deliver: "Deliverables",
  Must: "Requirements",
  "Done when": "Done when",
  "Not doing": "Out of scope",
  Assuming: "Assumptions",
};

/** The agent records its plan as "Plan: summary" plus numbered steps, then an optional "Brief" block of labelled lines. */
export function parsePlan(content: string): ParsedPlan | undefined {
  const [head, ...rest] = content.trim().split(/\n\nBrief\n/);
  const m = /^Plan: (.+)\n((?:\d+\. .+\n?)+)$/.exec(head!.trim());
  if (!m) return undefined;
  const plan: ParsedPlan = { summary: m[1]!, steps: m[2]!.trim().split("\n").map((l) => l.replace(/^\d+\.\s+/, "")) };
  if (rest.length !== 1) return rest.length ? undefined : plan;
  let goal = "";
  const groups: { label: string; items: string[] }[] = [];
  for (const line of rest[0]!.split("\n")) {
    const at = line.indexOf(": ");
    const label = at > 0 ? line.slice(0, at) : "";
    const text = line.slice(at + 2).trim();
    if (label === "Goal") goal = text;
    else if (BRIEF_HEADINGS[label]) {
      const heading = BRIEF_HEADINGS[label];
      const last = groups.at(-1);
      if (last?.label === heading) last.items.push(text);
      else groups.push({ label: heading, items: [text] });
    } else return undefined; // not the agent's format: show it as plain text
  }
  if (goal) plan.brief = { goal, groups };
  return plan;
}
