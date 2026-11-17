import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChatModel, iconFor, kitFiles, kitPackages, pickPlaybooks, placeholderBundleId, renderPlaybooks, runAgentTask, TOOLS, wireProviders, Workspace } from "../src/index.js";
import type { ToolContext } from "../src/tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-appkit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): ToolContext => ({ workspace: new Workspace(dir), approve: async () => true, checks: [], limits: { editLines: 150, newFileLines: 400, commandTimeoutMs: 1000 }, createdThisRun: new Set() });
const kit = TOOLS.find((t) => t.name === "app_kit")!;
const INPUT = { name: "Brico", bundleId: "ba.input.brico", auth: true, features: [{ name: "bookings", purpose: "Upcoming and past appointments." }, { name: "open-hours", purpose: "When each shop is open." }] };

/** What create-expo-app leaves behind, as far as the kit looks. */
function expoProject() {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ref", dependencies: { expo: "~58.0.25", "react-native-safe-area-context": "~5.11.1" } }));
  writeFileSync(join(dir, "app.json"), JSON.stringify({ expo: { name: "ref", slug: "ref", ios: { icon: "./assets/expo.icon" }, android: {} } }));
  mkdirSync(join(dir, "src/app"), { recursive: true });
  writeFileSync(join(dir, "src/app/_layout.tsx"), "export default function Layout() { return null; }\n");
}

describe("app kit", () => {
  it("asks for the project to be created with create-expo-app first", async () => {
    const out = await kit.run(kit.schema.parse(INPUT), ctx());
    expect(out.ok).toBe(false);
    expect(out.content).toContain("npx create-expo-app@latest . --template default");
    expect(existsSync(join(dir, "src"))).toBe(false);
  });

  it("adds the architecture to an Expo project and says what to install and wire", async () => {
    expoProject();
    const out = await kit.run(kit.schema.parse(INPUT), ctx());
    expect(out.ok).toBe(true);
    for (const file of ["src/lib/api.ts", "src/lib/env.ts", "src/lib/query.ts", "src/theme/tokens.ts", "src/components/ui/screen.tsx", "src/components/ui/button.tsx", "src/components/ui/card.tsx", "src/components/ui/list-item.tsx", "src/components/ui/avatar.tsx", "src/components/ui/badge.tsx", "src/components/ui/section-header.tsx", "src/providers/app-providers.tsx", "src/features/auth/session.ts", "src/features/bookings/api.ts", "src/features/bookings/use-bookings.ts", "src/features/bookings/bookings-screen.tsx", "src/features/open-hours/open-hours-screen.tsx", "docs/ARCHITECTURE.md", "eas.json", ".env.example"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    // Names derived from the feature: a schema, its type, a hook and a screen that agree with each other.
    const api = readFileSync(join(dir, "src/features/open-hours/api.ts"), "utf8");
    expect(api).toContain("export const openHoursItemSchema = z.object(");
    expect(api).toContain("export type OpenHoursItem = z.output<typeof openHoursItemSchema>;");
    expect(readFileSync(join(dir, "src/features/open-hours/use-open-hours.ts"), "utf8")).toContain("export function useOpenHours()");
    expect(readFileSync(join(dir, "src/features/open-hours/open-hours-screen.tsx"), "utf8")).toContain("export function OpenHoursScreen()");
    // Secrets go to secure storage; the store identity is set without dropping what was there.
    expect(readFileSync(join(dir, "src/features/auth/session.ts"), "utf8")).toContain('import * as SecureStore from "expo-secure-store";');
    const config = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as { expo: { name: string; ios: Record<string, string>; android: Record<string, string> } };
    expect(config.expo).toMatchObject({ name: "Brico", slug: "ref", ios: { icon: "./assets/expo.icon", bundleIdentifier: "ba.input.brico" }, android: { package: "ba.input.brico" } });
    expect(JSON.parse(readFileSync(join(dir, "eas.json"), "utf8"))).toMatchObject({ cli: { appVersionSource: "remote" }, build: { production: { autoIncrement: true } } });
    // Only what is missing gets installed, with expo install so versions match the SDK.
    expect(out.content).toContain("`npx expo install @tanstack/react-query zod @expo/vector-icons expo-image zustand expo-secure-store expo-splash-screen`");
    expect(out.content).toContain("In src/app/_layout.tsx, import { AppProviders }"); // this fixture's layout has no ThemeProvider
    expect(out.content).toContain("make its route file in src/app/ render the feature's screen component and nothing else");
    expect(out.content).toContain("npx expo-doctor");
  });

  it("sets up navigation itself on Expo's template: a tab and a route per feature, opening on the first", async () => {
    expoProject();
    writeFileSync(join(dir, "src/app/explore.tsx"), "export default function Explore() { return null; }\n");
    writeFileSync(
      join(dir, "src/app/_layout.tsx"),
      "import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';\nimport AppTabs from '@/components/app-tabs';\n\nexport default function TabLayout() {\n  return (\n    <ThemeProvider value={DefaultTheme}>\n      <AppTabs />\n    </ThemeProvider>\n  );\n}\n",
    );
    const out = await kit.run(kit.schema.parse(INPUT), ctx());
    const layout = readFileSync(join(dir, "src/app/_layout.tsx"), "utf8");
    // A stack: the tabs first, each feature's detail screen pushed over them.
    expect(layout).toContain("import { Stack, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';");
    expect(layout).toContain('<Stack.Screen name="(tabs)" options={{ headerShown: false }} />');
    expect(layout).toContain('<Stack.Screen name="bookings/[id]" options={{ title: "", headerBackTitle: "Bookings" }} />');
    expect(layout).toMatch(/<AppProviders>\s*<Stack /);
    expect(layout).not.toContain("AppTabs");
    const tabs = readFileSync(join(dir, "src/app/(tabs)/_layout.tsx"), "utf8");
    expect(tabs).toContain('<Tabs.Screen name="bookings" options={{ title: "Bookings", tabBarIcon: tabIcon("calendar-outline") }} />');
    expect(tabs).toContain('<Tabs.Screen name="open-hours" options={{ title: "Open Hours", tabBarIcon: tabIcon("ellipse-outline") }} />');
    expect(tabs).toContain('<Tabs.Screen name="account" options={{ title: "Account", tabBarIcon: tabIcon("person-outline") }} />');
    expect(readFileSync(join(dir, "src/app/(tabs)/bookings.tsx"), "utf8")).toBe("export { BookingsScreen as default } from '@/features/bookings/bookings-screen';\n");
    expect(readFileSync(join(dir, "src/app/bookings/[id].tsx"), "utf8")).toBe("export { BookingsDetailScreen as default } from '@/features/bookings/bookings-detail-screen';\n");
    expect(readFileSync(join(dir, "src/app/(tabs)/account.tsx"), "utf8")).toContain("AccountScreen as default");
    expect(readFileSync(join(dir, "src/app/index.tsx"), "utf8")).toContain('<Redirect href="/bookings" />');
    expect(out.content).toContain("Navigation is set up: src/app/(tabs)/ has one tab per feature (bookings, open-hours, plus account)");
    const providers = readFileSync(join(dir, "src/providers/app-providers.tsx"), "utf8");
    // Sign-in renders inside the query provider, and the session is restored once.
    expect(providers.indexOf("<QueryClientProvider")).toBeLessThan(providers.indexOf("<SessionGate>"));
    expect(providers).toContain("void useSession.getState().restore();\n  }, []);");
  });

  it("only adds the providers to a layout that isn't the template's", () => {
    const own = "import { Stack, ThemeProvider } from 'expo-router';\n\nexport default function Layout() {\n  return (\n    <ThemeProvider value={theme}>\n      <Stack />\n    </ThemeProvider>\n  );\n}\n";
    const wired = wireProviders(own)!;
    expect(wired).toContain("import { AppProviders } from '@/providers/app-providers';");
    expect(wired).toMatch(/<ThemeProvider value=\{theme\}>\s*<AppProviders>\s*<Stack \/>\s*<\/AppProviders>\s*<\/ThemeProvider>/);
    expect(wireProviders(wired)).toBe(wired);
    expect(wireProviders("export default function L() { return null; }")).toBeUndefined();
  });

  it("gives screens designed parts: rows with an avatar, a second line and a status badge", () => {
    const files = kitFiles(kit.schema.parse(INPUT) as never);
    const screen = files["src/features/bookings/bookings-screen.tsx"]!;
    for (const part of ["<ListItem", "<Avatar name={item.title}", "<Badge label={item.status} />", '<SectionHeader title="Bookings"', "ItemSeparatorComponent", "refreshControl", "<SearchField", 'router.push({ pathname: "/bookings/[id]", params: { id: item.id } })']) expect(screen).toContain(part);
    const detail = files["src/features/bookings/bookings-detail-screen.tsx"]!;
    for (const part of ["useLocalSearchParams<{ id: string }>()", "useBookingsItem(id ?? \"\")", "item.details.map"]) expect(detail).toContain(part);
    expect(files["src/features/auth/account-screen.tsx"]).toContain('label="Sign out"');
    expect(files["src/features/bookings/api.ts"]).toContain("subtitle: z.string().nullish()");
    // A status word picks its own colour, and the sign-in screen carries the app's name.
    expect(files["src/components/ui/badge.tsx"]).toContain('if (/pending|wait|soon');
    expect(files["src/features/auth/sign-in-screen.tsx"]).toContain("Brico");
    expect(iconFor("bookings")).toBe("calendar-outline");
    expect(iconFor("barbers")).toBe("people-outline");
    expect(iconFor("settings")).toBe("settings-outline");
    expect(iconFor("zzz")).toBe("ellipse-outline");
  });

  it("never overwrites the project's own files, and skips sign-in when the app has none", async () => {
    expoProject();
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, "src/lib/api.ts"), "// mine\n");
    writeFileSync(join(dir, "eas.json"), "{}\n");
    const out = await kit.run(kit.schema.parse({ ...INPUT, auth: false }), ctx());
    expect(readFileSync(join(dir, "src/lib/api.ts"), "utf8")).toBe("// mine\n");
    expect(readFileSync(join(dir, "eas.json"), "utf8")).toBe("{}\n");
    expect(out.content).toContain("Left alone because they already existed: src/lib/api.ts, eas.json.");
    expect(existsSync(join(dir, "src/features/auth"))).toBe(false);
    expect(kitPackages(kit.schema.parse({ ...INPUT, auth: false }) as never)).toEqual(["@tanstack/react-query", "zod", "react-native-safe-area-context", "@expo/vector-icons", "expo-image"]);
  });

  it("writes code without any, console logging of data, or AsyncStorage for the token", () => {
    const all = Object.entries(kitFiles(kit.schema.parse(INPUT) as never)).filter(([path]) => /\.tsx?$/.test(path));
    expect(all.length).toBeGreaterThan(15);
    for (const [path, code] of all) {
      expect(code, path).not.toMatch(/:\s*any\b|as any\b|from "@react-native-async-storage|console\.log/);
    }
  });

  it("the standards send a new app through create-expo-app and the kit", () => {
    const text = renderPlaybooks(pickPlaybooks("Build a mobile app for booking barbers, for iOS and Android", []));
    expect(text).toContain("npx create-expo-app@latest . --template default");
    expect(text).toContain("call app_kit");
    expect(text).toContain("AGENTS.md");
  });

  it("creates a new app with Expo's generator itself, then offers only app_kit until the architecture is in", async () => {
    const commands: string[] = [];
    const runCommand = {
      ...TOOLS.find((t) => t.name === "run_command")!,
      async run(args: unknown) {
        commands.push((args as { command: string }).command);
        expoProject(); // what the generator leaves behind
        return { ok: true, exitCode: 0, content: "exit 0\nYour project is ready!" };
      },
    };
    const offered: string[][] = [];
    const notes: string[] = [];
    let turn = 0;
    const model: ChatModel = {
      id: "test",
      async complete(req) {
        if (req.jsonSchema) return { content: JSON.stringify({ title: "Brico app", brief: { goal: "g", deliverables: [], requirements: [], acceptance: [], outOfScope: [], assumptions: [] }, summary: "An app.", steps: [{ title: "Write package.json by hand", files: ["package.json"] }] }), toolCalls: [] };
        offered.push((req.tools ?? []).map((t) => t.name));
        notes.push(String(req.messages.at(-1)!.content));
        turn++;
        if (turn === 1) return { content: "", toolCalls: [{ id: "k", name: "app_kit", arguments: JSON.stringify(INPUT) }] };
        return { content: "The project is created and the architecture is in place; next come the screens.", toolCalls: [] };
      },
    };
    const outcome = await runAgentTask({ model, workspace: new Workspace(dir), task: "Build a mobile app for booking barbers, for iOS and Android", approve: async () => true, checks: [], review: false, tools: [...TOOLS.filter((t) => t.name !== "run_command"), runCommand as never] });
    expect(outcome.status).toBe("done");
    expect(commands).toEqual(["npx --yes create-expo-app@latest . --template default", "npm install --no-audit --no-fund", "npx expo install @tanstack/react-query zod @expo/vector-icons expo-image zustand expo-secure-store expo-splash-screen"]);
    expect(notes[1]).toMatch(/^The packages are installed/);
    expect(outcome.plan!.steps.map((x) => x.title)).toEqual(["Create the Expo project with create-expo-app", "Add the architecture with app_kit", "Install the packages and wrap the root layout in AppProviders", "Build each feature in its folder and give it a route", "Run the checks: tsc, expo lint, expo-doctor"]);
    expect(notes[0]).toMatch(/^The Expo project now exists: it was created with `npx create-expo-app@latest`/);
    expect(offered[0]).toEqual(["app_kit"]);
    expect(offered[1]).toContain("edit_file");
    expect(existsSync(join(dir, "src/features/bookings/bookings-screen.tsx"))).toBe(true);
  });
  it("doesn't let the run end on a question while app_kit is the only step on offer", async () => {
    const runCommand = {
      ...TOOLS.find((t) => t.name === "run_command")!,
      async run() {
        if (!existsSync(join(dir, "app.json"))) expoProject(); // only the generator creates the project
        return { ok: true, exitCode: 0, content: "exit 0" };
      },
    };
    const notes: string[] = [];
    let turn = 0;
    const { bundleId: _none, ...withoutId } = INPUT;
    const model: ChatModel = {
      id: "test",
      async complete(req) {
        if (req.jsonSchema) return { content: JSON.stringify({ title: "Brico app", brief: { goal: "g", deliverables: [], requirements: [], acceptance: [], outOfScope: [], assumptions: [] }, summary: "An app.", steps: [{ title: "Build it", files: [] }] }), toolCalls: [] };
        notes.push(String(req.messages.at(-1)!.content));
        turn++;
        if (turn === 1) return { content: "I need a bundle identifier for the app. Do you have a domain you'd like to use?", toolCalls: [] };
        if (turn === 2) return { content: "", toolCalls: [{ id: "k", name: "app_kit", arguments: JSON.stringify(withoutId) }] };
        return { content: "The app is set up. The bundle identifier com.example.brico is a placeholder.", toolCalls: [] };
      },
    };
    const outcome = await runAgentTask({ model, workspace: new Workspace(dir), task: "Build a mobile app for booking barbers, called Brico", approve: async () => true, checks: [], review: false, tools: [...TOOLS.filter((t) => t.name !== "run_command"), runCommand as never] });
    expect(outcome.status).toBe("done");
    expect(notes[1]).toMatch(/^Don't stop to ask or explain: call app_kit now/);
    const config = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as { expo: { ios: { bundleIdentifier: string }; android: { package: string } } };
    expect(config.expo.ios.bundleIdentifier).toBe("com.example.brico");
    expect(config.expo.android.package).toBe("com.example.brico");
    expect(outcome.message).toContain("placeholder");
  });

  it("makes a valid placeholder identifier from any name", () => {
    expect(placeholderBundleId("Brico")).toBe("com.example.brico");
    expect(placeholderBundleId("Šišanje & Co.")).toBe("com.example.sisanjeco");
    expect(placeholderBundleId("2Go")).toBe("com.example.app2go");
  });
});
