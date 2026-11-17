import { isMemoryApiError, type MemoryEvent, type MemoryKind, type Trust } from "@kovach-dev/memory-contract";

export const KINDS: MemoryKind[] = ["preference", "decision", "convention", "open_issue", "lesson", "research"];

export const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "Preference",
  decision: "Decision",
  convention: "Convention",
  open_issue: "Open issue",
  lesson: "Lesson",
  research: "Research",
};

export const TRUST_LABELS: Record<Trust, string> = {
  user: "Set by you",
  verified: "Verified",
  official: "Official docs",
  inferred: "Inferred",
};

const ACTION_LABELS: Record<MemoryEvent["action"], string> = {
  created: "Created",
  accepted: "Accepted from review",
  edited: "Edited",
  superseded: "Replaced by a newer version",
  injected: "Used in a task",
  deleted: "Deleted",
};

const ACTOR_LABELS: Record<MemoryEvent["actor"], string> = {
  user: "by you",
  agent: "by the agent",
  system: "automatically",
};

export function eventLabel(e: Pick<MemoryEvent, "action" | "actor">): string {
  // "Used in a task automatically" reads oddly; injection is always the agent's doing.
  if (e.action === "injected" || e.action === "superseded") return ACTION_LABELS[e.action];
  return `${ACTION_LABELS[e.action]} ${ACTOR_LABELS[e.actor]}`;
}

/** "keyword_match" → "keyword match", "trust:user" → "trust: user". */
export function reasonLabel(reason: string): string {
  return reason.replace(/_/g, " ").replace(/:/g, ": ");
}

export function usesLabel(n: number): string {
  if (n === 0) return "Not used yet";
  if (n === 1) return "Used once";
  return `Used ${n} times`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const DAY = 24 * 60 * 60 * 1000;
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "expires today", "expires tomorrow", "expires in 12 days". */
export function expiresLabel(t: number, now: number): string {
  const days = Math.ceil((t - now) / DAY);
  if (days <= 0) return "expires today";
  return `expires ${rtf.format(days, "day")}`;
}

const FIELD_LABELS: Record<string, string> = {
  key: "Key",
  body: "Text",
  projectId: "Project",
  kind: "Kind",
  scope: "Scope",
};

interface ZodIssueLike {
  path?: unknown[];
  message?: string;
  code?: string;
  minimum?: number;
}

/**
 * A readable message for an error from the memory API. Validation errors carry
 * the schema's issue list as JSON; turn that into one line per field.
 */
export function errorText(err: unknown): string {
  if (isMemoryApiError(err, "project_mode")) {
    return "Memory for this project is read only or off, so nothing new can be saved there. Change it in Settings → Memory.";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isMemoryApiError(err, "invalid")) {
    try {
      const issues = JSON.parse(message) as ZodIssueLike[];
      if (Array.isArray(issues) && issues.length > 0) {
        return issues
          .map((i) => {
            const field = typeof i.path?.[0] === "string" ? i.path[0] : undefined;
            const label = field ? (FIELD_LABELS[field] ?? field) : undefined;
            if (i.code === "too_small" && i.minimum === 1 && label) return `${label} can't be empty.`;
            return label ? `${label}: ${i.message ?? "invalid"}` : (i.message ?? "Invalid input");
          })
          .join(" ");
      }
    } catch {
      // Not a schema issue list; show the message as it is.
    }
  }
  return message;
}
