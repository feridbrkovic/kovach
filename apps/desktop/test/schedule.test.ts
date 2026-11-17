import { describe, expect, it } from "vitest";
import { describeSchedule, nextRunAt, parseWhen, validSchedule } from "../src/shared/schedule";

// Tuesday 17 November 2026, 10:15 local time.
const NOW = new Date(2026, 10, 17, 10, 15).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

describe("schedules", () => {
  it("finds the next run: later today, tomorrow, the next allowed weekday", () => {
    expect(nextRunAt({ kind: "daily", time: "18:00" }, NOW)).toBe(at(17, 18));
    expect(nextRunAt({ kind: "daily", time: "08:00" }, NOW)).toBe(at(18, 8));
    expect(nextRunAt({ kind: "daily", time: "10:15" }, NOW)).toBe(at(18, 10, 15)); // not the same minute again
    expect(nextRunAt({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, at(20, 12))).toBe(at(23, 9)); // Friday noon → Monday
    expect(nextRunAt({ kind: "daily", time: "09:30", days: [4] }, NOW)).toBe(at(19, 9, 30));
    expect(nextRunAt({ kind: "every", hours: 3 }, NOW)).toBe(NOW + 3 * 3_600_000);
    expect(nextRunAt({ kind: "once", at: at(18, 7) }, NOW)).toBe(at(18, 7));
    expect(nextRunAt({ kind: "once", at: at(16, 7) }, NOW)).toBeUndefined();
  });

  it("collapses runs missed while the Mac slept into one", () => {
    // Asleep from Tuesday to Saturday: the next run after waking is the coming one, not a backlog.
    expect(nextRunAt({ kind: "daily", time: "08:00" }, at(21, 11))).toBe(at(22, 8));
  });

  it("says when in plain words", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("Every day at 08:00");
    expect(describeSchedule({ kind: "daily", time: "09:00", days: [5, 1, 2, 3, 4] })).toBe("Weekdays at 09:00");
    expect(describeSchedule({ kind: "daily", time: "18:30", days: [1, 4] })).toBe("Mondays and Thursdays at 18:30");
    expect(describeSchedule({ kind: "every", hours: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "once", at: at(18, 7) })).toBe("Once, Wed 18 Nov at 07:00");
  });

  it("reads a schedule from English and Bosnian words", () => {
    expect(parseWhen("every day at 8", NOW)).toEqual({ kind: "daily", time: "08:00" });
    expect(parseWhen("Every morning", NOW)).toEqual({ kind: "daily", time: "08:00" });
    expect(parseWhen("weekdays at 9:30", NOW)).toEqual({ kind: "daily", time: "09:30", days: [1, 2, 3, 4, 5] });
    expect(parseWhen("every Monday and Thursday at 6pm", NOW)).toEqual({ kind: "daily", time: "18:00", days: [1, 4] });
    expect(parseWhen("every 2 hours", NOW)).toEqual({ kind: "every", hours: 2 });
    expect(parseWhen("tomorrow at 7", NOW)).toEqual({ kind: "once", at: at(18, 7) });
    expect(parseWhen("svako jutro u 8", NOW)).toEqual({ kind: "daily", time: "08:00" });
    expect(parseWhen("radnim danima u 9h", NOW)).toEqual({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] });
    expect(parseWhen("svaki ponedjeljak u 18:30", NOW)).toEqual({ kind: "daily", time: "18:30", days: [1] });
    expect(parseWhen("svaka 3 sata", NOW)).toEqual({ kind: "every", hours: 3 });
    expect(parseWhen("svako veče u 19", NOW)).toEqual({ kind: "daily", time: "19:00" });
    expect(parseWhen("svake večeri", NOW)).toEqual({ kind: "daily", time: "19:00" });
    expect(parseWhen("sutra u 7", NOW)).toEqual({ kind: "once", at: at(18, 7) });
    for (const words of ["sometime soon", "at 8", "every day", "today at 9"]) expect(parseWhen(words, NOW), words).toBeUndefined();
  });

  it("rejects schedules that can't run", () => {
    expect(validSchedule({ kind: "daily", time: "25:00" })).toMatch(/HH:MM/);
    expect(validSchedule({ kind: "daily", time: "08:00", days: [] })).toMatch(/at least one day/);
    expect(validSchedule({ kind: "every", hours: 0 })).toMatch(/1 to 168/);
    expect(validSchedule({ kind: "daily", time: "08:00", days: [1] })).toBeUndefined();
  });
});
