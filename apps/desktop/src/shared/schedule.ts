/** When an automation runs. Times are the Mac's local time. */
export type Schedule =
  /** At a time of day, on some weekdays (0 = Sunday … 6 = Saturday) or every day when `days` is absent. */
  | { kind: "daily"; time: string; days?: number[] }
  /** Every so many hours. */
  | { kind: "every"; hours: number }
  /** Once, at a moment (epoch ms). */
  | { kind: "once"; at: number };

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function validSchedule(s: Schedule): string | undefined {
  if (s.kind === "daily") {
    if (!TIME.test(s.time)) return "Give the time as HH:MM, for example 08:30.";
    if (s.days && (s.days.length === 0 || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return "Pick at least one day.";
  } else if (s.kind === "every") {
    if (!Number.isInteger(s.hours) || s.hours < 1 || s.hours > 24 * 7) return "Every 1 to 168 hours.";
  } else if (!Number.isFinite(s.at)) return "Pick a date and time.";
  return undefined;
}

/**
 * The first run after `after`. A run missed while the Mac slept is not repeated: the next run is
 * always computed from now, so a week asleep gives one run on waking, not seven.
 */
export function nextRunAt(s: Schedule, after: number): number | undefined {
  if (s.kind === "once") return s.at > after ? s.at : undefined;
  if (s.kind === "every") return after + s.hours * 3_600_000;
  const [h, m] = s.time.split(":").map(Number) as [number, number];
  const days = s.days?.length ? new Set(s.days) : undefined;
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setHours(h, m);
  for (let i = 0; i < 8; i++) {
    if (at.getTime() > after && (!days || days.has(at.getDay()))) return at.getTime();
    at.setDate(at.getDate() + 1);
    at.setHours(h, m, 0, 0);
  }
  return undefined;
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function describeSchedule(s: Schedule): string {
  if (s.kind === "every") return s.hours === 1 ? "Every hour" : `Every ${s.hours} hours`;
  if (s.kind === "once") {
    const d = new Date(s.at);
    return `Once, ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const days = [...new Set(s.days ?? [])].sort();
  const when =
    days.length === 0 || days.length === 7
      ? "Every day"
      : days.join() === "1,2,3,4,5"
        ? "Weekdays"
        : days.join() === "0,6"
          ? "Weekends"
          : list(days.map((d) => DAY_NAMES[d]!));
  return `${when} at ${s.time}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** English and Bosnian day names (with and without the locative ending), Sunday first. */
const DAYS: [RegExp, number][] = [
  [/\b(sundays?|nedjelj\w*|nedelj\w*)\b/, 0],
  [/\b(mondays?|ponedjelj\w*|ponedelj\w*)\b/, 1],
  [/\b(tuesdays?|utor\w*)\b/, 2],
  [/\b(wednesdays?|srijed\w*|sred\w*)\b/, 3],
  [/\b(thursdays?|četvrt\w*|cetvrt\w*)\b/, 4],
  [/\b(fridays?|petak|petkom|petku)\b/, 5],
  [/\b(saturdays?|subot\w*)\b/, 6],
];

/**
 * Reads a schedule from plain words, in English or Bosnian: "every day at 8", "weekdays at 9:30",
 * "every Monday and Thursday at 18h", "every 2 hours", "tomorrow at 7", "svako jutro u 8",
 * "radnim danima u 9", "svaka 3 sata". Undefined when the words don't name a schedule.
 */
export function parseWhen(text: string, now = Date.now()): Schedule | undefined {
  const t = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;

  const hours = /\b(?:every|svak[aiu]h?|svakih)\s+(\d{1,3})\s*(?:hours?|hrs?|h|sat[ai]?|sati)\b/.exec(t);
  if (hours) return { kind: "every", hours: Number(hours[1]) };
  if (/\b(every hour|hourly|svaki sat|svakog sata)\b/.test(t)) return { kind: "every", hours: 1 };

  let time = readTime(t);
  if (!time) {
    if (/\b(morning|jutr\w*)\b/.test(t)) time = "08:00";
    else if (/\b(noon|midday|podne)\b/.test(t)) time = "12:00";
    else if (/\b(evening|night|veče\w*|vece\w*|noć\w*|noc\w*)/.test(t)) time = "19:00";
  }

  const once = /\b(today|danas)\b/.test(t) ? 0 : /\b(tomorrow|sutra)\b/.test(t) ? 1 : undefined;
  if (once !== undefined && time) {
    const d = new Date(now);
    d.setDate(d.getDate() + once);
    const [h, m] = time.split(":").map(Number) as [number, number];
    d.setHours(h, m, 0, 0);
    return d.getTime() > now ? { kind: "once", at: d.getTime() } : undefined;
  }

  let days: number[] | undefined;
  if (/\b(weekdays?|every weekday|work ?days?|radnim dan\w*|radni\w* dan\w*)\b/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\b(weekends?|vikend\w*)\b/.test(t)) days = [0, 6];
  else {
    const named = DAYS.filter(([re]) => re.test(t)).map(([, d]) => d);
    if (named.length) days = named;
  }
  const everyDay = /\b(every ?day|daily|each day|every (morning|evening|night)|svak\w* (dan|jutr\w*|veče\w*|vece\w*|noć\w*|noc\w*)|dnevno|svakodnevno)\b/.test(t);
  if (!time || (!days && !everyDay)) return undefined;
  return days ? { kind: "daily", time, days } : { kind: "daily", time };
}

function readTime(t: string): string | undefined {
  const m = /(?:\bat|\bu|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|h\b|sati\b|časova\b|casova\b)?/.exec(t) ?? /\b(\d{1,2})[:.](\d{2})\b/.exec(t) ?? /\b(\d{1,2})\s*(am|pm)\b/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const suffix = (m[3] ?? (m[2] && !/^\d/.test(m[2]) ? m[2] : "")) || "";
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${pad(h)}:${pad(min)}`;
}
