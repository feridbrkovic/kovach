import { readFileSync } from "node:fs";
import { type Fixture, type FixtureEvent, type FixtureHeader, FixtureLine, FORMAT_VERSION, formatIssues, SequenceChecker } from "./format.js";

/** A fixture that could not be parsed. `line` is 1-based. */
export class FixtureError extends Error {
  constructor(
    readonly source: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${source}:${line}: ${detail}`);
    this.name = "FixtureError";
  }
}

/** Reads and validates a JSONL fixture file. */
export function loadFixture(path: string): Fixture {
  return parseFixture(readFileSync(path, "utf8"), path);
}

/**
 * Parses and validates fixture text. Blank lines are ignored.
 *
 * A final line without a trailing newline that is not valid JSON is treated
 * as a write torn by a crash: it is dropped and the fixture is incomplete.
 */
export function parseFixture(text: string, source = "<fixture>"): Fixture {
  const rows = text.split("\n");
  const tornTailPossible = !text.endsWith("\n");
  const checker = new SequenceChecker();
  let header: FixtureHeader | undefined;
  const events: FixtureEvent[] = [];
  let complete = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNo = i + 1;
    if (row.trim() === "") continue;

    let json: unknown;
    try {
      json = JSON.parse(row);
    } catch {
      if (tornTailPossible && i === rows.length - 1 && header !== undefined) break;
      throw new FixtureError(source, lineNo, "not valid JSON");
    }

    if (header === undefined) checkVersion(json, source, lineNo);

    const parsed = FixtureLine.safeParse(json);
    if (!parsed.success) {
      const type = typeof json === "object" && json !== null && "type" in json ? String(json.type) : "unknown";
      throw new FixtureError(source, lineNo, `invalid "${type}" line: ${formatIssues(parsed.error)}`);
    }
    const line = parsed.data;
    const problem = checker.check(line);
    if (problem) throw new FixtureError(source, lineNo, problem);

    if (line.type === "header") {
      header = line;
    } else {
      events.push(line);
      if (line.type === "end") complete = true;
    }
  }

  if (header === undefined) throw new FixtureError(source, 1, "empty fixture: missing header");
  return { header, events, complete };
}

function checkVersion(json: unknown, source: string, lineNo: number): void {
  if (typeof json !== "object" || json === null) return;
  const v = (json as { formatVersion?: unknown }).formatVersion;
  if ((json as { type?: unknown }).type === "header" && v !== undefined && v !== FORMAT_VERSION) {
    throw new FixtureError(source, lineNo, `unsupported fixture formatVersion ${JSON.stringify(v)} (this loader reads ${FORMAT_VERSION})`);
  }
}
