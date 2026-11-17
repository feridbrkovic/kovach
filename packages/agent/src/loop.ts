import { existsSync } from "node:fs";
import { z } from "zod";
import { type Check, detectChecks } from "./checks.js";
import { ModelError, textOf } from "./model.js";
import type { ChatMessage, ChatModel, ChatResponse, ContentPart, ImagePart, ToolCallRequest } from "./model.js";
import { unifiedDiff } from "./diff.js";
import { pickPlaybooks, renderPlaybooks, wantsNewApp, wantsNewPage } from "./playbooks.js";
import { planPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { formatIssue, type ReviewIssue, reviewChange, reviewNudge } from "./review.js";
import {
  type AgentTool,
  allChecksPassed,
  type Approver,
  type CheckRun,
  describeChecks,
  runChecks,
  TOOLS,
  type ToolContext,
  type ToolOutcome,
  toolSpecs,
} from "./tools.js";
import { type Workspace, WorkspaceError } from "./workspace.js";

/**
 * Where a run is written. `HistoryStore` from @kovach-dev/memory-service fits
 * this shape; it is an interface so the agent doesn't depend on the database.
 */
export interface SessionRecorder {
  appendMessage(
    sessionId: string,
    m: {
      role: "user" | "assistant" | "tool" | "system";
      content: string;
      model?: string;
      tokens?: number;
      toolCalls?: { name: string; args?: unknown; command?: string }[];
    },
  ): { toolCalls: { id: string }[] };
  completeToolCall(toolCallId: string, result: { exitCode?: number; output?: string; durationMs?: number }): unknown;
}

const briefList = (what: string) => z.array(z.string().min(1)).max(8).default([]).describe(what);

/** The user's request restated as an engineering ticket (see planPrompt). */
export const Brief = z.object({
  goal: z.string().min(1).describe("One sentence: the outcome the user wants"),
  deliverables: briefList("Files or behaviour that will exist when done"),
  requirements: briefList("What the result must satisfy: the user's own, plus the standard ones that apply"),
  acceptance: briefList("Checks that can be verified by reading the result or running something"),
  outOfScope: briefList("What is left alone"),
  assumptions: briefList("Choices made where the request was open, and anything that can't be done here"),
});
export type Brief = z.infer<typeof Brief>;

export const Plan = z.object({
  // First, so the model writes the brief before the steps that carry it out.
  brief: Brief.optional(),
  title: z.string().max(80).optional().describe("A name for this task in 3 to 6 words, for a list of sessions"),
  summary: z.string().min(1).describe("One sentence: what will change"),
  steps: z
    .array(
      z.object({
        title: z.string().min(1).describe("Imperative, specific step"),
        files: z.array(z.string()).describe("Files this step reads or changes"),
      }),
    )
    .min(1)
    .max(7),
});
export type Plan = z.infer<typeof Plan>;

/** What the host saw when it opened a page the agent built. */
export interface PageLook {
  /** Screenshots, each with a short label ("Phone, 390 px wide"). */
  shots: { label: string; image: ImagePart }[];
  /** Problems a browser can measure (console errors, horizontal overflow, missing alt text…), one per line. */
  findings: string[];
}

export type AgentEvent =
  | { type: "plan"; plan: Plan }
  /** A long reply is being generated: which tool call, for which file, and how many lines so far. */
  | { type: "progress"; tool?: string; path?: string; lines?: number; chars: number }
  | { type: "review"; issues: ReviewIssue[] }
  | { type: "thinking" }
  | { type: "assistant"; content: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool"; name: string; args: unknown; ok: boolean; summary: string }
  | { type: "checks"; runs: CheckRun[]; passed: boolean }
  | { type: "done"; outcome: AgentOutcome };

export type AgentStatus =
  | "done" // finished, checks green (or no checks / nothing edited)
  | "done_with_failing_checks" // finished red because the user allowed it
  | "checks_failed" // gave up: checks still red after the allowed rounds
  | "max_turns"
  | "aborted"
  | "error";

export interface AgentOutcome {
  status: AgentStatus;
  turns: number;
  /** The model's closing message (or the reason it stopped). */
  message: string;
  plan?: Plan;
  checks?: CheckRun[];
  edited: boolean;
}

export interface AgentOptions {
  model: ChatModel;
  workspace: Workspace;
  task: string | ContentPart[];
  approve: Approver;
  /** How many of the most recent tool images to keep in context. Default 3. */
  keepImages?: number;
  /** Earlier turns of a resumed session, oldest first. */
  priorMessages?: ChatMessage[];
  history?: { recorder: SessionRecorder; sessionId: string };
  /** Defaults to the project's detected typecheck, lint and test. */
  checks?: Check[];
  /** Ask for a plan of at most 7 steps before working. Default true. */
  plan?: boolean;
  maxTurns?: number;
  /** How many times the loop sends red checks back to the model before giving up. Default 3. */
  maxCheckRounds?: number;
  /** The user's override: allow finishing while checks are red. */
  allowFailingChecks?: boolean;
  /** Review the change with fresh context before finishing (MASTER_PLAN › Agent quality, item 6). Default true. */
  review?: boolean;
  /** The model for the review; defaults to `model`. */
  reviewModel?: ChatModel;
  /** Invalid tool calls in a row before the run stops (2 retries). Default 3. */
  maxInvalidToolTurns?: number;
  limits?: Partial<ToolContext["limits"]>;
  tools?: AgentTool[];
  /** Extra capability hints for the system prompt (web, computer, images, scratch). */
  promptExtras?: import("./prompt.js").PromptExtras;
  /** The user's own standards (free text from the app's settings); the planner puts them before the built-in ones. */
  standards?: string;
  /**
   * Looks at a web page the run built, the way a person would open it: screenshots at phone and
   * desktop width plus what a browser can measure. Given by the host (it needs a browser); when
   * set, the agent sees the result once before finishing and can fix what it sees.
   */
  lookAt?: (page: string, signal?: AbortSignal) => Promise<PageLook | undefined>;
  /**
   * Long-term memory for this task. `system` is the always-on block (fixed for a
   * session so the prompt cache holds); `task` is the recalled block, added to the
   * user's turn for the model only — history keeps the user's words as typed.
   */
  memory?: { system?: string; task?: string };
  /**
   * Called with the output of a failing check or command. Whatever it returns
   * (fixes for the same error seen before) is added to that tool result, so the
   * model can apply a known fix instead of rediscovering it.
   */
  recall?: (errorOutput: string) => Promise<string | undefined>;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

type ParsedCall = { call: ToolCallRequest; tool: AgentTool; args: unknown } | { call: ToolCallRequest; error: string };

export async function runAgentTask(options: AgentOptions): Promise<AgentOutcome> {
  const { model, workspace, history } = options;
  // "Question only, don't change anything": the tools that write files aren't offered at all.
  // Told not to change anything, the model still saves its answer to a file now and then.
  const tools = isReadOnlyRequest(textOf(options.task)) ? (options.tools ?? TOOLS).filter((t) => !WRITING_TOOLS.has(t.name)) : (options.tools ?? TOOLS);
  const specs = toolSpecs(tools);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const checks = options.checks ?? detectChecks(workspace.root);
  const maxTurns = options.maxTurns ?? 40;
  const maxCheckRounds = options.maxCheckRounds ?? 3;
  const maxInvalid = options.maxInvalidToolTurns ?? 3;
  const ctx: ToolContext = {
    workspace,
    approve: options.approve,
    checks,
    limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 10 * 60_000, ...options.limits },
    createdThisRun: new Set<string>(),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const emit = (e: AgentEvent) => options.onEvent?.(e);

  const system = SYSTEM_PROMPT(checks, options.promptExtras) + (options.memory?.system ? `\n\n${options.memory.system}` : "");
  const recalled = options.memory?.task ? `\n\n${options.memory.task}` : "";
  const task = options.task;
  let firstTurn: string | ContentPart[];
  if (typeof task === "string") firstTurn = task + recalled;
  else {
    const at = task.findIndex((q) => q.type === "text");
    firstTurn = recalled && at >= 0 ? task.map((p, i) => (i === at && p.type === "text" ? { ...p, text: p.text + recalled } : p)) : task;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...(options.priorMessages ?? []),
    { role: "user", content: firstTurn },
  ];
  /** Images the user gave with the task stay in context; only tool images get pruned. */
  const taskIndex = messages.length - 1;
  record("user", textOf(options.task));

  let plan: Plan | undefined;
  let edited = false;
  let greenSinceLastEdit = false;
  let lastChecks: CheckRun[] | undefined;
  let checkRounds = 0;
  let invalidTurns = 0;
  let turns = 0;
  /** Kinds of non-answer already sent back (each once per run). */
  const actNudges = new Set<string>();
  let askedForAnswer = false;
  /** A new web page: the first step is the page builder, and only it is offered until it has run. */
  let buildWithKit = false;
  let kitTurns = 0;
  /** A new mobile app: the project was created with create-expo-app; app_kit is the only tool offered until it has run. */
  let startWithAppKit = false;
  /** Tools that have run successfully in this task. */
  const succeeded = new Set<string>();
  let modelRetries = 0;
  /** The last turn's tool calls, and how many turns in a row they have been exactly the same. */
  let lastCalls = "";
  let sameCalls = 0;
  let degenerateRetries = 0;
  /** Each file this run changed, with its content before the first change (null: new file). */
  const originals = new Map<string, string | null>();
  let reviewed = false;
  let looked = false;

  const finish = (status: AgentStatus, message: string): AgentOutcome => {
    const outcome: AgentOutcome = { status, turns, message, edited };
    if (plan) outcome.plan = plan;
    if (lastChecks) outcome.checks = lastChecks;
    emit({ type: "done", outcome });
    return outcome;
  };

  try {
    // 1. Plan, then small steps.
    if (options.plan !== false) {
      plan = await makePlan();
      // A new web page is built by the page builder, whatever steps the model planned:
      // left to choose, it sometimes plans to hand-write HTML and CSS instead.
      const files = await workspace.listFiles(300);
      buildWithKit = tools.some((t) => t.name === "design_kit") && wantsNewPage(textOf(options.task)) && pickPlaybooks(textOf(options.task), files).some((p) => p.id === "web-page") && !files.some((f) => /(^|\/)index\.html?$/i.test(f));
      if (plan && buildWithKit) {
        plan.steps = [
          { title: "Write the page's content and build the page with design_kit", files: ["index.html", "styles.css", "script.js"] },
          { title: "Look at the page and adjust wording, pictures and details", files: ["index.html"] },
        ];
      }
      // A new mobile app in an empty folder is created by Expo's own generator, not typed out by
      // the model: its hand-written package.json and template are a year out of date.
      const newApp = !buildWithKit && files.length === 0 && tools.some((t) => t.name === "app_kit") && tools.some((t) => t.name === "run_command") && wantsNewApp(textOf(options.task)) && pickPlaybooks(textOf(options.task), []).some((p) => p.id === "react-native");
      if (plan && newApp) {
        plan.steps = [
          { title: "Create the Expo project with create-expo-app", files: ["package.json"] },
          { title: "Add the architecture with app_kit", files: ["src/lib/api.ts", "docs/ARCHITECTURE.md"] },
          { title: "Install the packages and wrap the root layout in AppProviders", files: ["package.json"] },
          { title: "Build each feature in its folder and give it a route", files: [] },
          { title: "Run the checks: tsc, expo lint, expo-doctor", files: [] },
        ];
      }
      if (plan) {
        const text = renderPlan(plan);
        messages.push({ role: "assistant", content: text });
        record("assistant", text);
        emit({ type: "plan", plan });
      }
      if (newApp) {
        const create = tools.find((t) => t.name === "run_command")!;
        const step = async (label: string, command: string) => {
          const args = { command, timeoutSeconds: 900 };
          emit({ type: "tool_start", name: "run_command", args });
          const result = await create.run(args, ctx);
          const ids = record("tool", label, [{ name: "run_command", args }]);
          if (ids?.[0]) history!.recorder.completeToolCall(ids[0], { exitCode: result.exitCode ?? (result.ok ? 0 : 1), output: result.output ?? result.content, ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}) });
          emit({ type: "tool", name: "run_command", args, ok: result.ok, summary: result.content.split("\n")[0]! });
          return result;
        };
        let outcome = await step("Creating the Expo project", "npx --yes create-expo-app@latest . --template default");
        // Without a terminal the generator can skip installing; nothing else works until the packages are there.
        if (outcome.ok && !existsSync(workspace.resolve("node_modules/expo/package.json"))) outcome = await step("Installing the project's packages", "npm install --no-audit --no-fund");
        startWithAppKit = outcome.ok;
        const note = outcome.ok
          ? "The Expo project now exists: it was created with `npx create-expo-app@latest` (current SDK, versions and layout; its AGENTS.md says what changed in this SDK). Don't write package.json or the template files yourself. Call app_kit now with the app's name, whether users sign in, and its main features (kebab-case names); add the bundle identifier only if the user gave one. Don't stop to ask questions first."
          : `Creating the Expo project failed:\n${outcome.content.slice(0, 1500)}\n\nDon't write the project by hand. Tell the user what is needed (network access and approval to run \`npx create-expo-app@latest\`) and stop.`;
        messages.push({ role: "user", content: note });
        record("tool", note);
      }
    }

    // 2. Work.
    while (turns < maxTurns) {
      if (options.signal?.aborted) return finish("aborted", "Stopped by the user.");
      turns++;
      emit({ type: "thinking" });
      const forced = buildWithKit ? "design_kit" : startWithAppKit ? "app_kit" : undefined;
      const kitOnly = !!forced && kitTurns < 3 && !succeeded.has(forced);
      if (kitOnly) kitTurns++;
      if (kitOnly && kitTurns === 1 && forced === "design_kit") {
        const note = "Build the page now with design_kit: decide the content (a name if none was given, the search phrase, headline, the offer, the story, how it works, questions and answers, contact details) and call it. Everything the user asked for must be in it. Don't write HTML or CSS yourself.";
        messages.push({ role: "user", content: note });
        record("tool", note);
      }
      trimOldOutput(messages);
      let res: ChatResponse;
      try {
        res = await model.complete({
          messages,
          tools: kitOnly ? specs.filter((t) => t.name === forced) : specs,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onEvent ? { onProgress: (p) => emit(progressEvent(p)) } : {}),
        });
      } catch (e) {
        // The model server couldn't read the model's own tool call (cut-off or badly quoted
        // arguments). That is one bad reply, not a failed task: ask for it again.
        if (!(e instanceof ModelError) || !/tool call|parse|json|unterminated|unexpected/i.test(e.message) || modelRetries >= 2 || options.signal?.aborted) throw e;
        modelRetries++;
        if (kitOnly) kitTurns--;
        const note = "Your last reply couldn't be read: its tool call was malformed. Send the call again, with every string value quoted and its quotes and line breaks escaped.";
        messages.push({ role: "user", content: note });
        record("tool", note);
        continue;
      }
      // A reply that is one line or phrase over and over: the model fell into a repetition loop
      // (it happens to this family at long contexts). Don't keep it in the conversation; ask again.
      if (res.toolCalls.length === 0 && isRepetitive(res.content) && degenerateRetries < 2) {
        degenerateRetries++;
        const note = "Your last reply repeated itself and was thrown away. Answer again, briefly, without repeating lines.";
        messages.push({ role: "user", content: note });
        record("tool", note);
        continue;
      }
      const parsed = res.toolCalls.map((c) => parseCall(c));
      messages.push({ role: "assistant", content: res.content, ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}) });
      const stored = record(
        "assistant",
        res.content,
        parsed.map((p) => ({ name: p.call.name || "invalid", args: "args" in p ? p.args : p.call.arguments })),
        res.usage?.completionTokens,
      );
      if (res.content) emit({ type: "assistant", content: res.content });

      // 2a'. No tool calls but no answer either: an empty reply, or the plan written out again
      // (models copy the "Plan: …" format from earlier turns). Ask once to carry it out.
      // Or only an announcement of the next step ("Let me check the code.") with nothing done.
      // Or just a tool's name ("Search", "read_file"): a call that came out as text, not an answer.
      // Or a question or an explanation while a kit is the only tool on offer: the model stopped to
      // ask for something the kit fills in itself (seen live: the run ended on "what bundle identifier?").
      const fragment = isToolName(res.content, tools);
      const asked = kitOnly && !edited && res.toolCalls.length === 0 && !!res.content.trim();
      const stall = res.toolCalls.length > 0 ? undefined : asked ? `asked:${forced}` : !res.content.trim() ? "empty" : fragment ? "fragment" : isPlanEcho(res.content) ? "echo" : isAnnouncement(res.content) ? "announcement" : undefined;
      if (stall && !actNudges.has(stall)) {
        actNudges.add(stall);
        const nudge = asked
          ? `Don't stop to ask or explain: call ${forced} now with what the user has told you. Leave out anything optional you don't know; the tool fills in a placeholder and reports it, and you pass that on in your answer.`
          : !res.content.trim()
          ? "Your reply was empty. Use the tools to do the task, then give your answer."
          : fragment
            ? "That isn't an answer yet. Use the tools if you need them, then answer in full."
          : isPlanEcho(res.content) && plan
            ? "That restates the plan. Don't write it again: carry out its first step now with the tools, then give your answer."
            : "You said what you'd do next but stopped. Do it now with the tools, then give your answer.";
        messages.push({ role: "user", content: nudge });
        record("tool", nudge);
        continue;
      }

      // 2a. No tool calls: the model thinks it is done. Checks decide.
      if (res.toolCalls.length === 0) {
        if (!edited || checks.length === 0 || greenSinceLastEdit) {
          if ((await sentBackByLook()) || (await sentBackByReview()) || sentBackForAnswer(res.content)) continue;
          return finish("done", res.content);
        }
        emit({ type: "tool_start", name: "run_checks", args: {} });
        const runs = await runChecks(ctx);
        recordChecks(runs);
        lastChecks = runs;
        const passed = allChecksPassed(runs);
        emit({ type: "checks", runs, passed });
        if (passed) {
          greenSinceLastEdit = true;
          if ((await sentBackByLook()) || (await sentBackByReview()) || sentBackForAnswer(res.content)) continue;
          return finish("done", res.content);
        }
        if (options.allowFailingChecks) return finish("done_with_failing_checks", res.content);
        if (++checkRounds > maxCheckRounds) {
          return finish("checks_failed", `Checks still fail after ${maxCheckRounds} attempts.\n\n${describeChecks(runs)}`);
        }
        const seen = await recallFor(runs.filter((r) => !r.declined && r.exitCode !== 0).map((r) => r.output).join("\n"));
        const nudge = `You can't finish yet: the project's checks fail.\n\n${describeChecks(runs)}${seen}\n\nFix the cause (not the checks), then run_checks again.`;
        messages.push({ role: "user", content: nudge });
        // A note from the loop, not from the user: kept out of what memory treats as the user's words.
        record("tool", nudge);
        continue;
      }

      // 2b'. The same calls with the same arguments as last turn, again: the model is going in circles.
      // The third time it is told so with the results; the fifth time the run stops instead of burning hours.
      const callsKey = res.toolCalls.map((c) => `${c.name}(${c.arguments})`).join("\n");
      sameCalls = callsKey && callsKey === lastCalls ? sameCalls + 1 : 0;
      lastCalls = callsKey;
      if (sameCalls >= 4) return finish("error", `Stopped: the model kept making the same call (${res.toolCalls[0]?.name}) with the same arguments and wasn't getting anywhere. Try rephrasing the request or breaking it into smaller steps.`);

      // 2b. Run the tool calls. Invalid ones go back to the model as errors.
      const anyInvalid = parsed.some((p) => "error" in p);
      invalidTurns = anyInvalid ? invalidTurns + 1 : 0;
      for (const [i, p] of parsed.entries()) {
        let outcome: ToolOutcome;
        if ("error" in p) outcome = { ok: false, content: p.error };
        else {
          emit({ type: "tool_start", name: p.call.name, args: p.args });
          try {
            outcome = await p.tool.run(p.args, ctx);
          } catch (err) {
            if (options.signal?.aborted) throw err;
            outcome = { ok: false, content: err instanceof WorkspaceError || err instanceof Error ? err.message : String(err) };
          }
        }
        if (outcome.edited) {
          edited = true;
          greenSinceLastEdit = false;
        }
        if (outcome.change && !originals.has(outcome.change.path)) originals.set(outcome.change.path, outcome.change.before);
        if (outcome.checkRuns) {
          lastChecks = outcome.checkRuns;
          const passed = allChecksPassed(outcome.checkRuns);
          if (passed) greenSinceLastEdit = true;
          emit({ type: "checks", runs: outcome.checkRuns, passed });
        }
        // History keeps the raw output; the model also sees what memory knows about a failure.
        const recordedOutput = outcome.output ?? outcome.content;
        const failing = outcome.checkRuns
          ? outcome.checkRuns.filter((r) => !r.declined && r.exitCode !== 0).map((r) => r.output).join("\n")
          : outcome.exitCode !== undefined && outcome.exitCode > 0
            ? (outcome.output ?? outcome.content)
            : "";
        if (failing) outcome = { ...outcome, content: `${outcome.content}${await recallFor(failing)}` };
        messages.push({ role: "tool", toolCallId: p.call.id, content: outcome.content });
        if (outcome.images?.length) {
          // Tool messages can't carry images on most servers, so show them in a user turn.
          messages.push({
            role: "user",
            content: [{ type: "text", text: `Image${outcome.images.length > 1 ? "s" : ""} from ${p.call.name}:` }, ...outcome.images],
          });
          pruneImages(messages, options.keepImages ?? 3, taskIndex);
        }
        const id = stored?.[i];
        if (id) {
          history!.recorder.completeToolCall(id, {
            ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : { exitCode: outcome.ok ? 0 : 1 }),
            output: recordedOutput,
            ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
          });
        }
        if (outcome.ok && "args" in p) succeeded.add(p.call.name);
        // The app kit names the packages its files import. They are installed here, with Expo's
        // installer, so versions match the SDK: the model reaches for pnpm or plain npm instead.
        const install = outcome.ok && p.call.name === "app_kit" ? /`(npx expo install [^`]+)`/.exec(outcome.content)?.[1] : undefined;
        const runner = install ? tools.find((t) => t.name === "run_command") : undefined;
        if (install && runner) {
          const installArgs = { command: install, timeoutSeconds: 900 };
          emit({ type: "tool_start", name: "run_command", args: installArgs });
          const installed = await runner.run(installArgs, ctx);
          const installIds = record("tool", "Installing the packages the architecture uses", [{ name: "run_command", args: installArgs }]);
          if (installIds?.[0]) history!.recorder.completeToolCall(installIds[0], { exitCode: installed.exitCode ?? (installed.ok ? 0 : 1), output: installed.output ?? installed.content, ...(installed.durationMs !== undefined ? { durationMs: installed.durationMs } : {}) });
          emit({ type: "tool", name: "run_command", args: installArgs, ok: installed.ok, summary: installed.content.split("\n")[0]! });
          const note = installed.ok
            ? `The packages are installed (\`${install}\` ran). Skip that step. Add packages only with \`npx expo install <package>\`, never npm, yarn or pnpm add.`
            : `Installing the packages failed:\n${installed.content.slice(0, 1200)}\n\nFix the cause and run \`${install}\` again; don't use npm, yarn or pnpm add.`;
          messages.push({ role: "user", content: note });
          record("tool", note);
        }
        emit({
          type: "tool",
          name: p.call.name,
          args: "args" in p ? p.args : p.call.arguments,
          ok: outcome.ok,
          summary: outcome.content.split("\n")[0]!,
          ...(outcome.files?.length ? { files: outcome.files } : {}),
          ...(outcome.images?.length ? { images: outcome.images } : {}),
        });
      }
      if (invalidTurns >= maxInvalid) {
        return finish("error", `Stopped: the model sent invalid tool calls ${invalidTurns} turns in a row.`);
      }
      if (sameCalls === 2) {
        const note = "That is the third time in a row you made exactly the same call, and its result hasn't changed. Don't repeat it: use what you already have, try a different approach, or give your answer and say what is blocking you.";
        messages.push({ role: "user", content: note });
        record("tool", note);
      }
    }
    return finish("max_turns", `Stopped after ${maxTurns} turns without finishing.`);
  } catch (err) {
    if (options.signal?.aborted) return finish("aborted", "Stopped by the user.");
    return finish("error", err instanceof Error ? err.message : String(err));
  }

  // -- helpers ----------------------------------------------------------------

  /** Files changed but the answer is only "Done.": the user is owed what was built. Once per run. */
  function sentBackForAnswer(content: string): boolean {
    if (askedForAnswer || originals.size === 0 || !EMPTY_ANSWER.test(content.trim())) return false;
    askedForAnswer = true;
    const nudge = "Give your final answer now, without tools: what you built or changed, the files, how to open or run it, and anything left in [square brackets] for the user to fill in.";
    messages.push({ role: "user", content: nudge });
    record("tool", nudge);
    return true;
  }

  /**
   * Before finishing a run that built or changed a web page: show the agent what it looks like.
   * Code review can't see a wrapped label or an empty hero; a screenshot can. Once per run.
   */
  async function sentBackByLook(): Promise<boolean> {
    if (looked || !options.lookAt) return false;
    const pages = [...originals.keys()].filter((p) => /\.html?$/i.test(p));
    // The page the others belong to: index.html when there is one, else the first changed.
    const page = pages.find((p) => /(^|\/)index\.html?$/i.test(p)) ?? pages[0] ?? pageFor([...originals.keys()]);
    if (!page) return false;
    looked = true;
    emit({ type: "tool_start", name: "look_at_page", args: { path: page } });
    const started = Date.now();
    let look: PageLook | undefined;
    try {
      look = await options.lookAt(page, options.signal);
    } catch {
      look = undefined; // a failed preview never fails the task
    }
    if (options.signal?.aborted || !look || look.shots.length === 0) return false;
    const findings = look.findings.length ? `A browser also measured:\n${look.findings.map((f) => `- ${f}`).join("\n")}` : "A browser measured no problems.";
    const text = `This is ${page} as it renders, top to bottom: ${look.shots.map((x) => x.label).join("; ")}.\n${findings}\n\nLook at the screenshots the way the user will, then the way a designer would. Compare them with the brief${plan?.brief ? "'s requirements and done-when checks" : ""}: broken or overlapping layout, text that wraps badly or is cut off, large empty areas, anything that looks unfinished; and the design: is there one clear headline and action, do the sections differ from each other, is anything centred or decorated that shouldn't be. Fix what you find with small edits: make each fix with a tool call in this turn, don't describe it. Then give your final answer: what you built, what you checked, and what the user still has to fill in.`;
    messages.push({ role: "user", content: [{ type: "text", text }, ...look.shots.map((x) => x.image)] });
    const summary = `Looked at ${page} (${look.shots.map((x) => x.label).join("; ")}).\n${findings}`;
    const ids = record("tool", "Looking at the result", [{ name: "look_at_page", args: { path: page } }]);
    if (ids?.[0]) history!.recorder.completeToolCall(ids[0], { exitCode: look.findings.length ? 1 : 0, output: summary, durationMs: Date.now() - started });
    emit({ type: "tool", name: "look_at_page", args: { path: page }, ok: look.findings.length === 0, summary: summary.split("\n")[0]! });
    return true;
  }

  /** A stylesheet or script changed, not the page: the page next to it, if there is one. */
  function pageFor(changed: string[]): string | undefined {
    for (const path of changed) {
      if (!/\.(css|js|mjs)$/i.test(path)) continue;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      for (const candidate of [`${dir}index.html`, "index.html"]) {
        try {
          workspace.readText(candidate);
          return candidate;
        } catch {
          // not there
        }
      }
    }
    return undefined;
  }

  /**
   * Before finishing a run that changed files: one fresh-context review of the task, the diff
   * and the checks. True when it found something to fix and the agent was sent back to it.
   */
  async function sentBackByReview(): Promise<boolean> {
    if (reviewed || options.review === false || originals.size === 0) return false;
    reviewed = true;
    const diff = [...originals]
      .map(([path, before]) => {
        let after: string | null = null;
        try {
          after = workspace.readText(path);
        } catch {
          after = null; // deleted (or unreadable)
        }
        return unifiedDiff(path, before, after);
      })
      .join("\n");
    if (!diff.trim()) return false;
    const files = [...originals.keys()];
    emit({ type: "tool_start", name: "self_review", args: { files } });
    const started = Date.now();
    // The reviewer checks the change against the brief's definition of done, not only the user's sentence.
    const done = plan?.brief?.acceptance.length ? `\n\nDone when:\n${plan.brief.acceptance.map((a) => `- ${a}`).join("\n")}` : "";
    const issues = await reviewChange(options.reviewModel ?? model, { task: textOf(options.task) + done, diff, checks: lastChecks ? describeChecks(lastChecks) : "" }, options.signal);
    const must = (issues ?? []).filter((i) => i.severity === "must_fix");
    const summary =
      issues === undefined
        ? "Review unavailable (the reviewer didn't answer in the expected format)."
        : issues.length === 0
          ? "No problems found."
          : issues.map((i) => `${i.severity === "must_fix" ? "Must fix" : "Suggestion"}: ${formatIssue(i)}`).join("\n");
    const ids = record("tool", "Review before finishing", [{ name: "self_review", args: { files } }]);
    if (ids?.[0]) history!.recorder.completeToolCall(ids[0], { exitCode: must.length ? 1 : 0, output: summary, durationMs: Date.now() - started });
    emit({ type: "review", issues: issues ?? [] });
    emit({ type: "tool", name: "self_review", args: { files }, ok: must.length === 0, summary: summary.split("\n")[0]! });
    if (!must.length) return false;
    const nudge = reviewNudge(issues!);
    messages.push({ role: "user", content: nudge });
    return true;
  }

  async function recallFor(errorOutput: string): Promise<string> {
    if (!options.recall || !errorOutput.trim()) return "";
    try {
      const text = await options.recall(errorOutput);
      return text ? `\n\nSeen this error before (from memory; check it applies here):\n${text}` : "";
    } catch {
      return "";
    }
  }



  function record(
    role: "user" | "assistant" | "tool",
    content: string,
    toolCalls?: { name: string; args?: unknown; command?: string }[],
    tokens?: number,
  ): string[] | undefined {
    if (!history) return undefined;
    const m = history.recorder.appendMessage(history.sessionId, {
      role,
      content,
      ...(role === "assistant" ? { model: model.id } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(toolCalls?.length ? { toolCalls } : {}),
    });
    return m.toolCalls.map((c) => c.id);
  }

  /** Checks the loop runs itself are history too: fail-to-pass detection (Phase 4) reads them. */
  function recordChecks(runs: CheckRun[]) {
    if (!history) return;
    const ids = record(
      "tool",
      "Checks before finishing",
      runs.map((r) => ({ name: "check", command: r.check.command })),
    );
    runs.forEach((r, i) => {
      const id = ids?.[i];
      if (id) history.recorder.completeToolCall(id, { exitCode: r.exitCode, output: r.output, durationMs: r.durationMs });
    });
  }

  function parseCall(call: ToolCallRequest): ParsedCall {
    const tool = byName.get(call.name);
    if (!tool) return { call, error: `Unknown tool "${call.name}". Available: ${[...byName.keys()].join(", ")}.` };
    let raw: unknown;
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      return { call, error: `Arguments for ${call.name} are not valid JSON. Send one JSON object matching the tool's schema.` };
    }
    const result = tool.schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { call, error: `Invalid arguments for ${call.name}: ${issues}` };
    }
    return { call, tool, args: result.data };
  }

  async function makePlan(): Promise<Plan | undefined> {
    const files = await workspace.listFiles(300);
    // The model is asked for the brief every time (servers that enforce the schema require it);
    // a plan that comes back without one is still accepted.
    const schema = z.toJSONSchema(Plan.required({ brief: true, title: true }), { io: "input" }) as Record<string, unknown>;
    // Standards for this kind of work and project, so a loose request is planned against real requirements.
    const standards = renderPlaybooks(pickPlaybooks(textOf(options.task), files));
    const planMessages: ChatMessage[] = [...messages, { role: "user", content: planPrompt(files, standards, (options.standards ?? "").trim().slice(0, 6000), tools.some((t) => t.name === "web_search")) }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await model.complete({
        messages: planMessages,
        jsonSchema: { name: "plan", schema },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      try {
        const parsed = Plan.safeParse(JSON.parse(stripFences(res.content)));
        if (parsed.success) return parsed.data;
        planMessages.push({ role: "assistant", content: res.content });
        planMessages.push({ role: "user", content: `That plan doesn't match the schema: ${parsed.error.issues[0]?.message}. Send the JSON again (1–7 steps).` });
      } catch {
        planMessages.push({ role: "assistant", content: res.content });
        planMessages.push({ role: "user", content: "Send only the plan as one JSON object." });
      }
    }
    return undefined; // work without a plan rather than fail the task
  }
}

/** What to show while a reply is generated: the file being written and how far it has got. */
export function progressEvent(p: import("./model.js").ModelProgress): Extract<AgentEvent, { type: "progress" }> {
  if (!p.tool) return { type: "progress", chars: p.chars };
  const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(p.tool.arguments)?.[1];
  // Lines so far in the content being written: escaped newlines in the partial JSON string.
  const body = /"(?:content|new)"\s*:\s*"/.exec(p.tool.arguments);
  const lines = body ? (p.tool.arguments.slice(body.index).match(/\\n/g)?.length ?? 0) + 1 : undefined;
  return { type: "progress", chars: p.chars, tool: p.tool.name, ...(path ? { path } : {}), ...(lines ? { lines } : {}) };
}

/** A final answer that says nothing about the work. */
const EMPTY_ANSWER = /^(all )?(done|finished|complete|completed|ok|okay|ready)[.!]*$/i;

/** A reply that is a plan in the loop's own format ("Plan: …" and numbered steps), not an answer. */
export function isPlanEcho(content: string): boolean {
  const text = content.trim();
  return /^(\*\*)?plan:?(\*\*)?\s/i.test(text) && /^\s*1\.\s/m.test(text) && text.split("\n").every((l) => !l.trim() || /^(\*\*)?plan:?|^\s*\d+\.\s|^brief$|^(goal|deliver|must|done when|not doing|assuming): /i.test(l.trim()));
}

/**
 * A short reply that only says what the model is about to do ("Let me check the code.",
 * "I'll run the tests first.") — the step it announced never happened.
 */
export function isAnnouncement(content: string): boolean {
  const text = content.trim();
  if (!text || text.includes("```")) return false;
  const sentences = text.split(/(?<=[.!:])\s+/).filter((x) => x.trim());
  // The closing sentence: the last one on the last line.
  const lastLine = text.split("\n").filter((l) => l.trim()).at(-1)!;
  const last = lastLine.split(/(?<=[.!:])\s+/).filter((x) => x.trim()).at(-1)!.trim().replace(/^[-*\d.\s]+/, "");
  // A long reply counts only when it closes on the promise ("…Let me fix these two issues.").
  if (text.length > 400 || sentences.length > 3) return /^(now,? )?(let me|i'll|i will|i'm going to)\s+(fix|update|change|add|remove|edit|correct|apply|make|do)\b[^.]{0,80}\.?$/i.test(last);
  if (/\blet me know\b/i.test(last)) return false;
  return /^(now,? |first,? |next,? |ok(ay)?,? |good[.,]? )?(let me|let's|i'll|i will|i'm going to|i am going to)\s+\w+/i.test(last) || /^(sada|prvo|zatim|onda)\s+ću\b/i.test(last);
}

/** A reply that is only a tool's name or its first word ("Search", "read_file", "Edit."). */
export function isToolName(content: string, tools: readonly { name: string }[]): boolean {
  const word = content.trim().replace(/[.:!`*]+/g, "").trim().toLowerCase();
  if (!word) return false;
  return tools.some((t) => word === t.name || word === t.name.replace(/_/g, " ") || word === t.name.split("_")[0]);
}

const BRIEF_LABELS = [
  ["deliverables", "Deliver"],
  ["requirements", "Must"],
  ["acceptance", "Done when"],
  ["outOfScope", "Not doing"],
  ["assumptions", "Assuming"],
] as const;

/** "Plan: …" and numbered steps, then the brief as labelled lines (the app's transcript parses this). */
export function renderPlan(plan: Plan): string {
  const steps = `Plan: ${plan.summary}\n${plan.steps.map((s, i) => `${i + 1}. ${s.title}${s.files.length ? ` (${s.files.join(", ")})` : ""}`).join("\n")}`;
  const b = plan.brief;
  if (!b) return steps;
  const oneLine = (x: string) => x.replace(/\s*\n\s*/g, " ").trim();
  const lines = [`Goal: ${oneLine(b.goal)}`, ...BRIEF_LABELS.flatMap(([key, label]) => b[key].map((item) => `${label}: ${oneLine(item)}`))];
  return `${steps}\n\nBrief\n${lines.join("\n")}`;
}

function stripFences(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (m ? m[1]! : text).trim();
}

/** Tools that create or change files in the project. */
const WRITING_TOOLS = new Set(["create_file", "edit_file", "insert_lines", "design_kit", "app_kit", "find_photos", "generate_image"]);

/** The user said to answer without touching anything. */
export function isReadOnlyRequest(task: string): boolean {
  return /\b(question only|just a question|read[- ]only|(don'?t|do not|without) (chang|edit|modify|writ|creat|touch)\w* (anything|any files?|the code|files?)|samo pitanje|(ne|bez) (mijenja\w*|dira\w*) (ni[sš]ta|kod\w*|fajlov\w*))\b/i.test(task);
}

/** Past this much text in the conversation, old tool output is cut down. */
const MAX_CONTEXT_CHARS = 160_000;
const KEEP_RECENT_OUTPUTS = 8;

/**
 * Keeps the conversation from growing without bound: a local model gets slower and starts to
 * loop as its context fills. Old tool results (file reads, command output) are cut to their
 * first lines once the conversation is long; the most recent ones stay whole.
 */
export function trimOldOutput(messages: ChatMessage[], maxChars = MAX_CONTEXT_CHARS, keep = KEEP_RECENT_OUTPUTS): void {
  const size = (m: ChatMessage) => (typeof m.content === "string" ? m.content.length : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0));
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= maxChars) return;
  const outputs = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of outputs.slice(0, Math.max(0, outputs.length - keep))) {
    if (total <= maxChars) break;
    const m = messages[i] as { role: "tool"; toolCallId: string; content: string };
    if (m.content.length <= 600) continue;
    const cut = `${m.content.slice(0, 400)}\n… [${m.content.length - 400} more characters of this earlier result were dropped to save context; run the tool again if you need them]`;
    total -= m.content.length - cut.length;
    messages[i] = { ...m, content: cut };
  }
}

/** One line, or one short phrase, over and over: a repetition loop, not an answer. */
export function isRepetitive(content: string): boolean {
  const text = content.trim();
  if (text.length < 400) return false;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  if (lines.length >= 12) {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
    if (Math.max(...counts.values()) >= Math.max(8, lines.length * 0.5)) return true;
  }
  // The same 60 characters filling most of the tail.
  const tail = text.slice(-1200);
  const unit = tail.slice(-60);
  return tail.split(unit).length - 1 >= 8;
}

/** Keep only the last `keep` image-bearing user turns, so context doesn't grow without bound. */
function pruneImages(messages: ChatMessage[], keep: number, protect: number): void {
  const idx: number[] = [];
  messages.forEach((m, i) => {
    if (i <= protect) return;
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image")) idx.push(i);
  });
  for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
    const m = messages[i] as { role: "user"; content: ContentPart[] };
    const text = m.content.filter((p) => p.type === "text");
    messages[i] = { role: "user", content: [...text, { type: "text", text: "[earlier image removed to save context]" }] };
  }
}
