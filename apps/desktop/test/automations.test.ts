import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationRunner, createAutomationStore, memoryAutomationStore } from "../src/main/automations";
import type { AgentStatusEvent, RunRef, StartInput } from "../src/shared/agent";

// Tuesday 17 November 2026, 10:00.
const T0 = new Date(2026, 10, 17, 10, 0).getTime();
const HOUR = 3_600_000;

function host() {
  const started: StartInput[] = [];
  const stopped: string[] = [];
  let active: RunRef | undefined;
  let seq = 0;
  return {
    started,
    stopped,
    finish: (runner: AutomationRunner, status: "done" | "aborted" = "done", message = "All good.\nDetails…") => {
      const ref = active!;
      active = undefined;
      runner.onStatus({ ...ref, type: "finished", status, message } as AgentStatusEvent);
    },
    busy: (ref: RunRef | undefined) => (active = ref),
    impl: {
      async start(input: StartInput) {
        if (active) throw new Error("Another task is still running.");
        started.push(input);
        active = { runId: `run_${++seq}`, sessionId: `ses_${seq}` };
        return active;
      },
      async stop(runId: string) {
        stopped.push(runId);
      },
      activeRun: async () => active,
      projectExists: (id: string) => id === "prj_shop",
    },
  };
}

const daily8 = { name: "Morning check", prompt: "Run the tests and summarise failures", projectId: "prj_shop", schedule: { kind: "daily" as const, time: "08:00" } };

describe("automations", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("validates what it saves and works out the next run", () => {
    let now = T0;
    const runner = new AutomationRunner({ store: memoryAutomationStore(), host: host().impl, now: () => now });
    expect(() => runner.save({ ...daily8, name: " " })).toThrow(/name/);
    expect(() => runner.save({ ...daily8, schedule: { kind: "daily", time: "8" } })).toThrow(/HH:MM/);
    expect(() => runner.save({ ...daily8, projectId: "prj_gone" })).toThrow(/no longer exists/);
    const a = runner.save(daily8);
    expect(a).toMatchObject({ enabled: true, dryRunDone: false, nextRunAt: new Date(2026, 10, 18, 8, 0).getTime() });
    now += HOUR;
    expect(runner.save({ ...daily8, id: a.id, enabled: false }).nextRunAt).toBeUndefined();
  });

  it("starts with a trial run that only looks, then real runs; missed runs collapse into one", async () => {
    let now = T0;
    const h = host();
    const notes: string[] = [];
    const runner = new AutomationRunner({ store: memoryAutomationStore(), host: h.impl, now: () => now, notify: (t) => notes.push(t) });
    const a = runner.save(daily8);

    await runner.tick();
    expect(h.started).toHaveLength(0); // not due yet

    // The Mac slept through three mornings: one run on waking, not three.
    now = new Date(2026, 10, 20, 11, 0).getTime();
    await runner.tick();
    await runner.tick();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ projectId: "prj_shop", readOnly: true });
    expect(h.started[0]!.text).toMatch(/^This is a trial run of a scheduled task\. Don't change anything/);
    expect(h.started[0]!.title).toMatch(/^Morning check \(trial\) · /);
    expect(runner.list().items[0]).toMatchObject({ nextRunAt: new Date(2026, 10, 21, 8, 0).getTime(), lastRun: { status: "running", dryRun: true, sessionId: "ses_1" } });

    h.finish(runner);
    expect(notes).toEqual(["Morning check: trial run finished"]);
    expect(runner.list().items[0]).toMatchObject({ dryRunDone: true, lastRun: { status: "done", message: "All good.\nDetails…" } });

    // The next morning is a real run with the prompt as written.
    now = new Date(2026, 10, 21, 8, 0, 30).getTime();
    await runner.tick();
    expect(h.started[1]).toEqual({ text: daily8.prompt, projectId: "prj_shop", title: expect.stringMatching(/^Morning check · /) });

    // Changing what it does asks for a new trial.
    h.finish(runner);
    expect(runner.save({ ...daily8, id: a.id, prompt: "Run the tests and fix what fails" }).dryRunDone).toBe(false);
  });

  it("waits while another task runs, honours the kill switch, and stops runs over budget", async () => {
    let now = T0;
    const h = host();
    const runner = new AutomationRunner({ store: memoryAutomationStore(), host: h.impl, now: () => now, budgetMs: 20 });
    runner.save({ ...daily8, schedule: { kind: "every", hours: 1 } });
    now += HOUR + 1000;

    h.busy({ runId: "user_run", sessionId: "ses_user" });
    await runner.tick();
    expect(h.started).toHaveLength(0);
    h.busy(undefined);

    runner.setPaused(true);
    await runner.tick();
    expect(h.started).toHaveLength(0);
    runner.setPaused(false);

    await runner.tick();
    expect(h.started).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.stopped).toEqual(["run_1"]);
  });

  it("runs a one-off once, reports a run that can't start, and survives a restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "kovach-aut-"));
    const store = createAutomationStore(join(dir, "automations.json"));
    let now = T0;
    const h = host();
    const notes: string[] = [];
    const runner = new AutomationRunner({ store, host: h.impl, now: () => now, notify: (t, b) => notes.push(`${t}: ${b}`) });
    runner.save({ name: "Release notes", prompt: "Draft release notes", schedule: { kind: "once", at: T0 + HOUR } });
    now += 2 * HOUR;
    await runner.tick();
    expect(runner.list().items[0]).toMatchObject({ enabled: false, lastRun: { status: "running" } });
    expect(runner.list().items[0]!.nextRunAt).toBeUndefined();

    // The app quits mid-run: on the next start the run is reported as cut short.
    const restarted = new AutomationRunner({ store, host: host().impl, now: () => now });
    expect(restarted.list().items[0]!.lastRun).toMatchObject({ status: "aborted", message: "The app was closed during the run." });

    // A run that can't start is reported once, and rescheduled.
    const failing = { ...host().impl, start: async () => Promise.reject(new Error("The model server isn't answering")) };
    const r2 = new AutomationRunner({ store: memoryAutomationStore(), host: failing, now: () => now, notify: (t, b) => notes.push(`${t}: ${b}`) });
    r2.save({ ...daily8, schedule: { kind: "every", hours: 2 } });
    now += 3 * HOUR;
    await r2.tick();
    await r2.tick();
    expect(notes).toEqual(["Morning check didn't start: The model server isn't answering"]);
    expect(r2.list().items[0]!.lastRun).toMatchObject({ status: "error" });
  });
});
