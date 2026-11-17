/**
 * An architecture for Expo apps (MASTER_PLAN › Agent quality), the mobile counterpart of the
 * page builder. Expo's own template changes with every SDK, so the project itself is always
 * created with create-expo-app (current versions, current layout). This kit adds what the
 * template leaves to the developer and a local model gets wrong when improvising: typed
 * environment config, one API client, server state, session storage, design tokens, UI
 * primitives with accessibility built in, a feature folder pattern and release config.
 * It uses only APIs that have been stable across SDKs; versions come from `npx expo install`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { pickDirection } from "./design-kit.js";
import { type PhotoConfig, savePhotos } from "./photos.js";
import type { AgentTool, ToolContext, ToolOutcome } from "./tools.js";

export const AppKitInput = z.object({
  name: z.string().min(1).max(40).describe("The app's name as users see it"),
  bundleId: z
    .string()
    .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/)
    .optional()
    .describe("Reverse-domain identifier used on both stores, e.g. 'ba.input.barber'. Leave it out when the user hasn't given one: a placeholder made from the name is used and reported. Don't stop to ask for it"),
  auth: z.boolean().default(false).describe("true when users sign in"),
  business: z.string().max(80).optional().describe("What the app is for, in a few words: 'barber shop bookings', 'bakery orders'. Picks the look (colours, corners)"),
  direction: z.enum(["warm-editorial", "bold-modern", "calm-professional", "dark-studio"]).optional().describe("Set only when the user asked for a particular look; otherwise it follows from business"),
  features: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("kebab-case, e.g. 'bookings'"),
        purpose: z.string().min(3).max(120),
        photo: z.string().max(40).optional().describe("Two or three words naming what a row of this area shows, for stock photos: 'barber cutting hair', 'sourdough loaf'. Leave out for rows that are not a person, place or thing (bookings, invoices)"),
        samples: z
          .array(
            z.object({
              title: z.string().min(1).max(60),
              subtitle: z.string().max(80).optional(),
              status: z.string().max(20).optional(),
              details: z.array(z.object({ label: z.string().max(30), value: z.string().max(60) })).max(6).optional().describe("Facts for the detail screen, e.g. label 'Haircut', value 'from 20 KM'"),
            }),
          )
          .max(8)
          .optional()
          .describe("3 to 6 realistic items for this area, e.g. for bookings: title 'Classic cut', subtitle 'Sat 5 Dec, 11:00 · Amar', status 'Confirmed'. The app shows them in development until the server exists, so the real calls never have to be replaced with made-up data"),
      }),
    )
    .min(1)
    .max(8)
    .describe("The app's main areas; each gets a feature folder with its data access, hook and screen"),
});
export type AppKitInput = z.output<typeof AppKitInput>;

/** Given with the kit's result so the parts can be used without opening each file. */
const PARTS = `Build screens from these parts (import each from "@/components/ui/<file>"); you don't need to read their files first:
- Screen { children, scroll? = true } from screen: safe areas, padding, background.
- AppText { variant? = "body", tone? = "text" | "muted" | "danger" | "onPrimary", ...Text props } from app-text; variants are the keys of scale in src/theme/tokens.ts.
- Button { label, onPress, variant? = "primary" | "secondary", loading?, disabled? } from button.
- TextField { label, error?, ...TextInput props } from text-field.
- SearchField { value, onChangeText, placeholder? } from search-field.
- Card { children, ...View props } from card.
- ListItem { title, subtitle?, leading?, trailing?, onPress? } from list-item; Avatar { name, uri?, size? } from avatar; Badge { label, tone? } from badge.
- SectionHeader { title, detail?, icon? } from section-header (icon is an Ionicons name).
- Loading, Empty { title, hint?, icon? }, Failed { message, onRetry? } from states.
- Appear { index?, children } and Tilt { onPress?, children } from motion: wrap new rows and cards in Appear so they fade up in turn; use Tilt for anything pressable so it leans under the finger. Don't write other animation code.
Colours, spacing, radii and text sizes come from src/theme/tokens.ts; don't restyle from scratch.`;

/** A look for the app: the same four directions the page builder uses, as app colours and corners. */
interface Look {
  light: Record<string, string>;
  dark: Record<string, string>;
  radius: { sm: number; md: number; lg: number };
  tints: string[];
}
const BASE_TINTS = ["#DCE8F5", "#F5E3D7", "#E3EFEA", "#EFE3F3", "#F3EBCF", "#DDEFF0"];
export const APP_LOOKS: Record<string, Look> = {
  "calm-professional": { light: {}, dark: {}, radius: { sm: 6, md: 12, lg: 20 }, tints: BASE_TINTS },
  "warm-editorial": {
    light: { background: "#F7F0E4", surface: "#FFFDF8", text: "#2B1D13", muted: "#6D5B4B", line: "#E2D5C0", primary: "#B4472A", onPrimary: "#FFF7EC", primarySoft: "#F6E1D6" },
    dark: { background: "#17110D", surface: "#221912", text: "#F4EADB", muted: "#B5A594", line: "#3A2C20", primary: "#E98B6C", onPrimary: "#2A1208", primarySoft: "#3A2018" },
    radius: { sm: 8, md: 14, lg: 22 },
    tints: ["#F6E1D6", "#EFE3C8", "#E6EAD3", "#F3DDD0", "#E9DCC6", "#F1E6D8"],
  },
  "bold-modern": {
    light: { background: "#F4F4F8", surface: "#FFFFFF", text: "#0E0E14", muted: "#5B5E6B", line: "#E3E4EC", primary: "#5B3DF5", onPrimary: "#FFFFFF", primarySoft: "#EAE6FF" },
    dark: { background: "#0B0B11", surface: "#16161F", text: "#F3F3F8", muted: "#A2A5B5", line: "#2A2B39", primary: "#9C8CFF", onPrimary: "#0F0A2A", primarySoft: "#231E47" },
    radius: { sm: 8, md: 16, lg: 26 },
    tints: ["#EAE6FF", "#DDF3FF", "#FFE6F0", "#E3FBEA", "#FFF1D6", "#E6EEFF"],
  },
  "dark-studio": {
    light: { background: "#F3F2EE", surface: "#FFFFFF", text: "#141414", muted: "#605F5A", line: "#E0DED7", primary: "#1B1B1D", onPrimary: "#F5D48A", primarySoft: "#ECE8DC" },
    dark: { background: "#0C0C0D", surface: "#17171A", text: "#F5F3EE", muted: "#A19E96", line: "#2A2A2E", primary: "#E6B450", onPrimary: "#1A1304", primarySoft: "#2B2413" },
    radius: { sm: 4, md: 10, lg: 16 },
    tints: ["#ECE8DC", "#E3E1DA", "#EFE6D2", "#E2E4E0", "#EDE2D8", "#E6E6E6"],
  },
};

/** The look for an app: the one asked for, else the one its kind of business suggests. */
export function lookFor(input: { name: string; business?: string | undefined; direction?: string | undefined; features: { purpose: string }[] }): string {
  // "app" and "mobile" describe every app; left in, they would always pick the software look.
  const about = (input.business ?? `${input.name} ${input.features.map((f) => f.purpose).join(" ")}`).replace(/\b(mobile|apps?|application)\b/gi, " ");
  return pickDirection(about, input.direction).id;
}

function applyLook(tokens: string, id: string): string {
  const look = APP_LOOKS[id] ?? APP_LOOKS["calm-professional"]!;
  const recolor = (line: string, colours: Record<string, string>) =>
    Object.entries(colours).reduce((out, [key, value]) => out.replace(new RegExp(`\\b${key}: "#[0-9A-Fa-f]{6}"`), `${key}: "${value}"`), line);
  return tokens
    .split("\n")
    .map((line) => {
      if (line.startsWith("  light: ")) return recolor(line, look.light);
      if (line.startsWith("  dark: ")) return recolor(line, look.dark);
      if (line.startsWith("export const radius = ")) return `export const radius = { sm: ${look.radius.sm}, md: ${look.radius.md}, lg: ${look.radius.lg}, pill: 999 } as const;`;
      if (line.startsWith("export const tints = ")) return `export const tints = ${JSON.stringify(look.tints)} as const;`;
      return line;
    })
    .join("\n");
}

/** What a finished app must still have: each feature's api.ts talking to the server through request(). */
export function kitFindings(read: (path: string) => string | undefined, features: string[]): string[] {
  const findings: string[] = [];
  for (const name of features) {
    const path = `src/features/${name}/api.ts`;
    const api = read(path);
    if (api === undefined) continue; // the feature was renamed or removed on purpose
    if (!/\brequest\s*\(/.test(api)) findings.push(`${path} no longer calls the server: it has no request() call. Put the calls back (request from "@/lib/api") and keep made-up data in src/features/${name}/sample.ts, which development builds already show.`);
  }
  return findings;
}

/** Used until the user names their own: valid on both stores, and plainly a placeholder. */
export function placeholderBundleId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `com.example.${/^[a-z]/.test(slug) ? slug : `app${slug}`}`;
}

const pascal = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase());
const camel = (kebab: string) => pascal(kebab).replace(/^./, (c) => c.toLowerCase());
const titleOf = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_m, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`);

/** Files every app gets. Paths are relative to the project root; `@/` is the template's alias for src/. */
/** \`photos\` maps a feature's name to the pictures saved for its sample rows (paths under assets/). */
export function kitFiles(input: AppKitInput, photos: Record<string, string[]> = {}): Record<string, string> {
  const files: Record<string, string> = {
    ".env.example": `# Copy to .env. EXPO_PUBLIC_ variables are compiled into the app: never put secrets here.\nEXPO_PUBLIC_API_URL=https://api.example.com\n`,

    "src/lib/env.ts": `import { z } from "zod";

/** Environment config, checked once at start so a missing value fails loudly in development. */
const schema = z.object({ EXPO_PUBLIC_API_URL: z.string().url() });
const parsed = schema.safeParse({ EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL });

/** The address in .env.example: no server answers there. */
const PLACEHOLDER = "https://api.example.com";
const apiUrl = (parsed.success ? parsed.data.EXPO_PUBLIC_API_URL : PLACEHOLDER).replace(/\\/+$/, "");
/** Set to "1" to show the sample data in an exported build too (previews and screenshots only). */
const sampleAsked = process.env.EXPO_PUBLIC_SAMPLE_DATA === "1";

if (apiUrl === PLACEHOLDER && !sampleAsked) {
  // A release build without its server address must not ship: it would talk to the placeholder.
  if (!__DEV__) throw new Error("EXPO_PUBLIC_API_URL is not set for this build.");
  console.warn("EXPO_PUBLIC_API_URL is not set: showing the sample data in each feature's sample.ts. Copy .env.example to .env and set the real address to talk to the server.");
}

export const env = {
  apiUrl,
  /**
   * True while there is no server to talk to: development builds without a real EXPO_PUBLIC_API_URL.
   * Each feature's api.ts then answers from its sample.ts; the real calls stay in place beside it.
   */
  sampleData: sampleAsked || (__DEV__ && apiUrl === PLACEHOLDER),
};
`,

    "src/lib/api.ts": `import type { z } from "zod";

import { env } from "@/lib/env";

/** An error the UI can show: what went wrong in words, plus the HTTP status when there was one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let readToken: () => string | null = () => null;
/** The session store registers itself here, so this file doesn't depend on it. */
export function setTokenReader(reader: () => string | null) {
  readToken = reader;
}

interface RequestOptions<S extends z.ZodType> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** What the response must look like. The rest of the app can then trust its types. */
  schema: S;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The one place the app talks to its server: base URL, auth header, timeout, errors, validation. */
export async function request<S extends z.ZodType>(path: string, options: RequestOptions<S>): Promise<z.output<S>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  options.signal?.addEventListener("abort", () => controller.abort());
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(\`\${env.apiUrl}\${path}\`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: \`Bearer \${token}\` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(options.signal?.aborted ? "Cancelled." : "Can't reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const message = response.status === 401 ? "Please sign in again." : response.status >= 500 ? "The server had a problem. Try again in a moment." : "That didn't work. Check what you entered and try again.";
    throw new ApiError(message, response.status);
  }
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) throw new ApiError("The server sent something unexpected.", response.status);
  return parsed.data;
}
`,

    "src/lib/query.ts": `import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";

/** Server state lives here, not in a store: cached, refreshed in the background, retried on network errors only. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failures, error) => failures < 2 && !(error instanceof ApiError && error.status !== undefined && error.status < 500),
    },
    mutations: { retry: false },
  },
});
`,

    "src/theme/tokens.ts": `/** Design tokens: every colour, space and text size in the app comes from here. */
export const palette = {
  light: { background: "#F6F5F1", surface: "#FFFFFF", text: "#17181A", muted: "#63676C", line: "#E4E2DC", primary: "#1F5C4A", onPrimary: "#FFFFFF", primarySoft: "#E3EFEA", danger: "#B42318", dangerSoft: "#FDECEA", success: "#1E7B4F", successSoft: "#E2F3EA", warning: "#9A5B00", warningSoft: "#FBEFD9" },
  dark: { background: "#101211", surface: "#1A1D1C", text: "#F2F1EE", muted: "#A3A7A5", line: "#2C302E", primary: "#6CC7A8", onPrimary: "#0B1512", primarySoft: "#1B2B26", danger: "#F97066", dangerSoft: "#3A1D1A", success: "#6FD19C", successSoft: "#17301F", warning: "#F0B354", warningSoft: "#35280F" },
} as const;

/** Soft backgrounds for avatars and other places that need a colour per item. */
export const tints = ["#DCE8F5", "#F5E3D7", "#E3EFEA", "#EFE3F3", "#F3EBCF", "#DDEFF0"] as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 } as const;

/** Sizes scale with the user's font setting; don't set allowFontScaling to false. */
export const type = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  label: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
} as const;

/** The smallest comfortable touch target on both platforms. */
export const touchTarget = 48;

/** A soft lift for cards. One definition, so every card casts the same shadow. */
export const shadow = { shadowColor: "#000000", shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 } as const;

export type Colors = { [K in keyof (typeof palette)["light"]]: string };
`,

    "src/theme/use-colors.ts": `import { useColorScheme } from "react-native";

import { type Colors, palette } from "@/theme/tokens";

/** The palette for the current light or dark setting. */
export function useColors(): Colors {
  return useColorScheme() === "dark" ? palette.dark : palette.light;
}
`,

    "src/components/ui/app-text.tsx": `import { Text, type TextProps } from "react-native";

import { type as scale } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface AppTextProps extends TextProps {
  variant?: keyof typeof scale;
  tone?: "text" | "muted" | "danger" | "onPrimary";
}

/** All text goes through this, so sizes, colours and dark mode stay consistent. */
export function AppText({ variant = "body", tone = "text", style, ...rest }: AppTextProps) {
  const colors = useColors();
  return <Text accessibilityRole={variant === "title" || variant === "heading" ? "header" : undefined} style={[scale[variant], { color: colors[tone] }, style]} {...rest} />;
}
`,

    "src/components/ui/screen.tsx": `import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface ScreenProps {
  children: ReactNode;
  /** false for screens whose content is a list that scrolls itself. */
  scroll?: boolean;
}

/** Every screen's outer shell: safe areas, the keyboard never covering inputs, background and padding. */
export function Screen({ children, scroll = true }: ScreenProps) {
  const colors = useColors();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {scroll ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.fill, styles.content]}>{children}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { flexGrow: 1, padding: space.md, gap: space.md },
});
`,

    "src/components/ui/button.tsx": `import { ActivityIndicator, Pressable, StyleSheet } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { radius, space, touchTarget } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  loading?: boolean;
  disabled?: boolean;
}

export function Button({ label, onPress, variant = "primary", loading = false, disabled = false }: ButtonProps) {
  const colors = useColors();
  const off = disabled || loading;
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: loading }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: primary ? colors.primary : "transparent", borderColor: primary ? colors.primary : colors.line, opacity: off ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      {loading ? <ActivityIndicator color={primary ? colors.onPrimary : colors.text} /> : <AppText variant="label" tone={primary ? "onPrimary" : "text"}>{label}</AppText>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: touchTarget, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
`,

    "src/components/ui/text-field.tsx": `import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { radius, space, touchTarget, type as scale } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

/** A labelled input. The label is read by screen readers and the error is announced when it appears. */
export function TextField({ label, error, style, ...rest }: TextFieldProps) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[styles.input, scale.body, { color: colors.text, backgroundColor: colors.surface, borderColor: error ? colors.danger : colors.line }, style]}
        {...rest}
      />
      {error ? (
        <AppText variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  input: { minHeight: touchTarget, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1 },
});
`,

    "src/components/ui/states.tsx": `import Ionicons from "@expo/vector-icons/Ionicons";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { Button } from "@/components/ui/button";
import { Appear } from "@/components/ui/motion";
import { space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

/** The three states every screen with data has besides its content. */
export function Loading() {
  const colors = useColors();
  return (
    <View style={styles.center} accessibilityLabel="Loading" accessibilityRole="progressbar">
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function Empty({ title, hint, icon = "file-tray-outline" }: { title: string; hint?: string; icon?: keyof typeof Ionicons.glyphMap }) {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <Appear>
        <View style={[styles.badge, { backgroundColor: colors.primarySoft }]}>
          <Ionicons name={icon} size={30} color={String(colors.primary)} />
        </View>
      </Appear>
      <AppText variant="heading">{title}</AppText>
      {hint ? <AppText tone="muted">{hint}</AppText> : null}
    </View>
  );
}

export function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.center}>
      <AppText tone="muted">{message}</AppText>
      {onRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.lg },
  badge: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
});
`,

    "src/components/ui/motion.tsx": `import type { ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

/**
 * Content that arrives: rows and cards fade up one after another.
 * Reanimated leaves the animation out when the system asks for reduced motion.
 */
export function Appear({ index = 0, children, style }: { index?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 8) * 45).duration(380)} style={style}>
      {children}
    </Animated.View>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TiltProps {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

/** A surface that leans back under the finger and springs up again: depth instead of a flat fade. */
export function Tilt({ children, onPress, accessibilityLabel, style }: TiltProps) {
  const pressed = useSharedValue(0);
  const lean = useAnimatedStyle(() => ({
    transform: [{ perspective: 700 }, { rotateX: pressed.value * 7 + "deg" }, { scale: 1 - pressed.value * 0.03 }],
  }));
  return (
    <AnimatedPressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      disabled={!onPress}
      onPress={onPress}
      onPressIn={() => {
        pressed.value = withSpring(1, { damping: 18, stiffness: 320 });
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, { damping: 12, stiffness: 220 });
      }}
      style={[style, lean]}>
      {children}
    </AnimatedPressable>
  );
}
`,

    "src/components/ui/card.tsx": `import type { ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";

import { radius, shadow, space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

/** A raised surface that groups related content. */
export function Card({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.card, shadow, { backgroundColor: colors.surface, borderColor: colors.line }, style]} {...rest}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.md, gap: space.sm },
});
`,

    "src/components/ui/avatar.tsx": `import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { tints } from "@/theme/tokens";

interface AvatarProps {
  /** Whose it is: used for the initials, the colour and the screen-reader label. */
  name: string;
  uri?: string | null;
  size?: number;
}

const initials = (name: string) => name.trim().split(/\\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
const tintOf = (name: string) => tints[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % tints.length];

/** A person or place: their picture, or their initials on a colour that is always the same for the same name. */
export function Avatar({ name, uri, size = 48 }: AvatarProps) {
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (uri) return <Image source={{ uri }} style={shape} contentFit="cover" accessibilityLabel={name} />;
  return (
    <View style={[styles.center, shape, { backgroundColor: tintOf(name) }]} accessibilityLabel={name}>
      <AppText variant="label" style={{ color: "#17181A", fontSize: size * 0.36 }}>
        {initials(name)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: "center", justifyContent: "center" } });
`,

    "src/components/ui/badge.tsx": `import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { radius, space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

type Tone = "neutral" | "success" | "warning" | "danger";

/** The colour a status word usually means, so lists read at a glance without each screen deciding. */
function toneOf(label: string): Tone {
  if (/confirm|done|complete|paid|active|open|available|approved|delivered|success/i.test(label)) return "success";
  if (/pending|wait|soon|draft|processing|scheduled|review/i.test(label)) return "warning";
  if (/cancel|fail|declin|reject|overdue|closed|error|expired|unavailable/i.test(label)) return "danger";
  return "neutral";
}

/** A short status: "Confirmed", "Pending", "Cancelled". The colour follows the word unless a tone is given. */
export function Badge({ label, tone = toneOf(label) }: { label: string; tone?: Tone }) {
  const colors = useColors();
  const look = {
    neutral: { backgroundColor: colors.primarySoft, color: colors.primary },
    success: { backgroundColor: colors.successSoft, color: colors.success },
    warning: { backgroundColor: colors.warningSoft, color: colors.warning },
    danger: { backgroundColor: colors.dangerSoft, color: colors.danger },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: look.backgroundColor }]}>
      <AppText variant="caption" style={{ color: look.color, fontWeight: "600" }}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: "flex-start", paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
});
`,

    "src/components/ui/list-item.tsx": `import Ionicons from "@expo/vector-icons/Ionicons";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { Tilt } from "@/components/ui/motion";
import { radius, shadow, space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface ListItemProps {
  title: string;
  subtitle?: string | null;
  /** Before the text: an Avatar, an icon. */
  leading?: ReactNode;
  /** After the text: a Badge, a price, a time. */
  trailing?: ReactNode;
  onPress?: () => void;
}

/** One row of a list, as a card. Pressable when it leads somewhere. */
export function ListItem({ title, subtitle, leading, trailing, onPress }: ListItemProps) {
  const colors = useColors();
  return (
    <Tilt
      accessibilityLabel={subtitle ? title + ", " + subtitle : title}
      onPress={onPress}
      style={[styles.row, shadow, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      {leading}
      <View style={styles.text}>
        <AppText variant="label" style={styles.title} numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" tone="muted" style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={String(colors.muted)} /> : null}
    </Tilt>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 72, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, gap: 2 },
  trailing: { alignSelf: "center" },
  title: { fontSize: 16, lineHeight: 22 },
  subtitle: { fontSize: 13, lineHeight: 18 },
});
`,

    "src/components/ui/section-header.tsx": `import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { radius, space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

type IconName = keyof typeof Ionicons.glyphMap;

/** The heading above a list or group: an icon in the app's colour, the title, and how many there are. */
export function SectionHeader({ title, detail, icon }: { title: string; detail?: string; icon?: IconName }) {
  const colors = useColors();
  return (
    <View style={styles.row}>
      {icon ? (
        <View style={[styles.icon, { backgroundColor: colors.primarySoft }]}>
          <Ionicons name={icon} size={20} color={String(colors.primary)} />
        </View>
      ) : null}
      <AppText variant="title" style={styles.title}>
        {title}
      </AppText>
      {detail ? <AppText tone="muted">{detail}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: space.sm },
  title: { flex: 1 },
  icon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
});
`,

    "src/components/ui/search-field.tsx": `import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { radius, space, touchTarget, type as scale } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

interface SearchFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
}

/** A search box for filtering a list, with a button to clear it. */
export function SearchField({ value, onChangeText, placeholder = "Search" }: SearchFieldProps) {
  const colors = useColors();
  return (
    <View style={[styles.box, { backgroundColor: colors.surface, borderColor: colors.line }]}>
      <Ionicons name="search-outline" size={18} color={colors.muted} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.input, scale.body, { color: colors.text }]}
      />
      {value ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={12} onPress={() => onChangeText("")}>
          <Ionicons name="close-circle" size={18} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: touchTarget, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, paddingVertical: 0 },
});
`,

    "src/providers/app-providers.tsx": input.auth
      ? `import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";

import * as SplashScreen from "expo-splash-screen";

import { useSession } from "@/features/auth/session";
import { SignInScreen } from "@/features/auth/sign-in-screen";
import { queryClient } from "@/lib/query";

/** Restores the session once, then shows the app to signed-in users and the sign-in screen to everyone else. */
function SessionGate({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  useEffect(() => {
    void useSession.getState().restore();
  }, []);
  // The app's own content hides the splash screen when it mounts; the sign-in screen has to do it here.
  useEffect(() => {
    if (status === "signedOut") void SplashScreen.hideAsync();
  }, [status]);
  if (status === "loading") return null;
  if (status === "signedOut") return <SignInScreen />;
  return <>{children}</>;
}

/** Wrap the root layout's content in this once. New app-wide providers go here, not in the layout. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate>{children}</SessionGate>
    </QueryClientProvider>
  );
}
`
      : `import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { queryClient } from "@/lib/query";

/** Wrap the root layout's content in this once. New app-wide providers go here, not in the layout. */
export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
`,
  };

  if (input.auth) {
    files["src/features/auth/session.ts"] = `import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { create } from "zustand";

import { setTokenReader } from "@/lib/api";

const KEY = "session-token";
// The Keychain and Keystore exist on devices only; on web the token stays in memory.
const secure = Platform.OS !== "web";

interface Session {
  status: "loading" | "signedOut" | "signedIn";
  token: string | null;
  /** Call once when the app starts. */
  restore: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

/** Who is signed in. The token is kept in the device's secure storage, never in AsyncStorage. */
export const useSession = create<Session>((set) => ({
  status: "loading",
  token: null,
  restore: async () => {
    const token = secure ? await SecureStore.getItemAsync(KEY).catch(() => null) : null;
    set({ token, status: token ? "signedIn" : "signedOut" });
  },
  signIn: async (token) => {
    if (secure) await SecureStore.setItemAsync(KEY, token);
    set({ token, status: "signedIn" });
  },
  signOut: async () => {
    if (secure) await SecureStore.deleteItemAsync(KEY).catch(() => undefined);
    set({ token: null, status: "signedOut" });
  },
}));

setTokenReader(() => useSession.getState().token);
`;
    files["src/features/auth/sign-in-screen.tsx"] = `import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { z } from "zod";

import { AppText } from "@/components/ui/app-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { TextField } from "@/components/ui/text-field";
import { useSession } from "@/features/auth/session";
import { ApiError, request } from "@/lib/api";
import { env } from "@/lib/env";
import { space } from "@/theme/tokens";

const SignedIn = z.object({ token: z.string().min(1) });

/** Email and password sign-in. Point the request at the real endpoint and adjust the response schema. */
export function SignInScreen() {
  const signIn = useSession((s) => s.signIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    // With no server yet (env.sampleData) any email and password sign in; the request is the real one.
    mutationFn: async () =>
      env.sampleData ? { token: "sample" } : request("/auth/sign-in", { method: "POST", body: { email: email.trim(), password }, schema: SignedIn }),
    onSuccess: ({ token }) => signIn(token),
  });
  const ready = /^\\S+@\\S+\\.\\S+$/.test(email.trim()) && password.length > 0;
  const failed = login.error instanceof ApiError && login.error.status === 401 ? "Wrong email or password." : login.error?.message;
  return (
    <Screen>
      <View style={styles.middle}>
        <View style={styles.intro}>
          <AppText variant="title" style={styles.brand}>
            ${input.name.replace(/[`$\\]/g, "")}
          </AppText>
          <AppText tone="muted">Sign in to continue.</AppText>
        </View>
        <Card style={styles.card}>
          <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
          <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" error={failed} />
          <Button label="Sign in" onPress={() => login.mutate()} loading={login.isPending} disabled={!ready} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  middle: { flex: 1, justifyContent: "center", gap: space.lg },
  intro: { gap: space.xs },
  brand: { fontSize: 36, lineHeight: 42 },
  card: { gap: space.md, padding: space.lg },
});
`;
    files["src/features/auth/account-screen.tsx"] = `import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { SectionHeader } from "@/components/ui/section-header";
import { useSession } from "@/features/auth/session";
import { space } from "@/theme/tokens";

/** The signed-in user's own tab. Add profile details and settings above the sign-out button. */
export function AccountScreen() {
  const signOut = useSession((s) => s.signOut);
  return (
    <Screen>
      <SectionHeader title="Account" />
      <Card style={styles.card}>
        <View style={styles.text}>
          <AppText variant="heading">You are signed in</AppText>
          <AppText tone="muted">Signing out removes your session from this device.</AppText>
        </View>
        <Button label="Sign out" variant="secondary" onPress={() => void signOut()} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md, padding: space.lg },
  text: { gap: space.xs },
});
`;
  }

  for (const f of input.features) {
    const Name = pascal(f.name);
    const name = camel(f.name);
    const dir = `src/features/${f.name}`;
    files[`${dir}/api.ts`] = `import { z } from "zod";

import { ${name}Sample } from "@/features/${f.name}/sample";
import { request } from "@/lib/api";
import { env } from "@/lib/env";

// ${f.purpose}
// Describe what the server returns; everything else in this feature gets its types from here.
export const ${name}ItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** A second line: who, where, when, what. */
  subtitle: z.string().nullish(),
  /** A short state shown as a badge, e.g. "Confirmed". */
  status: z.string().nullish(),
  imageUrl: z.string().url().nullish(),
  /** Facts shown on the detail screen, e.g. { label: "Price", value: "25 KM" }. */
  details: z.array(z.object({ label: z.string(), value: z.string() })).nullish(),
});
export type ${Name}Item = z.output<typeof ${name}ItemSchema>;

// Until the server exists, development builds answer from sample.ts (see env.sampleData).
// The request() calls below are the real ones: point them at the real endpoints, never remove them.
export async function fetch${Name}(signal?: AbortSignal): Promise<${Name}Item[]> {
  if (env.sampleData) return ${name}Sample;
  return request("/${f.name}", { schema: z.array(${name}ItemSchema), signal });
}

export async function fetch${Name}Item(id: string, signal?: AbortSignal): Promise<${Name}Item> {
  if (env.sampleData) {
    const item = ${name}Sample.find((x) => x.id === id);
    if (!item) throw new Error("Not found");
    return item;
  }
  return request("/${f.name}/" + encodeURIComponent(id), { schema: ${name}ItemSchema, signal });
}
`;
    const samples = f.samples?.length ? f.samples : [1, 2, 3].map((n) => ({ title: `${titleOf(f.name)} ${n}`, subtitle: "Sample item", status: undefined }));
    const shots = photos[f.name] ?? [];
    files[`${dir}/sample.ts`] = `${shots.length ? 'import { Asset } from "expo-asset";\n\n' : ""}import type { ${Name}Item } from "@/features/${f.name}/api";
${shots.length ? "\n/** A bundled picture as an address, the way the server would send one. Credits are in assets/images/sample/CREDITS.md. */\nconst photo = (file: number) => Asset.fromModule(file).uri;\n" : ""}
/**
 * Shown in development until EXPO_PUBLIC_API_URL points at a real server.
 * Change it freely; api.ts keeps the real calls.
 */
export const ${name}Sample: ${Name}Item[] = [
${samples
  .map((x, i) => `  { id: "${i + 1}", title: ${JSON.stringify(x.title)}${x.subtitle ? `, subtitle: ${JSON.stringify(x.subtitle)}` : ""}${x.status ? `, status: ${JSON.stringify(x.status)}` : ""}${shots.length ? `, imageUrl: photo(require("@/${shots[i % shots.length]}"))` : ""}${"details" in x && x.details?.length ? `, details: ${JSON.stringify(x.details)}` : ""} },`)
  .join("\n")}
];
`;
    files[`${dir}/use-${f.name}.ts`] = `import { useQuery } from "@tanstack/react-query";

import { fetch${Name}, fetch${Name}Item } from "@/features/${f.name}/api";

/** Query keys for this feature, in one place so invalidation can't drift. */
export const ${name}Keys = { all: ["${f.name}"] as const, item: (id: string) => ["${f.name}", id] as const };

export function use${Name}() {
  return useQuery({ queryKey: ${name}Keys.all, queryFn: ({ signal }) => fetch${Name}(signal) });
}

export function use${Name}Item(id: string) {
  return useQuery({ queryKey: ${name}Keys.item(id), queryFn: ({ signal }) => fetch${Name}Item(id, signal), enabled: id.length > 0 });
}
`;
    files[`${dir}/${f.name}-screen.tsx`] = `import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ListItem } from "@/components/ui/list-item";
import { Appear } from "@/components/ui/motion";
import { Screen } from "@/components/ui/screen";
import { SearchField } from "@/components/ui/search-field";
import { SectionHeader } from "@/components/ui/section-header";
import { Empty, Failed, Loading } from "@/components/ui/states";
import type { ${Name}Item } from "@/features/${f.name}/api";
import { use${Name} } from "@/features/${f.name}/use-${f.name}";
import { env } from "@/lib/env";
import { space } from "@/theme/tokens";

function Row({ item }: { item: ${Name}Item }) {
  const router = useRouter();
  return (
    <ListItem
      title={item.title}
      subtitle={item.subtitle}
      leading={<Avatar name={item.title} uri={item.imageUrl} />}
      trailing={item.status ? <Badge label={item.status} /> : undefined}
      onPress={() => router.push({ pathname: "/${f.name}/[id]", params: { id: item.id } })}
    />
  );
}

const renderRow = ({ item, index }: { item: ${Name}Item; index: number }) => (
  <Appear index={index}>
    <Row item={item} />
  </Appear>
);
const keyOf = (item: ${Name}Item) => item.id;
const Gap = () => <View style={styles.gap} />;

/** ${f.purpose} The route file only renders this component. */
export function ${Name}Screen() {
  const query = use${Name}();
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    const all = query.data ?? [];
    return words ? all.filter((item) => (item.title + " " + (item.subtitle ?? "")).toLowerCase().includes(words)) : all;
  }, [query.data, search]);
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} onRetry={() => void query.refetch()} />;
  return (
    <Screen scroll={false}>
      <FlatList
        data={shown}
        keyExtractor={keyOf}
        renderItem={renderRow}
        ItemSeparatorComponent={Gap}
        ListHeaderComponent={
          <View style={styles.head}>
            <SectionHeader icon="${iconFor(f.name)}" title="${titleOf(f.name)}" detail={env.sampleData ? "Sample data" : query.data.length ? String(query.data.length) : undefined} />
            {query.data.length > 4 ? <SearchField value={search} onChangeText={setSearch} placeholder="Search ${titleOf(f.name).toLowerCase()}" /> : null}
          </View>
        }
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
        ListEmptyComponent={search ? <Empty icon="search-outline" title="No matches" hint="Try a different search." /> : <Empty icon="${iconFor(f.name)}" title="Nothing here yet" hint="Pull down to refresh." />}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1, paddingBottom: space.xl },
  head: { gap: space.sm, paddingBottom: space.sm },
  gap: { height: space.sm },
});
`;
    files[`${dir}/${f.name}-detail-screen.tsx`] = `import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/components/ui/app-text";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Appear } from "@/components/ui/motion";
import { Screen } from "@/components/ui/screen";
import { Failed, Loading } from "@/components/ui/states";
import { use${Name}Item } from "@/features/${f.name}/use-${f.name}";
import { radius, space } from "@/theme/tokens";
import { useColors } from "@/theme/use-colors";

/** One item in full: who or what it is, its state, its facts. Add this screen's actions under the card. */
export function ${Name}DetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const query = use${Name}Item(id ?? "");
  const colors = useColors();
  if (query.isPending) return <Loading />;
  if (query.isError) return <Failed message={query.error.message} onRetry={() => void query.refetch()} />;
  const item = query.data;
  return (
    <Screen>
      {item.imageUrl ? (
        <Appear>
          <Image source={{ uri: item.imageUrl }} style={[styles.photo, { backgroundColor: colors.primarySoft }]} contentFit="cover" transition={250} accessibilityLabel={item.title} />
        </Appear>
      ) : null}
      <View style={styles.hero}>
        {item.imageUrl ? null : <Avatar name={item.title} size={88} />}
        <View style={styles.heroText}>
          <AppText variant="title">{item.title}</AppText>
          {item.subtitle ? <AppText tone="muted">{item.subtitle}</AppText> : null}
          {item.status ? <Badge label={item.status} /> : null}
        </View>
      </View>
      {item.details?.length ? (
        <Appear index={2}>
          <Card>
          {item.details.map((fact, index) => (
            <View key={fact.label} style={[styles.fact, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }]}>
              <AppText tone="muted">{fact.label}</AppText>
              <AppText variant="label" style={styles.value}>
                {fact.value}
              </AppText>
            </View>
          ))}
          </Card>
        </Appear>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { width: "100%", aspectRatio: 16 / 10, borderRadius: radius.lg },
  hero: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm },
  heroText: { flex: 1, gap: space.xs },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: space.md, paddingVertical: space.sm },
  value: { flexShrink: 1, textAlign: "right" },
});
`;
  }

  files["src/theme/tokens.ts"] = applyLook(files["src/theme/tokens.ts"]!, lookFor(input));
  files["docs/ARCHITECTURE.md"] = `# Architecture

${input.name} is an Expo app. Routes are files in the router's \`app\` folder; everything else lives beside it under \`src/\`.

## Where things go
- **Route files** stay thin: they render one screen component from a feature and nothing else.
- **\`src/features/<name>/\`** holds one area of the app: \`api.ts\` (what the server returns, as a zod schema, and the calls), \`sample.ts\` (what development builds show until the server exists), \`use-<name>.ts\` (TanStack Query hooks and query keys), \`<name>-screen.tsx\` (the list, with search) and \`<name>-detail-screen.tsx\` (one item, opened by tapping a row).
- **\`src/components/ui/\`** has the shared primitives: \`Screen\`, \`AppText\`, \`Button\`, \`TextField\`, \`SearchField\`, \`Card\`, \`ListItem\`, \`Avatar\`, \`Badge\`, \`SectionHeader\`, \`Loading\`, \`Empty\`, \`Failed\`. Build screens from these so safe areas, dark mode, font scaling, touch targets and screen-reader labels come for free.
- **\`src/theme/tokens.ts\`** is the only place colours, spacing, radii and text sizes are defined.
- **\`src/lib/\`**: \`api.ts\` is the one place the app talks to the server; \`query.ts\` configures caching; \`env.ts\` reads environment config.
- **\`src/providers/app-providers.tsx\`** wraps the root layout; new app-wide providers go there.

## Sample data
Until \`EXPO_PUBLIC_API_URL\` points at a real server, development builds set \`env.sampleData\`: each feature answers from its \`sample.ts\`, any email and password sign in, and list headers say "Sample data". The \`request()\` calls in \`api.ts\` stay where they are; when the server exists, set the address in \`.env\` and they take over. A release build without a real address refuses to start.

## Rules
- Made-up data lives only in \`sample.ts\`. \`api.ts\` always keeps its \`request()\` calls.
- Server data lives in TanStack Query, never copied into a store. Client state is local first; a small zustand store only when several screens need it.
- Tokens and other secrets go in \`expo-secure-store\`. \`EXPO_PUBLIC_\` variables are public.
- Every response is validated with its zod schema in \`api.ts\`; no \`any\`.
- Every screen with data handles loading, empty and failed states.
- Add packages with \`npx expo install <package>\` so versions match the SDK. A package with native code needs a new development build.
- Before finishing: \`npx tsc --noEmit\`, \`npx expo lint\`, \`npx expo-doctor\`.

## Features
${input.features.map((f) => `- \`${f.name}\`: ${f.purpose}`).join("\n")}${input.auth ? "\n- `auth`: session in `src/features/auth/session.ts` (secure storage), sign-in screen in `sign-in-screen.tsx`." : ""}

## Releasing
\`eas.json\` has development, preview and production profiles. Build with \`npx eas-cli@latest build --profile production --platform ios|android\`, submit with \`npx eas-cli@latest submit\`. Store requirements change yearly: check the current ones before submitting.
`;
  return files;
}

export const EAS_JSON = `${JSON.stringify(
  {
    cli: { appVersionSource: "remote" },
    build: {
      development: { developmentClient: true, distribution: "internal" },
      preview: { distribution: "internal" },
      production: { autoIncrement: true },
    },
    submit: { production: {} },
  },
  null,
  2,
)}\n`;

/**
 * Puts <AppProviders> inside the root layout's <ThemeProvider>, the shape Expo's template has.
 * Returns undefined when the layout looks different: then the model is told to do it.
 */
export function wireProviders(layout: string): string | undefined {
  if (layout.includes("AppProviders")) return layout;
  const open = /<ThemeProvider\b[^>]*>/.exec(layout);
  const close = layout.lastIndexOf("</ThemeProvider>");
  if (!open || close < open.index) return undefined;
  const lastImport = [...layout.matchAll(/^import .*$/gm)].at(-1);
  if (!lastImport) return undefined;
  const inner = layout.slice(open.index + open[0].length, close);
  const wrapped = `${layout.slice(0, open.index + open[0].length)}\n      <AppProviders>${inner.replace(/\n(?=.)/g, "\n  ").replace(/\s*$/, "")}\n      </AppProviders>\n    ${layout.slice(close)}`;
  const at = lastImport.index + lastImport[0].length;
  return `${wrapped.slice(0, at)}\nimport { AppProviders } from '@/providers/app-providers';${wrapped.slice(at)}`;
}

/** A tab icon that fits what the feature is called. Names are from Ionicons and checked by the type checker. */
const ICONS: [RegExp, string][] = [
  [/book|appoint|calendar|schedule|event|reserv/, "calendar-outline"],
  [/barber|people|user|team|staff|client|customer|member|friend|contact|doctor|driver/, "people-outline"],
  [/home|feed|dashboard|overview|today/, "home-outline"],
  [/profile|account|me$/, "person-outline"],
  [/setting|preference/, "settings-outline"],
  [/search|explore|discover|browse/, "search-outline"],
  [/cart|basket|order|shop|store|product/, "cart-outline"],
  [/chat|message|inbox/, "chatbubbles-outline"],
  [/map|place|location|near|route|trip|ride/, "map-outline"],
  [/favou?rite|saved|wishlist|like/, "heart-outline"],
  [/notif|alert/, "notifications-outline"],
  [/pay|wallet|billing|invoice|card/, "card-outline"],
  [/photo|image|gallery|camera/, "images-outline"],
  [/stat|report|analytic|progress/, "stats-chart-outline"],
];
export const iconFor = (feature: string) => ICONS.find(([words]) => words.test(feature))?.[1] ?? "ellipse-outline";

/**
 * Navigation for a new app, the same on iOS, Android and web: a stack whose first screen is the
 * tabs (one per feature, plus Account when users sign in), with each feature's detail screen
 * pushed on top. Replaces the template's demo layout, whose starter screens the model otherwise
 * leaves as the app's home.
 */
export function rootLayout(input: AppKitInput, themeFrom: string | undefined): string {
  const stack = `<Stack screenOptions={{ headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.primary, headerTitleStyle: { color: colors.text }, headerShadowVisible: false, contentStyle: { backgroundColor: colors.background } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
${input.features.map((f) => `          <Stack.Screen name="${f.name}/[id]" options={{ title: "", headerBackTitle: "${titleOf(f.name)}" }} />`).join("\n")}
        </Stack>`;
  const body = themeFrom ? `    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>\n      <AppProviders>\n        ${stack}\n      </AppProviders>\n    </ThemeProvider>` : `    <AppProviders>\n        ${stack}\n    </AppProviders>`;
  return `import { Stack${themeFrom === "expo-router" ? ", DarkTheme, DefaultTheme, ThemeProvider" : ""} } from 'expo-router';
${themeFrom && themeFrom !== "expo-router" ? `import { DarkTheme, DefaultTheme, ThemeProvider } from '${themeFrom}';\n` : ""}${themeFrom ? "import { useColorScheme } from 'react-native';\n" : ""}
import { AppProviders } from '@/providers/app-providers';
import { useColors } from '@/theme/use-colors';

/** The app's navigation: the tabs, with detail screens pushed over them. */
export default function RootLayout() {
  const colors = useColors();
${themeFrom ? "  const scheme = useColorScheme();\n" : ""}  return (
${body}
  );
}
`;
}

/** The tab bar: one tab per feature. Add a tab by adding a route file in (tabs)/ and a Tabs.Screen here. */
export function tabsLayout(input: AppKitInput): string {
  const tabs = [...input.features.map((f) => ({ name: f.name, title: titleOf(f.name), icon: iconFor(f.name) })), ...(input.auth ? [{ name: "account", title: "Account", icon: "person-outline" }] : [])];
  return `import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { type ColorValue, Platform } from 'react-native';

import { useColors } from '@/theme/use-colors';

// In a browser there is no home-indicator inset, so the bar needs its own room under the labels.
const webBar = Platform.OS === 'web' ? { height: 64, paddingBottom: 10, paddingTop: 6 } : {};

type IconName = keyof typeof Ionicons.glyphMap;
const tabIcon = (name: IconName) => function TabIcon({ color, size }: { color: ColorValue; size: number }) {
  // The tints set below are plain colour strings from the theme.
  return <Ionicons name={name} color={String(color)} size={size} />;
};

export default function TabsLayout() {
  const colors = useColors();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted, tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line, ...webBar } }}>
${tabs.map((t) => `      <Tabs.Screen name="${t.name}" options={{ title: "${t.title}", tabBarIcon: tabIcon("${t.icon}") }} />`).join("\n")}
    </Tabs>
  );
}
`;
}

/** Packages the kit's files import beyond the template's own. Installed with `expo install` so versions match the SDK. */
export const kitPackages = (input: AppKitInput) => ["@tanstack/react-query", "zod", "react-native-safe-area-context", "react-native-reanimated", "@expo/vector-icons", "expo-image", "expo-asset", ...(input.auth ? ["zustand", "expo-secure-store", "expo-splash-screen"] : [])];

/** With \`photos\` (web access on) the kit also fetches stock pictures for the sample rows. */
export function appKitTool(cfg: { photos?: PhotoConfig } = {}): AgentTool {
  return {
    name: "app_kit",
    description:
      "Give an Expo (React Native) app a production architecture: typed environment config, one API client, server-state caching, design tokens, accessible UI primitives, a feature folder for each area of the app, optional sign-in with secure session storage, EAS build profiles and an architecture document. Use it right after creating the project with `npx create-expo-app@latest`, before writing screens; then build each feature inside its folder.",
    schema: AppKitInput,
    async run(args, ctx: ToolContext): Promise<ToolOutcome> {
      const input = args as AppKitInput;
      const read = (rel: string) => (existsSync(ctx.workspace.resolve(rel)) ? readFileSync(ctx.workspace.resolve(rel), "utf8") : undefined);
      const pkg = read("package.json");
      let deps: Record<string, string> = {};
      try {
        const parsed = JSON.parse(pkg ?? "{}") as { dependencies?: Record<string, string> };
        deps = parsed.dependencies ?? {};
      } catch {
        // an unreadable package.json is treated as no project
      }
      if (!deps.expo) {
        return {
          ok: false,
          content:
            "There is no Expo project here yet. Create it first with run_command: `npx create-expo-app@latest . --template default` (in an empty folder; it needs the network and the user's approval). That gives the current SDK, versions and layout. Then call app_kit again.",
        };
      }
      const written: string[] = [];
      const kept: string[] = [];
      const write = (rel: string, content: string) => {
        const abs = ctx.workspace.resolve(rel);
        if (existsSync(abs) && !ctx.createdThisRun?.has(rel)) {
          kept.push(rel);
          return;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        ctx.createdThisRun?.add(rel);
        written.push(rel);
      };
      // Pictures for the sample rows, so lists and detail screens are not all initials. Never fatal.
      const photos: Record<string, string[]> = {};
      if (cfg.photos) {
        for (const f of input.features) {
          if (!f.photo || existsSync(ctx.workspace.resolve(`src/features/${f.name}/sample.ts`))) continue;
          try {
            const want = Math.min(Math.max(f.samples?.length ?? 3, 3), 6);
            const got = await savePhotos(f.photo, want, "square", "assets/images/sample", cfg.photos, ctx);
            if (got.length) photos[f.name] = got.map((x) => x.path);
          } catch {
            // no pictures: the rows show initials
          }
        }
      }
      for (const [rel, content] of Object.entries(kitFiles(input, photos))) write(rel, content);
      write("eas.json", EAS_JSON);
      // What \`expo start\` writes on first run; without it \`tsc\` can't resolve the template's CSS imports.
      write("expo-env.d.ts", '/// <reference types="expo/types" />\n\n// NOTE: This file should not be edited and should be in your git ignore\n');

      // Identity for the stores, when the project keeps its config as JSON.
      let identity = "Set the name, ios.bundleIdentifier and android.package in the app config yourself (it isn't plain app.json).";
      const appJson = read("app.json");
      if (appJson) {
        try {
          const config = JSON.parse(appJson) as { expo?: Record<string, unknown> };
          const expo = (config.expo ??= {});
          expo.name = input.name;
          const ios = ((expo.ios as Record<string, unknown> | undefined) ??= {});
          const android = ((expo.android as Record<string, unknown> | undefined) ??= {});
          expo.ios = ios;
          expo.android = android;
          const bundleId = input.bundleId ?? placeholderBundleId(input.name);
          ios.bundleIdentifier ??= bundleId;
          android.package ??= bundleId;
          writeFileSync(ctx.workspace.resolve("app.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
          identity = `app.json: name "${input.name}", ios.bundleIdentifier and android.package "${String(ios.bundleIdentifier)}".`;
          if (!input.bundleId && ios.bundleIdentifier === bundleId) {
            identity += ` That identifier is a placeholder: say so in your answer, and that it must be changed to the user's own (reverse domain, e.g. ba.company.app) before the first store build, because it can't be changed after publishing.`;
          }
        } catch {
          // leave a config we can't parse alone
        }
      }
      const routes = existsSync(ctx.workspace.resolve("src/app")) ? "src/app" : "app";
      // Navigation and providers are set up here, not by the model: it leaves the template's
      // starter screens as the app's home, puts sign-in outside the query provider, and restores
      // the session in an effect that re-runs on every store change.
      const layoutPath = `${routes}/_layout.tsx`;
      const layout = read(layoutPath);
      const fresh = layout !== undefined && layout.includes("@/components/app-tabs"); // Expo's template, untouched
      let wired: string | undefined;
      if (fresh) {
        const routeDir = ctx.workspace.resolve(routes);
        const put = (rel: string, content: string) => {
          mkdirSync(dirname(join(routeDir, rel)), { recursive: true });
          writeFileSync(join(routeDir, rel), content, "utf8");
        };
        for (const f of input.features) {
          put(`(tabs)/${f.name}.tsx`, `export { ${pascal(f.name)}Screen as default } from '@/features/${f.name}/${f.name}-screen';\n`);
          put(`${f.name}/[id].tsx`, `export { ${pascal(f.name)}DetailScreen as default } from '@/features/${f.name}/${f.name}-detail-screen';\n`);
        }
        if (input.auth) put("(tabs)/account.tsx", "export { AccountScreen as default } from '@/features/auth/account-screen';\n");
        put("(tabs)/_layout.tsx", tabsLayout(input));
        put("index.tsx", `import { Redirect } from 'expo-router';\n\n/** The app opens on its first tab. */\nexport default function Index() {\n  return <Redirect href="/${input.features[0]!.name}" />;\n}\n`);
        const themeFrom = /import \{[^}]*ThemeProvider[^}]*\} from ['"]([^'"]+)['"]/.exec(layout)?.[1];
        wired = rootLayout(input, themeFrom);
        writeFileSync(ctx.workspace.resolve(layoutPath), wired, "utf8");
        // The template's own tab bar was only used by the layout just replaced, and its web
        // variant has a type error that would keep the project's typecheck red.
        const base = layoutPath.startsWith("src/") ? "src/" : "";
        for (const rel of [`${base}components/app-tabs.tsx`, `${base}components/app-tabs.web.tsx`]) rmSync(ctx.workspace.resolve(rel), { force: true });
      } else {
        wired = layout === undefined ? undefined : wireProviders(layout);
        if (wired !== undefined && wired !== layout) writeFileSync(ctx.workspace.resolve(layoutPath), wired, "utf8");
      }
      const missing = kitPackages(input).filter((p) => !deps[p]);
      const steps = [
        missing.length ? `Install what the kit imports: run_command \`npx expo install ${missing.join(" ")}\`.` : "",
        fresh
          ? `Navigation is set up: ${routes}/(tabs)/ has one tab per feature (${input.features.map((f) => f.name).join(", ")}${input.auth ? ", plus account" : ""}), tapping a row opens ${routes}/<feature>/[id].tsx with the feature's detail screen, the app opens on the first tab, and <AppProviders> wraps it all${input.auth ? " (it restores the session and shows the sign-in screen to signed-out users)" : ""}. Don't rewrite the layouts or add session code to them. The template's own demo screen (explore) is no longer reachable; delete it when you no longer need it.`
          : wired !== undefined
            ? `${layoutPath} now wraps the app in <AppProviders>${input.auth ? ", which restores the session and shows the sign-in screen to signed-out users: add no session code to the layout" : ""}. For each feature, make its route file in ${routes}/ render the feature's screen component and nothing else (e.g. \`export { ${pascal(input.features[0]!.name)}Screen as default } from "@/features/${input.features[0]!.name}/${input.features[0]!.name}-screen"\`).`
            : `In ${layoutPath}, import { AppProviders } from "@/providers/app-providers" and wrap everything the layout returns in <AppProviders>…</AppProviders>${input.auth ? " (it restores the session and shows the sign-in screen itself: add no session code)" : ""}. For each feature, make its route file in ${routes}/ render the feature's screen component and nothing else.`,
        "Fill in each feature: the real response schema and endpoints in its api.ts, the real rows, details and actions in its screen.",
        "There is no server yet, and the app already handles that: in development it shows each feature's sample.ts, signs in with any email and password, and marks lists \"Sample data\". To change what is shown, edit sample.ts. Never replace the request() calls in api.ts with hard-coded data, and say in your answer that the app runs on sample data until EXPO_PUBLIC_API_URL is set in .env.",
        "Check: `npx tsc --noEmit`, `npx expo lint`, `npx expo-doctor`.",
      ].filter(Boolean);
      return {
        ok: true,
        edited: written.length > 0,
        content: `Added the architecture (${written.length} files): ${written.slice(0, 40).join(", ")}.${kept.length ? `\nLeft alone because they already existed: ${kept.join(", ")}.` : ""}\n${identity}\ndocs/ARCHITECTURE.md describes where things go; follow it.\n\nNext:\n${steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n${PARTS}`,
      };
    },
  } as AgentTool;
}
