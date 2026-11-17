/**
 * Eval task formats. A suite is one JSON file; the runner loads every suite under
 * evals/fixtures (public, synthetic) and evals/private (client work, never committed).
 *
 * Retrieval suite: a small world of projects, memories and verified fixes, plus
 * questions that each name the item that should come back.
 *
 * Extraction suite: recorded sessions, each with what is worth proposing from it
 * (often nothing). Anything else proposed counts against precision.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Stack = "rn" | "php" | "js" | "web" | "general";
const STACKS: Stack[] = ["rn", "php", "js", "web", "general"];

export interface ProjectFixture {
  id: string;
  name: string;
  /** npm dependencies written to package.json, e.g. {"react-native": "0.77.1"}. */
  npm?: Record<string, string>;
  /** composer requirements written to composer.json, e.g. {"laravel/framework": "^11.0"}. */
  composer?: Record<string, string>;
}

export interface MemoryFixture {
  id: string;
  /** Project id for project-scoped memories; absent means global. */
  project?: string;
  kind: "preference" | "decision" | "convention" | "lesson" | "research" | "open_issue";
  key: string;
  body: string;
}

export interface EpisodeFixture {
  id: string;
  project: string;
  problem: string;
  /** The failing output as the runner printed it; its signature is computed like a real run's. */
  error: string;
  fix: string;
  /** Project-neutral, shown in other projects. */
  lesson: string;
  verifiedBy?: "test" | "build" | "typecheck" | "run";
}

export interface QuestionFixture {
  id: string;
  stack: Stack;
  /** The project the question is asked in; absent for a chat without a project. */
  project?: string;
  text: string;
  errorOutput?: string;
  /** Memory or episode ids; any one of them in the top 6 is a hit. */
  expect: string[];
}

export interface RetrievalSuite {
  kind: "retrieval";
  name: string;
  file: string;
  projects: ProjectFixture[];
  memories: MemoryFixture[];
  episodes: EpisodeFixture[];
  questions: QuestionFixture[];
}

export type StepFixture =
  | ["user" | "assistant", string]
  /** ["tool", name, args, exitCode, output] */
  | ["tool", string, Record<string, unknown>, number, string];

export interface ExpectedProposal {
  /** Case-insensitive regular expression matched against "key body". */
  match: string;
  scope?: "global" | "project";
  /** The kind, or the kinds a reviewer would accept. */
  kind?: MemoryFixture["kind"] | MemoryFixture["kind"][];
}

export interface SessionFixture {
  id: string;
  stack: Stack;
  project?: string;
  /** What the session is about, for the report. */
  note?: string;
  steps: StepFixture[];
  /** Proposals that should come out; an empty list means nothing is worth remembering. */
  expect: ExpectedProposal[];
}

export interface ExtractionSuite {
  kind: "extraction";
  name: string;
  file: string;
  projects: ProjectFixture[];
  sessions: SessionFixture[];
}

export type Suite = RetrievalSuite | ExtractionSuite;

export class FixtureError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new FixtureError(`${where}: expected a non-empty string`);
  return v;
};
const arr = (v: unknown, where: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new FixtureError(`${where}: expected a list`);
  return v;
};
const stack = (v: unknown, where: string): Stack => {
  if (!STACKS.includes(v as Stack)) throw new FixtureError(`${where}: stack must be one of ${STACKS.join(", ")}`);
  return v as Stack;
};
const KINDS = ["preference", "decision", "convention", "lesson", "research", "open_issue"] as const;

function uniqueIds(items: { id: string }[], where: string): Set<string> {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.id)) throw new FixtureError(`${where}: duplicate id "${i.id}"`);
    seen.add(i.id);
  }
  return seen;
}

function parseProjects(raw: unknown, where: string): ProjectFixture[] {
  return arr(raw, `${where}.projects`).map((p, i) => {
    const w = `${where}.projects[${i}]`;
    if (!isObj(p)) throw new FixtureError(`${w}: expected an object`);
    const out: ProjectFixture = { id: str(p.id, `${w}.id`), name: str(p.name, `${w}.name`) };
    if (p.npm !== undefined) out.npm = p.npm as Record<string, string>;
    if (p.composer !== undefined) out.composer = p.composer as Record<string, string>;
    return out;
  });
}

/** Validate one suite file's content. Throws FixtureError with the path of the first problem. */
export function parseSuite(raw: unknown, file: string): Suite {
  if (!isObj(raw)) throw new FixtureError(`${file}: expected an object`);
  const name = typeof raw.name === "string" ? raw.name : file;
  const projects = parseProjects(raw.projects, file);
  const projectIds = uniqueIds(projects, `${file}.projects`);
  const projectRef = (v: unknown, w: string): string | undefined => {
    if (v === undefined) return undefined;
    const id = str(v, w);
    if (!projectIds.has(id)) throw new FixtureError(`${w}: unknown project "${id}"`);
    return id;
  };

  if (raw.kind === "retrieval") {
    const memories = arr(raw.memories, `${file}.memories`).map((m, i): MemoryFixture => {
      const w = `${file}.memories[${i}]`;
      if (!isObj(m)) throw new FixtureError(`${w}: expected an object`);
      if (!KINDS.includes(m.kind as MemoryFixture["kind"])) throw new FixtureError(`${w}.kind: unknown kind "${String(m.kind)}"`);
      const project = projectRef(m.project, `${w}.project`);
      return { id: str(m.id, `${w}.id`), ...(project ? { project } : {}), kind: m.kind as MemoryFixture["kind"], key: str(m.key, `${w}.key`), body: str(m.body, `${w}.body`) };
    });
    const episodes = arr(raw.episodes, `${file}.episodes`).map((e, i): EpisodeFixture => {
      const w = `${file}.episodes[${i}]`;
      if (!isObj(e)) throw new FixtureError(`${w}: expected an object`);
      return {
        id: str(e.id, `${w}.id`),
        project: projectRef(e.project, `${w}.project`) ?? str(e.project, `${w}.project`),
        problem: str(e.problem, `${w}.problem`),
        error: str(e.error, `${w}.error`),
        fix: str(e.fix, `${w}.fix`),
        lesson: str(e.lesson, `${w}.lesson`),
        ...(e.verifiedBy ? { verifiedBy: e.verifiedBy as EpisodeFixture["verifiedBy"] } : {}),
      };
    });
    const itemIds = uniqueIds([...memories, ...episodes], `${file} memories and episodes`);
    const questions = arr(raw.questions, `${file}.questions`).map((q, i): QuestionFixture => {
      const w = `${file}.questions[${i}]`;
      if (!isObj(q)) throw new FixtureError(`${w}: expected an object`);
      const expect = arr(q.expect, `${w}.expect`).map((x, j) => str(x, `${w}.expect[${j}]`));
      if (expect.length === 0) throw new FixtureError(`${w}.expect: name at least one memory or episode`);
      for (const x of expect) if (!itemIds.has(x)) throw new FixtureError(`${w}.expect: unknown item "${x}"`);
      const project = projectRef(q.project, `${w}.project`);
      return {
        id: str(q.id, `${w}.id`),
        stack: stack(q.stack, `${w}.stack`),
        ...(project ? { project } : {}),
        text: str(q.text, `${w}.text`),
        ...(typeof q.errorOutput === "string" ? { errorOutput: q.errorOutput } : {}),
        expect,
      };
    });
    uniqueIds(questions, `${file}.questions`);
    return { kind: "retrieval", name, file, projects, memories, episodes, questions };
  }

  if (raw.kind === "extraction") {
    const sessions = arr(raw.sessions, `${file}.sessions`).map((s, i): SessionFixture => {
      const w = `${file}.sessions[${i}]`;
      if (!isObj(s)) throw new FixtureError(`${w}: expected an object`);
      const steps = arr(s.steps, `${w}.steps`).map((st, j): StepFixture => {
        const ws = `${w}.steps[${j}]`;
        if (!Array.isArray(st)) throw new FixtureError(`${ws}: expected a list`);
        if ((st[0] === "user" || st[0] === "assistant") && st.length === 2) return [st[0], str(st[1], `${ws}[1]`)];
        if (st[0] === "tool" && st.length === 5 && isObj(st[2]) && typeof st[3] === "number" && typeof st[4] === "string") {
          return ["tool", str(st[1], `${ws}[1]`), st[2], st[3], st[4]];
        }
        throw new FixtureError(`${ws}: expected ["user"|"assistant", text] or ["tool", name, args, exitCode, output]`);
      });
      if (steps.length === 0) throw new FixtureError(`${w}.steps: empty session`);
      const expect = arr(s.expect, `${w}.expect`).map((x, j): ExpectedProposal => {
        const we = `${w}.expect[${j}]`;
        if (!isObj(x)) throw new FixtureError(`${we}: expected an object`);
        const match = str(x.match, `${we}.match`);
        try {
          new RegExp(match, "i");
        } catch {
          throw new FixtureError(`${we}.match: not a valid regular expression`);
        }
        if (x.scope !== undefined && x.scope !== "global" && x.scope !== "project") throw new FixtureError(`${we}.scope: global or project`);
        const kinds = x.kind === undefined ? [] : Array.isArray(x.kind) ? x.kind : [x.kind];
        for (const k of kinds) if (!KINDS.includes(k as MemoryFixture["kind"])) throw new FixtureError(`${we}.kind: unknown kind "${String(k)}"`);
        return { match, ...(x.scope ? { scope: x.scope } : {}), ...(x.kind !== undefined ? { kind: x.kind as ExpectedProposal["kind"] } : {}) } as ExpectedProposal;
      });
      const project = projectRef(s.project, `${w}.project`);
      return {
        id: str(s.id, `${w}.id`),
        stack: stack(s.stack, `${w}.stack`),
        ...(project ? { project } : {}),
        ...(typeof s.note === "string" ? { note: s.note } : {}),
        steps,
        expect,
      };
    });
    uniqueIds(sessions, `${file}.sessions`);
    return { kind: "extraction", name, file, projects, sessions };
  }
  throw new FixtureError(`${file}: kind must be "retrieval" or "extraction"`);
}

/** Every *.json suite under the given folders (missing folders are skipped), sorted by path. */
export function loadSuites(dirs: string[], base = process.cwd()): Suite[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".json")) files.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return files.sort().map((f) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f, "utf8"));
    } catch (err) {
      throw new FixtureError(`${relative(base, f)}: not valid JSON (${(err as Error).message})`);
    }
    return parseSuite(raw, relative(base, f));
  });
}
