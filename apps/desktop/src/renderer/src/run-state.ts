import type { AgentStatusEvent, PlanStep, RunFinalStatus, RunRef } from "../../shared/agent";

export interface RunState extends RunRef {
  plan?: { summary: string; steps: PlanStep[] };
  activity?: string;
  checks?: { passed: boolean; results: { kind: string; command: string; exitCode: number }[] };
}

export interface RunOutcome {
  status: RunFinalStatus;
  message: string;
}

/** Fold a status event into the current run. Returns the new run (undefined once it finished). */
export function reduceRun(run: RunState | undefined, e: AgentStatusEvent): RunState | undefined {
  if (e.type === "started") return { runId: e.runId, sessionId: e.sessionId };
  if (!run || run.runId !== e.runId) return run;
  switch (e.type) {
    case "plan":
      return { ...run, plan: { summary: e.summary, steps: e.steps } };
    case "activity":
      return { ...run, activity: e.text };
    case "checks":
      return { ...run, checks: { passed: e.passed, results: e.results } };
    case "finished":
      return undefined;
  }
}

export const OUTCOME_TEXT: Record<RunFinalStatus, string> = {
  done: "Done",
  done_with_failing_checks: "Finished, but checks fail",
  checks_failed: "Stopped: checks still fail",
  max_turns: "Stopped: too many steps without finishing",
  aborted: "Stopped",
  error: "Something went wrong",
};
