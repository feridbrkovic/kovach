const DAY = 24 * 60 * 60 * 1000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type DayGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";

/** Which sidebar group a timestamp falls in, relative to `now`. */
export function dayGroup(t: number, now: number): DayGroup {
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 7 * DAY) return "Previous 7 days";
  return "Older";
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "5 min ago", "yesterday", "3 days ago", or a date for anything older than a week. */
export function relativeTime(t: number, now: number): string {
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return rtf.format(-Math.floor(diff / 60_000), "minute");
  if (diff < DAY) return rtf.format(-Math.floor(diff / (60 * 60_000)), "hour");
  if (diff < 7 * DAY) return rtf.format(-Math.round(diff / DAY), "day");
  return new Date(t).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
}

export function clockTime(t: number): string {
  return new Date(t).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
}
