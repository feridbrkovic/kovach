# Model notes: Qwen3.6-35B-A3B (4-bit, oMLX)

What this model gets wrong when it drives the agent, and what the code does about each. The rule behind all of it: **advice in a prompt is a suggestion to this model; code is not.** Anything that must happen is enforced in the loop or done by a tool.

| Failure seen | Safeguard | Where |
|---|---|---|
| Ignores rules given in long prompts or tool results (wrote 3 sections when told 9, skipped the photo tool) | The work is done by a tool from structured data; the tool is the only one offered until its output exists | `page-builder.ts`, `loop.ts` (`buildWithKit`) |
| Plans a different approach each run | Plan steps are replaced for known kinds of work | `loop.ts` |
| Tool call the server can't parse ("unrecoverable tool call"), usually with large arguments | The turn is asked for again, up to twice | `loop.ts` (`ModelError` retry) |
| Says what it will do and stops ("Let me fix these two issues.") | Sent back once per kind: empty reply, plan echo, announcement, bare tool name | `loop.ts` (`isAnnouncement`, `isPlanEcho`, `isToolName`) |
| Finishes with "Done." | Asked once for a real summary | `loop.ts` (`sentBackForAnswer`) |
| Tool markup or reasoning leaks into the answer (`</parameter>`, `<think>`) | Stripped from every reply | `model.ts` (`cleanContent`) |
| Repeats the same call with the same arguments | Told on the third time, stopped on the fifth | `loop.ts` (`sameCalls`) |
| Repetition loop in its text, more likely as context grows | The reply is discarded and asked for again; old tool output is trimmed past 160k characters | `loop.ts` (`isRepetitive`, `trimOldOutput`) |
| Server default sampling tuned for chat | Sends the model card's values for precise coding (temperature 0.6, top_p 0.95, top_k 20); drops `top_k` if a server refuses it | `model.ts` (`recommendedSampling`) |
| Invents facts: addresses, testimonials, "organic", "since 1990" | Schema fields say what goes in [brackets]; customer quotes are a placeholder unless the user supplied one; structured data never includes bracketed values | `page-builder.ts` |
| Invents paths (`C:\Users\…`) or claims to have written outside the workspace | Paths are checked; the prompt states the OS and where it can write | `workspace.ts`, `prompt.ts` |
| Rewrites a whole file to change a line, or thrashes when refused | Files it created this run can be replaced whole; others only edited | `tools.ts` |
| Chases a wrong measurement for minutes | Measurements are tested against real pages; the scroll check jumps instead of gliding | `page-findings.ts` |
| Writes stale library APIs from memory | Docs packs matched to the project's versions; the plan starts with a lookup when a library is named; the project's AGENTS.md is read | `memory-service/docs`, `prompt.ts`, playbooks |
| Hand-writes project scaffolding with old versions | New Expo apps are created with `create-expo-app`, then `app_kit` adds the architecture; packages go through `expo install` | `app-kit.ts`, playbooks |
| Stops to ask for a detail ("what bundle identifier?") while a kit is the forced step, which ended the run | The kit takes a placeholder for anything optional and reports it; a text reply at that point is sent back once with "call the tool now" | `app-kit.ts` (`placeholderBundleId`), `loop.ts` |
| Replaces the server calls with hard-coded data so an app "works" without a backend | The app kit ships sample data as its own part (`sample.ts`, shown in development until a real API address is set, marked "Sample data"); before finishing, the loop checks that each feature's `api.ts` still calls `request()` and sends the work back once if not | `app-kit.ts` (`kitFindings`), `loop.ts` (`sentBackByKit`) |
| Ends a run on an error line nothing returned (`API Error: 403 {"error":…}` after a failed edit) | A reply that is only an error line is not accepted as the answer; sent back once | `loop.ts` (`isErrorText`) |
| Reads every file of a kit it was just given, one by one | The kit's result lists the parts with their props | `app-kit.ts` (`PARTS`) |
| Spends turns filtering `tsc` output because a new Expo project never typechecks clean (the template's CSS imports and its unused web tab bar) | The app kit writes Expo's `expo-env.d.ts` and removes the tab bar it replaced, so `npx tsc --noEmit` exits 0 and the check means something | `app-kit.ts` |
| Runs out of steps on a new app and stops with nothing to show for it | Kit-built apps get a larger step budget; at the limit the model is asked once, without tools, where things stand, and the user can reply "continue" | `loop.ts` |
| Asked for a "modern design with icons, animations and photos", restyles screens by hand with uneven results | The app kit delivers them as parts: a look chosen from the kind of business, `Appear` and `Tilt` for motion, icons in headers and empty states, stock photos for the sample rows and a hero image on detail screens | `app-kit.ts` (`APP_LOOKS`, `motion.tsx`) |
| On a follow-up message, treats its own page or app from the previous message as someone else's: the page builder refuses to rebuild it, `create_file` refuses to replace it, and the model starts over (a new project, new searches) | Each run is told which files its session already made: everything in a scratch session's folder, the files it created in a project; those can be rebuilt and replaced like files made in this message | `loop.ts` (`madeEarlier`), `agent-service.ts` |
| Runs a project generator (`create-expo-app`, `npm create vite` …) inside a folder that already holds the project | `run_command` refuses such commands when a project file is present, before asking the user | `tools.ts` (`scaffoldsOverProject`) |
| Searches the web again and again with reworded queries | Six searches per task, and the same words twice are refused; the model is told to use what it found | `web.ts` (`MAX_SEARCHES`) |
| Answers the loop's own notes as if the user had scolded it ("You're absolutely right…") | Every loop note ends with a line saying it is an automatic check, not the user | `loop.ts` (`loopNote`) |
| Fails every check in a follow-up because the project's packages were removed (Free Up Space) | The loop reinstalls with the lockfile's package manager before the work starts | `loop.ts` (`reinstallCommand`) |
| Saves its answer to a file when asked a question and told not to change anything | File-writing tools are not offered for such requests | `loop.ts` (`isReadOnlyRequest`) |

## When adding a safeguard
1. Reproduce the failure in a live run and keep the transcript line that shows it.
2. Prefer, in order: a tool that does the work, a check in the loop, a measured finding sent back, a line in a prompt.
3. Add a test with a scripted model that fails the same way.
4. Add a row here.
