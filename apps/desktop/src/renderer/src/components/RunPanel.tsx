import { useEffect, useState } from "react";
import type { ApprovalDecision, ApprovalPrompt } from "../../../shared/agent";
import { OUTCOME_TEXT, type RunOutcome, type RunState } from "../run-state";
import { CursorIcon, GlobeIcon, ImageIcon, MemoryIcon, TerminalIcon } from "./icons";
import { Markdown } from "./Markdown";

const APPROVAL_TITLE: Record<ApprovalPrompt["kind"], string> = {
  command: "Run this command?",
  check: "Run the project's check?",
  computer: "Allow this screen action?",
  web: "Allow web access?",
  media: "Generate this image?",
  memory: "Save this to memory?",
};

/** The live line under the transcript while a task runs: what it is doing, for how long, and the latest checks. */
export function LiveRun({ run, startedAt }: { run: RunState; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <section className="live" aria-label="Agent progress" aria-live="polite">
      <div className="live-line">
        <span className="spinner" aria-hidden="true" />
        <span className="live-text">{run.activity ?? "Starting…"}</span>
        <span className="meta">{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</span>
      </div>
      {run.plan && (
        <p className="meta live-plan">
          Plan: {run.plan.steps.length} step{run.plan.steps.length === 1 ? "" : "s"} · {run.plan.summary}
        </p>
      )}
      {run.checks && (
        <ul className="checks" aria-label="Latest checks">
          {run.checks.results.map((r) => (
            <li key={r.command} className={r.exitCode === 0 ? "ok" : "bad"}>
              {r.kind}: {r.exitCode === 0 ? "passed" : r.exitCode < 0 ? "not run" : `failed (exit ${r.exitCode})`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ApprovalCard({ approval, onDecide }: { approval: ApprovalPrompt; onDecide: (d: ApprovalDecision) => void }) {
  const Icon = approval.kind === "computer" ? CursorIcon : approval.kind === "web" ? GlobeIcon : approval.kind === "media" ? ImageIcon : approval.kind === "memory" ? MemoryIcon : TerminalIcon;
  const sessionLabel = approval.kind === "command" || approval.kind === "check" ? "Allow for this session" : "Allow all like this for this session";
  return (
    <div className="approval" role="alertdialog" aria-labelledby="approval-title" aria-describedby="approval-command">
      <h2 id="approval-title">{APPROVAL_TITLE[approval.kind]}</h2>
      <pre id="approval-command">
        <Icon /> {approval.command}
      </pre>
      <p className="meta">in {approval.cwd}</p>
      <div className="approval-actions">
        <button type="button" className="primary" onClick={() => onDecide("allow")} autoFocus>
          Allow once
        </button>
        {approval.kind !== "memory" && (
          <button type="button" className="secondary" onClick={() => onDecide("allow_session")}>
            {sessionLabel}
          </button>
        )}
        <button type="button" className="secondary" onClick={() => onDecide("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function OutcomeBanner({ outcome, onOpenSettings }: { outcome: RunOutcome; onOpenSettings: () => void }) {
  const ok = outcome.status === "done";
  const modelTrouble = outcome.status === "error" && /model server|unreachable|API key|refused|did not answer|does not fit/i.test(outcome.message);
  return (
    <div className={`outcome ${ok ? "ok" : outcome.status === "aborted" ? "neutral" : "bad"}`} role="status">
      <strong>{OUTCOME_TEXT[outcome.status]}</strong>
      {!ok && outcome.message && <Markdown text={outcome.message} />}
      {modelTrouble && (
        <button type="button" className="secondary" onClick={onOpenSettings}>
          Model settings
        </button>
      )}
    </div>
  );
}
