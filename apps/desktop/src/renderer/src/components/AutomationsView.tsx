import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AgentApi, Automation, AutomationsView as View, ProjectInfo } from "../../../shared/agent";
import { describeSchedule, parseWhen, type Schedule, validSchedule } from "../../../shared/schedule";
import { OUTCOME_TEXT } from "../run-state";
import { PlayIcon, PlusIcon } from "./icons";

export interface AutomationsViewProps {
  agent: AgentApi;
  projects: ProjectInfo[];
  now: () => number;
  /** A task is running: "Run now" would have to wait. */
  busy: boolean;
  onOpenSession: (id: string) => void;
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Tasks that start by themselves: a list, an editor, and the kill switch. */
export function AutomationsView(props: AutomationsViewProps) {
  const [view, setView] = useState<View | undefined>();
  const [editing, setEditing] = useState<Automation | "new" | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setView(await props.agent.listAutomations());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.agent]);

  useEffect(() => {
    void load();
    // Runs change what the list shows (last result, next time).
    return props.agent.onStatus((e) => {
      if (e.type === "started" || e.type === "finished") void load();
    });
  }, [props.agent, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const projectName = (id?: string) => (id ? (props.projects.find((p) => p.id === id)?.name ?? "A removed project") : "No project");

  return (
    <section className="memory-view automations" aria-labelledby="automations-title">
      <header className="memory-header">
        <div>
          <h1 id="automations-title">Automations</h1>
          <p className="meta">Tasks that start by themselves while Local Kovach is open. The first run of each is a trial that only looks and reports. Every run is a session in your history.</p>
        </div>
        <div className="automation-head-actions">
          {view && view.items.length > 0 && (
            <label className="check-option">
              <input type="checkbox" checked={view.paused} onChange={(e) => void act(() => props.agent.setAutomationsPaused(e.target.checked))} />
              Pause all
            </label>
          )}
          <button type="button" className="primary small" onClick={() => setEditing("new")} disabled={editing === "new"}>
            <PlusIcon size={13} /> New automation
          </button>
        </div>
      </header>

      <div className="memory-scroll">
        <div className="memory-content">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {view?.paused && <p className="banner">All automations are paused. Nothing starts until you switch “Pause all” off.</p>}

          {editing && (
            <AutomationEditor
              key={editing === "new" ? "new" : editing.id}
              initial={editing === "new" ? undefined : editing}
              projects={props.projects}
              now={props.now}
              onCancel={() => setEditing(undefined)}
              onSave={async (input) => {
                await props.agent.saveAutomation(input);
                setEditing(undefined);
                await load();
              }}
            />
          )}

          {view && view.items.length === 0 && !editing && (
            <div className="empty-state">
              <h2>Nothing scheduled yet</h2>
              <p className="meta">For example: every weekday at 9, run the tests in shop-app and summarise what fails; or every Monday at 8, check the dependencies for updates.</p>
            </div>
          )}

          <ul className="automation-list" aria-label="Automations">
            {view?.items.map((a) => (
              <li key={a.id} className={`automation${a.enabled ? "" : " off"}`}>
                <div className="automation-main">
                  <h3>{a.name}</h3>
                  <p className="meta">
                    {describeSchedule(a.schedule)} · {projectName(a.projectId)}
                    {!a.dryRunDone && " · trial run first"}
                  </p>
                  <p className="automation-prompt">{a.prompt}</p>
                  <p className="meta">
                    {a.enabled && a.nextRunAt !== undefined ? `Next: ${when(a.nextRunAt, props.now())}` : a.enabled ? "No more runs" : "Off"}
                    {a.lastRun && (
                      <>
                        {" · Last: "}
                        <button type="button" className="link-btn" onClick={() => props.onOpenSession(a.lastRun!.sessionId)} disabled={!a.lastRun.sessionId}>
                          {a.lastRun.status === "running" ? "running now" : `${a.lastRun.dryRun ? "trial, " : ""}${OUTCOME_TEXT[a.lastRun.status].toLowerCase()}, ${when(a.lastRun.at, props.now())}`}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                <div className="automation-actions">
                  <label className="switch" title={a.enabled ? "On" : "Off"}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${a.name} on`}
                      checked={a.enabled}
                      onChange={(e) => void act(() => props.agent.saveAutomation({ ...input(a), enabled: e.target.checked }))}
                    />
                    <span aria-hidden="true" />
                  </label>
                  <button
                    type="button"
                    className="secondary small"
                    disabled={props.busy}
                    title={props.busy ? "A task is running" : a.dryRunDone ? "Start a real run now" : "Start the trial run now"}
                    onClick={() => void act(async () => props.onOpenSession((await props.agent.runAutomation(a.id)).sessionId))}
                  >
                    <PlayIcon size={12} /> {a.dryRunDone ? "Run now" : "Try it"}
                  </button>
                  <button type="button" className="link-btn" onClick={() => setEditing(a)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="link-btn danger"
                    onClick={() => {
                      if (window.confirm(`Delete “${a.name}”? Its past runs stay in your history.`)) void act(() => props.agent.deleteAutomation(a.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

const input = (a: Automation) => ({ id: a.id, name: a.name, prompt: a.prompt, schedule: a.schedule, enabled: a.enabled, ...(a.projectId ? { projectId: a.projectId } : {}) });

function when(at: number, now: number): string {
  const d = new Date(at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = new Date(now);
  const sameDay = (x: Date, y: Date) => x.toDateString() === y.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, day)) return `today ${time}`;
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`;
  if (sameDay(d, yesterday)) return `yesterday ${time}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

type Kind = Schedule["kind"];

function AutomationEditor(props: {
  initial?: Automation | undefined;
  projects: ProjectInfo[];
  now: () => number;
  onCancel: () => void;
  onSave: (input: { id?: string; name: string; prompt: string; projectId?: string; schedule: Schedule }) => Promise<void>;
}) {
  const start = props.initial?.schedule;
  const [name, setName] = useState(props.initial?.name ?? "");
  const [prompt, setPrompt] = useState(props.initial?.prompt ?? "");
  const [projectId, setProjectId] = useState(props.initial?.projectId ?? "");
  const [words, setWords] = useState("");
  const [kind, setKind] = useState<Kind>(start?.kind ?? "daily");
  const [time, setTime] = useState(start?.kind === "daily" ? start.time : "09:00");
  const [days, setDays] = useState<number[]>(start?.kind === "daily" ? (start.days ?? [0, 1, 2, 3, 4, 5, 6]) : [1, 2, 3, 4, 5]);
  const [hours, setHours] = useState(start?.kind === "every" ? start.hours : 4);
  const [onceAt, setOnceAt] = useState(start?.kind === "once" ? localInput(start.at) : localInput(props.now() + 3_600_000));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const schedule: Schedule =
    kind === "every" ? { kind, hours } : kind === "once" ? { kind, at: new Date(onceAt).getTime() } : days.length === 7 ? { kind, time } : { kind, time, days };

  /** Typed words fill in the schedule fields, so the user sees what was understood. */
  const understand = (text: string) => {
    setWords(text);
    const s = parseWhen(text, props.now());
    if (!s) return;
    setKind(s.kind);
    if (s.kind === "daily") {
      setTime(s.time);
      setDays(s.days ?? [0, 1, 2, 3, 4, 5, 6]);
    } else if (s.kind === "every") setHours(s.hours);
    else setOnceAt(localInput(s.at));
  };
  const understood = words.trim() ? parseWhen(words, props.now()) : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validSchedule(schedule);
    if (problem) return setError(problem);
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave({ ...(props.initial ? { id: props.initial.id } : {}), name, prompt, ...(projectId ? { projectId } : {}), schedule });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="automation-editor" aria-label={props.initial ? `Edit ${props.initial.name}` : "New automation"} onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning test report" autoFocus />
      </label>
      <label>
        What to do
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Run the tests and summarise what fails, with the likely cause of each." />
      </label>
      <label>
        Where
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">No project</option>
          {props.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="when">
        <legend>When</legend>
        <label className="when-words">
          <span className="visually-hidden">When, in words</span>
          <input value={words} onChange={(e) => understand(e.target.value)} placeholder="Type it: every weekday at 9, svako jutro u 8, every 2 hours…" aria-label="When, in words" />
        </label>
        {words.trim() && (
          <p className="meta" role="status">
            {understood ? `Understood: ${describeSchedule(understood)}` : "Not understood yet; set it below."}
          </p>
        )}
        <div className="when-kind" role="radiogroup" aria-label="Repeat">
          {(["daily", "every", "once"] as Kind[]).map((k) => (
            <label key={k} className={`chip${kind === k ? " on" : ""}`}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {k === "daily" ? "On days" : k === "every" ? "Every few hours" : "Once"}
            </label>
          ))}
        </div>
        {kind === "daily" && (
          <div className="when-row">
            <div className="days" role="group" aria-label="Days">
              {DAY_LETTERS.map((letter, d) => (
                <button
                  key={DAY_NAMES[d]}
                  type="button"
                  className={`day${days.includes(d) ? " on" : ""}`}
                  aria-pressed={days.includes(d)}
                  aria-label={DAY_NAMES[d]}
                  onClick={() => setDays((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d].sort()))}
                >
                  {letter}
                </button>
              ))}
            </div>
            <label>
              <span className="visually-hidden">Time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
            </label>
          </div>
        )}
        {kind === "every" && (
          <label className="when-row">
            Every
            <input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Hours" />
            hours
          </label>
        )}
        {kind === "once" && <input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} aria-label="Date and time" />}
        {!validSchedule(schedule) && <p className="meta">{describeSchedule(schedule)}</p>}
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="button" className="secondary small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary small" disabled={saving || !name.trim() || !prompt.trim()}>
          {props.initial ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

function localInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
