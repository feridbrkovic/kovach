import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatModel, type ChatRequest, createOpenAiCompatibleModel, type ModelProgress, progressEvent, isPlanEcho, pickPlaybooks, planPrompt, renderPlan, renderPlaybooks, runAgentTask, SYSTEM_PROMPT, Workspace, wantsNewApp, wantsNewPage } from "../src/index.js";
import { isOfficialSource, webSearch } from "../src/web.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-brief-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ids = (task: string, files: string[] = []) => pickPlaybooks(task, files).map((p) => p.id);

describe("standards for the kind of work", () => {
  it("picks one for the stack and one for the kind of change, from the task and the project's files", () => {
    expect(ids("create a simple landing page for a seo services company")).toEqual(["web-page", "seo"]);
    expect(ids("make a landing page for a bakery")).toEqual(["web-page", "feature"]);
    expect(ids("fix the sitemap, it fails to load")).toEqual(["bug-fix"]);
    expect(ids("The discount test fails, please fix it", ["functions.php", "readme.txt"])).toEqual(["wordpress", "bug-fix"]);
    expect(ids("Add a WooCommerce coupon note under the cart total")).toEqual(["wordpress", "feature"]);
    expect(ids("Refactor the cart store", ["src/App.tsx", "vite.config.ts"])).toEqual(["react", "refactor"]);
    expect(ids("add an endpoint for invoices", ["manage.py", "requirements.txt"])).toEqual(["node", "feature"]); // the task names it
    expect(ids("rename total to cartTotal", ["pyproject.toml"])).toEqual(["python", "refactor"]);
    // Mobile: the app's stack from the task or its files, and publishing as its own kind of work.
    expect(ids("Build a mobile app for booking barbers, for iOS and Android")).toEqual(["react-native", "feature"]);
    expect(ids("add a login screen", ["app.json", "package.json", "ios/Podfile"])).toEqual(["react-native", "feature"]);
    expect(ids("Publish the app to the App Store and Google Play", ["eas.json", "app.json"])).toEqual(["react-native", "mobile-release"]);
    expect(ids("fix the TestFlight upload error", ["eas.json"])).toEqual(["react-native", "mobile-release"]);
    expect(ids("Add a widget in SwiftUI", ["MyApp.xcodeproj/project.pbxproj"])).toEqual(["ios-native", "feature"]);
    expect(ids("add a settings screen", ["settings.gradle.kts", "app/src/main/AndroidManifest.xml"])).toEqual(["android-native", "feature"]);
    expect(ids("release the lock when the request fails", ["server.ts"])).toEqual(["node", "bug-fix"]);
    // A question gets none: nothing to build.
    expect(ids("What does this function return?")).toEqual([]);
  });

  it("starts a project only when the request is to build one", () => {
    // The loop runs Expo's generator or the page builder by itself for these, so questions and near-misses must not match.
    const app = ["Build a mobile app for booking barber appointments, for iOS and Android, called Brico", "napravi mobilnu aplikaciju za rezervacije", "Can you make me a simple iOS app for tracking water?", "Create an Expo app with tabs"];
    const page = ["Make a landing page for a neighbourhood bakery: a hero, three products, a contact form", "napravi landing stranicu za pekaru", "Can you make a landing page for my dentist office?", "I need a website for my SEO agency"];
    const neither = ["How do I build a mobile app?", "How do I publish an Expo app to the App Store?", "Write a blog post about our new mobile app", "Build a REST API for a mobile app backend in Node", "Create an app icon", "Review my mobile app's login flow", "Explain how a landing page should be structured", "What makes a good landing page?", "Add dark mode to the website", "Fix the footer on the home page"];
    for (const t of app) expect([wantsNewApp(t), wantsNewPage(t)], t).toEqual([true, false]);
    for (const t of page) expect([wantsNewApp(t), wantsNewPage(t)], t).toEqual([false, true]);
    for (const t of neither) expect([wantsNewApp(t), wantsNewPage(t)], t).toEqual([false, false]);
    // React Native questions get the React Native rules, not the web React ones; Bosnian requests are recognised.
    expect(ids("Why is my React Native app slow on Android?")).toEqual(["react-native"]);
    expect(ids("napravi mobilnu aplikaciju za rezervacije")).toEqual(["react-native", "feature"]);
    expect(ids("Add a React component for the cart")).toEqual(["react", "feature"]);
  });

  it("tells the planner how mobile apps are built and published", () => {
    const app = renderPlaybooks(pickPlaybooks("Publish the app to the App Store and Google Play", ["eas.json", "app.json"]));
    expect(app).toMatch(/^React Native \/ Expo app:\n- Know the project before changing it\./);
    for (const part of ["New Architecture", "expo-secure-store", "development build, not Expo Go", "npx expo-doctor"]) expect(app).toContain(part);
    expect(app).toContain("\n\nBuilding, signing and publishing a mobile app:\n- Find the release pipeline the project already has");
    for (const part of ["eas build --platform", "fastlane", "./gradlew bundleRelease", "API level 36", "Xcode 26", "say when you checked", "You prepare; the user publishes."]) expect(app).toContain(part);
    expect(renderPlaybooks(pickPlaybooks("Add a widget in SwiftUI", []))).toContain("PrivacyInfo.xcprivacy");
    expect(renderPlaybooks(pickPlaybooks("write a Jetpack Compose screen", []))).toContain("collectAsStateWithLifecycle");
  });

  it("gives the planner the rules, and nothing when no playbook applies", () => {
    const text = renderPlaybooks(pickPlaybooks("make a landing page", []));
    expect(text).toMatch(/^Static web page or landing page:\n- A new page or site is built with the design_kit tool/);
    expect(text).toContain("prefers-reduced-motion");
    expect(text).toContain("\n\nAdding a feature:\n- ");
    expect(planPrompt(["a.js"], text)).toContain("Standards for this kind of work:\nStatic web page");
    expect(planPrompt(["a.js"])).not.toContain("Standards for this kind of work");
  });
});

const BRIEF = {
  goal: "A landing page that gets visitors to book an SEO audit.",
  deliverables: ["index.html", "styles.css"],
  requirements: ["GSAP scroll animations, as asked", "One h1 and a meta description"],
  acceptance: ["index.html has exactly one h1", "Animations are off under prefers-reduced-motion"],
  outOfScope: [],
  assumptions: ["Files are created in this session's folder, not on the Desktop"],
};

describe("the brief", () => {
  it("is rendered under the plan, counts as a plan echo when repeated, and plans without one still work", () => {
    const plan = { brief: BRIEF, summary: "Build the page", steps: [{ title: "Write index.html", files: ["index.html"] }] };
    const text = renderPlan(plan);
    expect(text).toBe(
      [
        "Plan: Build the page",
        "1. Write index.html (index.html)",
        "",
        "Brief",
        "Goal: A landing page that gets visitors to book an SEO audit.",
        "Deliver: index.html",
        "Deliver: styles.css",
        "Must: GSAP scroll animations, as asked",
        "Must: One h1 and a meta description",
        "Done when: index.html has exactly one h1",
        "Done when: Animations are off under prefers-reduced-motion",
        "Assuming: Files are created in this session's folder, not on the Desktop",
      ].join("\n"),
    );
    expect(isPlanEcho(text)).toBe(true);
    expect(renderPlan({ summary: "Fix it", steps: [{ title: "Edit", files: [] }] })).toBe("Plan: Fix it\n1. Edit");
  });

  it("plans against the standards, keeps the brief in the conversation, and reviews against its definition of done", async () => {
    mkdirSync(join(dir, "site"), { recursive: true });
    writeFileSync(join(dir, "site/notes.txt"), "x\n");
    const requests: ChatRequest[] = [];
    const replies = [
      { content: JSON.stringify({ brief: BRIEF, summary: "Build the page", steps: [{ title: "Write index.html", files: ["index.html"] }] }), toolCalls: [] },
      { content: "", toolCalls: [{ id: "c1", name: "create_file", arguments: JSON.stringify({ path: "index.html", content: "<h1>SEO</h1>\n" }) }] },
      { content: "Created index.html.", toolCalls: [] },
    ];
    const model: ChatModel = {
      id: "test",
      complete: async (req) => {
        requests.push(structuredClone(req));
        return replies.shift()!;
      },
    };
    const reviews: ChatRequest[] = [];
    const reviewer: ChatModel = {
      id: "reviewer",
      complete: async (req) => {
        reviews.push(req);
        return { content: '{"issues": []}', toolCalls: [] };
      },
    };
    const outcome = await runAgentTask({ model, reviewModel: reviewer, workspace: new Workspace(dir), task: "create a landing page for a seo services company", approve: async () => true, checks: [] });
    expect(outcome).toMatchObject({ status: "done", plan: { brief: { goal: BRIEF.goal } } });

    // The planning turn asked for a brief and carried the web-page standards.
    const planning = String(requests[0]!.messages.at(-1)!.content);
    expect(planning).toMatch(/^Before working, turn the task above into a brief and a plan\./);
    expect(planning).toContain("Standards for this kind of work:\nStatic web page or landing page:");
    expect(JSON.stringify(requests[0]!.jsonSchema)).toContain('"acceptance"');
    expect((requests[0]!.jsonSchema!.schema as { required: string[] }).required).toEqual(expect.arrayContaining(["brief", "summary", "steps"]));
    // The work turns see the brief.
    expect(String(requests[1]!.messages.at(-2)!.content)).toContain("Done when: index.html has exactly one h1");
    // A new page starts with the page builder: the plan says so, and only that tool is offered until the page exists.
    expect(outcome.plan!.steps.map((x) => x.title)).toEqual(["Write the page's content and build the page with design_kit", "Look at the page and adjust wording, pictures and details"]);
    expect(String(requests[1]!.messages.at(-1)!.content)).toMatch(/^Build the page now with design_kit/);
    expect(requests[1]!.tools!.map((t) => t.name)).toEqual(["design_kit"]);
    // The reviewer is told what done means.
    expect(String(reviews[0]!.messages[1]!.content)).toMatch(
      /^Task:\ncreate a landing page for a seo services company\n\nDone when:\n- index\.html has exactly one h1\n- Animations are off under prefers-reduced-motion\n\nDiff:/,
    );
  });
});

describe("where knowledge comes from", () => {
  it("tells the agent the order of its sources, only for the ones it has", () => {
    const all = SYSTEM_PROMPT([], { memory: true, web: true });
    expect(all).toMatch(/Where to look, in this order: \(1\) the project's own code and config .*; \(2\) what the user decided: <memory> notes and search_memory; \(3\) search_docs: .*; \(4\) web_search and fetch_page, when the sources above don't answer it/);
    expect(all).toContain("When two sources disagree, the earlier one wins for how this project works, and you say so.");
    const webOnly = SYSTEM_PROMPT([], { web: true });
    expect(webOnly).toMatch(/\(2\) web_search and fetch_page/);
    expect(webOnly).not.toContain("search_docs");
    expect(SYSTEM_PROMPT([], {})).not.toContain("Where to look");
  });

  it("puts official sources first in web results, keeping the engine's order otherwise", async () => {
    expect(["https://developer.wordpress.org/plugins/hooks/", "https://www.php.net/manual/en/function.intdiv.php", "https://react.dev/learn"].map(isOfficialSource)).toEqual([true, true, true]);
    expect(["https://medium.com/@x/hooks", "https://notphp.net/x", "not a url"].map(isOfficialSource)).toEqual([false, false, false]);
    const fetch = (async () =>
      new Response(JSON.stringify({ results: [{ title: "Blog", url: "https://blog.example.com/a" }, { title: "Forum", url: "https://forum.example.com/b" }, { title: "MDN", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/clamp" }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    const results = await webSearch("css clamp", { searxngUrl: "http://127.0.0.1:8888", fetch });
    expect(results.map((r) => r.title)).toEqual(["MDN", "Blog", "Forum"]);
  });

  it("puts the user's own standards before the built-in ones in the planning turn", async () => {
    const requests: ChatRequest[] = [];
    const model: ChatModel = {
      id: "test",
      complete: async (req) => {
        requests.push(req);
        return { content: requests.length === 1 ? JSON.stringify({ summary: "Answer", steps: [{ title: "Answer", files: [] }] }) : "Done: nothing to change.", toolCalls: [] };
      },
    };
    await runAgentTask({ model, workspace: new Workspace(dir), task: "make a landing page", approve: async () => true, checks: [], standards: "- No jQuery\n- Mobile first" });
    const planning = String(requests[0]!.messages.at(-1)!.content);
    const own = planning.indexOf("The user's own standards (these come first; follow them where they apply):\n- No jQuery\n- Mobile first");
    expect(own).toBeGreaterThan(0);
    expect(planning.indexOf("Standards for this kind of work:")).toBeGreaterThan(own);
  });
});

describe("seeing the result", () => {
  const shot = { label: "Phone, 390 px wide", image: { type: "image" as const, mediaType: "image/jpeg" as const, data: "AAAA" } };

  it("shows the agent the page it built once before finishing, with what the browser measured", async () => {
    const requests: ChatRequest[] = [];
    const replies = [
      { content: "", toolCalls: [{ id: "c1", name: "create_file", arguments: JSON.stringify({ path: "index.html", content: "<h1>SEO</h1>\n" }) }] },
      { content: "Built the page.", toolCalls: [] },
      { content: "", toolCalls: [{ id: "c2", name: "edit_file", arguments: JSON.stringify({ path: "index.html", edits: [{ old: "<h1>SEO</h1>", new: "<h1>SEO audits</h1>" }] }) }] },
      { content: "Fixed the heading; the page looks right at both widths.", toolCalls: [] },
    ];
    const model: ChatModel = { id: "t", complete: async (req) => (requests.push(structuredClone({ ...req, onProgress: undefined })), replies.shift()!) };
    const looks: string[] = [];
    const events: string[] = [];
    const outcome = await runAgentTask({
      model,
      workspace: new Workspace(dir),
      task: "make a landing page",
      approve: async () => true,
      checks: [],
      plan: false,
      review: false,
      lookAt: async (page) => (looks.push(page), { shots: [shot], findings: ["Horizontal scroll at 390 px: the page is 520 px wide"] }),
      onEvent: (e) => void (e.type === "tool" && events.push(`${e.name}:${e.ok}`)),
    });
    expect(outcome).toMatchObject({ status: "done", message: "Fixed the heading; the page looks right at both widths." });
    expect(looks).toEqual(["index.html"]); // once, although it edited again afterwards
    const seen = requests[2]!.messages.at(-1)!;
    expect(seen.role).toBe("user");
    const parts = seen.content as { type: string; text?: string }[];
    expect(parts[0]!.text).toMatch(/^This is index\.html as it renders, top to bottom: Phone, 390 px wide\.\nA browser also measured:\n- Horizontal scroll at 390 px: the page is 520 px wide\n\nLook at the screenshots the way the user will, then the way a designer would\./);
    expect(parts[1]).toMatchObject({ type: "image", data: "AAAA" });
    expect(events).toContain("look_at_page:false");
  });

  it("looks at the page a changed stylesheet belongs to, and not at all for other work or when the preview fails", async () => {
    writeFileSync(join(dir, "index.html"), "<link rel=stylesheet href=styles.css>\n");
    writeFileSync(join(dir, "styles.css"), "h1 { color: red; }\n");
    const run = async (call: { name: string; arguments: string }, lookAt: Parameters<typeof runAgentTask>[0]["lookAt"]) => {
      const replies = [{ content: "", toolCalls: [{ id: "c1", ...call }] }, { content: "Done with it.", toolCalls: [] }, { content: "Looks right.", toolCalls: [] }];
      const model: ChatModel = { id: "t", complete: async () => replies.shift()! };
      return runAgentTask({ model, workspace: new Workspace(dir), task: "t", approve: async () => true, checks: [], plan: false, review: false, lookAt });
    };
    const looks: string[] = [];
    const css = { name: "edit_file", arguments: JSON.stringify({ path: "styles.css", edits: [{ old: "red", new: "blue" }] }) };
    expect(await run(css, async (p) => (looks.push(p), { shots: [shot], findings: [] }))).toMatchObject({ message: "Looks right." });
    expect(looks).toEqual(["index.html"]);
    const note = { name: "create_file", arguments: JSON.stringify({ path: "notes.md", content: "x\n" }) };
    expect(await run(note, async (p) => (looks.push(p), { shots: [shot], findings: [] }))).toMatchObject({ message: "Done with it." });
    expect(looks).toEqual(["index.html"]);
    const failing = { name: "edit_file", arguments: JSON.stringify({ path: "styles.css", edits: [{ old: "blue", new: "green" }] }) };
    expect(await run(failing, async () => Promise.reject(new Error("no browser")))).toMatchObject({ status: "done", message: "Done with it." });
  });

  it("reports which file is being written and how many lines, from a partial tool call", () => {
    expect(progressEvent({ chars: 40, tool: { name: "create_file", arguments: '{"path":"styles.css","content":":root {\\n  --a: 1;\\n  --b' } })).toEqual({
      type: "progress",
      chars: 40,
      tool: "create_file",
      path: "styles.css",
      lines: 3,
    });
    expect(progressEvent({ chars: 12 })).toEqual({ type: "progress", chars: 12 });
    expect(progressEvent({ chars: 9, tool: { name: "search", arguments: '{"patt' } })).toEqual({ type: "progress", chars: 9, tool: "search" });
  });

  it("reads a streamed reply into the same result as a plain one, reporting progress", async () => {
    const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const text = sse([
      { choices: [{ delta: { content: "Writing " } }] },
      { choices: [{ delta: { content: "it." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "create_file", arguments: '{"path":"a.txt",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"x\\ny"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } },
    ]);
    // Split mid-line, as a network would.
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 57));
        c.enqueue(bytes.slice(57));
        c.close();
      },
    });
    let sent: Record<string, unknown> = {};
    const fetch = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    const model = createOpenAiCompatibleModel({ baseUrl: "http://m/v1", model: "q", fetch });
    const seen: ModelProgress[] = [];
    const res = await model.complete({ messages: [{ role: "user", content: "go" }], onProgress: (p) => seen.push(p) });
    expect(sent.stream).toBe(true);
    expect(res).toEqual({
      content: "Writing it.",
      toolCalls: [{ id: "call_a", name: "create_file", arguments: '{"path":"a.txt","content":"x\\ny"}' }],
      finishReason: "tool_calls",
      usage: { promptTokens: 10, completionTokens: 7 },
    });
    expect(seen.at(-1)).toEqual({ chars: 44, tool: { name: "create_file", arguments: '{"path":"a.txt","content":"x\\ny"}' } });

    // A server that ignores "stream" and answers with plain JSON still works.
    const plain = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Hi." } }] }), { headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
    expect(await createOpenAiCompatibleModel({ baseUrl: "http://m/v1", model: "q", fetch: plain }).complete({ messages: [], onProgress: () => undefined })).toEqual({ content: "Hi.", toolCalls: [] });
  });
});
