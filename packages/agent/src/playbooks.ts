/**
 * Standards for common kinds of work (MASTER_PLAN › Agent quality): what a
 * senior engineer would do without being told. The planner gets the ones that
 * match the task and the project, so a loose request ("make a landing page")
 * is planned against real requirements. Deterministic and offline: matching is
 * by words in the task and by the project's files; nothing here is fetched.
 */

export interface Playbook {
  id: string;
  /** Shown to the model as the heading. */
  title: string;
  /** "stack" playbooks describe a kind of project; "work" playbooks a kind of change. */
  kind: "stack" | "work";
  task?: RegExp;
  /** Matches against project file paths (any one). */
  files?: RegExp;
  rules: string[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: "web-page",
    title: "Static web page or landing page",
    kind: "stack",
    task: /\b(landing ?page|web ?page|website|web ?site|one[- ]page|homepage|home page|html page|portfolio|stranic[aeu]|sajt)\b/i,
    rules: [
      "A new page or site is built with the design_kit tool, not by writing HTML and CSS: you give it the page's content as data and it writes the finished page (ten sections, photos, animations, search-engine tags, a logo). So the plan is: 1. decide the content (name, the search phrase, headline, the offer, the story, steps, questions and answers, contact details), 2. call design_kit with it, 3. look at the result and adjust with small edits. In a project that already has its own page and styles, follow those instead.",
      "A landing page is long enough to convince: besides what the user asked for, it tells the story, shows how it works, answers the questions customers ask and ends with a clear action. Write that content for design_kit even when the request names only a few sections.",
      "Files: index.html, styles.css and script.js in one folder (inline everything only if the user asks for a single file); assets in assets/. Keep each file under 400 lines: write the page section by section, not in one step.",
      "Semantic HTML5: header, nav, main, section, footer; exactly one h1; headings in order; lang on <html>.",
      "In <head>: charset, viewport, a specific <title> (under 60 characters), meta description (under 160), Open Graph title/description/image, a favicon link.",
      "Design: left-aligned text with a clear hierarchy (one large headline, a short lead, one main action); sections that differ from each other (a price list, a picture beside text, a tinted band), not a row of identical centred cards; no emoji as pictures or icons; pictures are the user's images or labelled photo places.",
      "Accessible (WCAG 2.2 AA): text contrast 4.5:1 or more, alt text on images, a label for every form field, visible focus styles, buttons are <button>, links are <a href>.",
      "Motion: animate transform and opacity only; honour prefers-reduced-motion; the page must be fully readable with JavaScript off or a library failing to load. Add a CDN library (pinned version, defer) only when the page really uses it.",
      "Honest content: specific copy for this business, never lorem ipsum, but nothing invented and presented as fact: no made-up awards, client counts, testimonials, addresses, phone numbers, opening hours or claims (\"organic\", \"since 1990\"). What you weren't told goes in [square brackets], and your final answer lists those for the user to fill in.",
      "Performance: width/height on images, loading=\"lazy\" below the fold, no layout shift from late-loading fonts or media.",
    ],
  },
  {
    id: "react",
    title: "React / Next.js app",
    kind: "stack",
    task: /\b(react(?![- ]?native)|next\.?js|jsx|tsx|component|hook)\b/i,
    files: /(^|\/)(next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|src\/App\.[jt]sx)$/,
    rules: [
      "Function components and hooks; one component per file, named like the file; colocate its test and styles.",
      "Follow the structure that is there (app/ or pages/, src/components, src/hooks, src/lib); don't introduce a second pattern for state, data fetching or styling.",
      "Type props and return values in TypeScript projects; no `any`; derive state instead of duplicating it; effects only for syncing with something outside React.",
      "Handle loading, empty and error states for anything asynchronous; keys on lists are stable ids, not indexes.",
      "Accessible by default: semantic elements, labels, keyboard operable, focus managed for dialogs and route changes.",
    ],
  },
  {
    id: "react-native",
    title: "React Native / Expo app",
    kind: "stack",
    task: /\b(react[- ]native|expo|eas|mobile app|ios (and|&) android|android (and|&) ios|ios app|android app|app for (ios|android|iphone|phones?)|mobiln\w* aplikacij\w*|aplikacij\w* za (ios|android|iphone|telefon\w*|mobitel\w*))\b/i,
    files: /(^|\/)(app\.json|app\.config\.[jt]s|metro\.config\.[cm]?js|eas\.json)$/,
    rules: [
      "Know the project before changing it. Expo with prebuild (app.json or app.config, no hand-kept ios/ and android/): native settings go through app config and config plugins, never by editing generated native folders. Bare React Native: ios/ and android/ are source, change them natively. Read the React Native, Expo and library versions from package.json and check search_docs for those versions; React Native 0.82 and later run only the New Architecture, so a library must support it before you add it.",
      "Only in an empty folder: a new app starts in two steps, before any screen is written (in a folder that already has the app, never run create-expo-app or app_kit again; change the existing app): 1. run_command `npx create-expo-app@latest . --template default` in the empty project folder (current SDK, versions and layout; never write package.json or the template by hand), 2. call app_kit with the app's name, bundle identifier and main features: it adds the architecture (API client, server state, tokens, UI primitives, feature folders, EAS profiles) and tells you what to install and wire. Then build each feature inside its folder. If the project has an AGENTS.md, read it first and follow it: Expo's own states what changed in the installed SDK.",
      "Structure: follow what is there. In a new app: routes in app/ with Expo Router (groups such as (tabs) and (auth), a _layout per group), each feature in src/features/<name>/ with its components, hooks, api and store, shared UI in src/components/ui, design tokens in src/theme, clients and helpers in src/lib. Screens stay thin: they compose components and call hooks; logic and data access live in hooks.",
      "TypeScript strict, no any; typed route params; validate what comes from the network or storage at the boundary (zod or the project's schema library) so the rest of the app can trust its types.",
      "State by kind. Server data: TanStack Query (or what the project uses), never copied into a global store. Screen state: local. Cross-screen client state: a small Zustand store or context, read through selectors. Persisted preferences: MMKV or AsyncStorage. Tokens and other secrets: only expo-secure-store or the Keychain/Keystore.",
      "Performance: long lists are FlatList or FlashList with keyExtractor, a stable renderItem and item components that don't re-render with the list; images through expo-image with explicit sizes; animations with Reanimated so they run off the JS thread; nothing heavy in render; measure before adding memo.",
      "Every screen works on both platforms: safe areas, the keyboard never covering inputs, the Android back gesture, edge-to-edge on Android, dark mode, larger system font sizes, touch targets of at least 44pt/48dp, accessibilityRole and accessibilityLabel on controls, loading, empty and error states.",
      "Native capabilities: ask for a permission at the moment it is needed, with the purpose string set in app config (iOS usage descriptions, Android permissions), and handle denied and limited access. Push notifications, deep and universal links, in-app purchases and most native modules need a development build, not Expo Go: say so when you add one.",
      "Networking: one API client with the base URL from environment config (EXPO_PUBLIC_ variables are public: no secrets in them or anywhere in the bundle), timeouts, token refresh and errors mapped to messages a user can act on. Offline: cached queries, optimistic updates that roll back, and a visible offline state.",
      "Checks before you finish: tsc, eslint and the tests (Jest with React Native Testing Library for logic and components; Maestro or Detox flows where the project has them); in Expo projects npx expo-doctor and npx expo install --check. After a native dependency or config change, say that a new development build is needed.",
      "Production hygiene: an error boundary around each route group, crash reporting with source maps where the project has it, no console logging of personal data, and over-the-air updates only for changes that don't touch native code (keep runtimeVersion right).",
    ],
  },
  {
    id: "ios-native",
    title: "Native iOS (Swift)",
    kind: "stack",
    task: /\b(swift|swiftui|uikit|xcode|ios native|native ios|iphone app|ipad app|watchos|app clip|widgetkit)\b/i,
    files: /(^|\/)(Package\.swift|[^/]+\.xcodeproj\/project\.pbxproj|[^/]+App\.swift)$/,
    rules: [
      "Follow the project's UI framework and architecture. New UI in SwiftUI with state in @Observable view models (or what the project uses); UIKit where it already is. One type per file, grouped by feature.",
      "Modern Swift: async/await and structured concurrency, actors or @MainActor for shared state, no force unwraps or try! outside tests, value types by default, errors thrown and handled, not ignored.",
      "Dependencies through Swift Package Manager unless the project uses CocoaPods; persistence with what is there (SwiftData, Core Data, files); secrets in the Keychain, never UserDefaults or the bundle.",
      "Human Interface Guidelines: standard navigation and controls, Dynamic Type, dark mode, safe areas, 44pt touch targets, VoiceOver labels and traits, sensible behaviour on iPad and in landscape when the app supports them.",
      "Capabilities are three things that must agree: the entitlement, the App ID capability and the Info.plist key. Every protected resource needs its usage description; APIs on Apple's required-reason list and third-party SDKs need a privacy manifest (PrivacyInfo.xcprivacy).",
      "Build settings per environment through schemes and xcconfig files, not edits to project.pbxproj by hand; bundle identifier, version (CFBundleShortVersionString) and build number (CFBundleVersion) changed in one place.",
      "Test with XCTest or Swift Testing; build and test from the command line with xcodebuild (-scheme, -destination) so it also runs in CI; use xcrun simctl for simulators. Say which scheme and destination you used.",
    ],
  },
  {
    id: "android-native",
    title: "Native Android (Kotlin)",
    kind: "stack",
    task: /\b(kotlin|jetpack|compose|android studio|android native|native android|gradle|wear os)\b/i,
    files: /(^|\/)(settings\.gradle(\.kts)?|AndroidManifest\.xml)$/,
    rules: [
      "Follow the project's UI toolkit and architecture. New UI in Jetpack Compose with Material 3; one activity; screens get state from a ViewModel as StateFlow collected with the lifecycle (collectAsStateWithLifecycle); dependency injection with what is there (Hilt, Koin).",
      "Kotlin coroutines and Flow with the right scope and dispatcher; no blocking the main thread, no GlobalScope; background work that must finish goes to WorkManager; persistence with Room or DataStore; secrets in the Keystore.",
      "Gradle: Kotlin DSL and the version catalog (libs.versions.toml) when the project has them; compileSdk, targetSdk and minSdk in one place; release builds minified with R8 and keep rules for anything used by reflection.",
      "Platform behaviour by API level: runtime permissions (notifications from Android 13, the photo picker instead of broad storage access), foreground service types, edge-to-edge and predictive back on recent versions, and native libraries built for 16 KB memory pages.",
      "Material and accessibility: 48dp touch targets, contentDescription on meaningful images and icon buttons, dark theme, font scaling, window insets handled, layouts that hold on small phones, tablets and foldables.",
      "Variants: build types and product flavors for environments, never constants edited by hand; versionCode and versionName set in one place; signing configuration read from properties kept outside the repository.",
      "Test with JUnit (and Turbine for flows), Compose UI tests or Espresso for screens; build and test with ./gradlew (assembleDebug, testDebugUnitTest, lint); use adb for devices. Say which variant you built.",
    ],
  },
  {
    id: "node",
    title: "Node.js service, API or CLI",
    kind: "stack",
    task: /\b(api|endpoint|server|express|fastify|nestjs|cli|node\.?js|backend)\b/i,
    files: /(^|\/)(server|app)\.[cm]?[jt]s$/,
    rules: [
      "Keep the layers the project has (routes/handlers → services → data access); validate every external input at the edge with the project's schema library.",
      "Errors: fail loudly with a typed or coded error, never swallow; HTTP handlers return the right status and a consistent error body; no stack traces to clients.",
      "Configuration from environment variables read in one place; never hard-code secrets, never log them; document a new variable in .env.example.",
      "Parameterised queries only; timeouts on outbound calls; async code awaited (no floating promises).",
      "A test for each new behaviour and each fixed bug, next to the existing tests and in their style.",
    ],
  },
  {
    id: "wordpress",
    title: "WordPress plugin or theme (and WooCommerce)",
    kind: "stack",
    task: /\b(wordpress|woocommerce|wp[- ]?(plugin|theme)|shortcode|gutenberg)\b/i,
    files: /(^|\/)(functions\.php|readme\.txt|wp-config\.php)$/,
    rules: [
      "Prefix every function, class, hook, option and handle with the plugin's prefix; guard files with defined( 'ABSPATH' ) || exit.",
      "Security on every path: sanitize input (sanitize_text_field, absint…), escape output late (esc_html, esc_attr, esc_url, wp_kses_post), nonces plus current_user_can() for forms, AJAX and REST.",
      "Use the APIs, not raw SQL or direct file access: $wpdb->prepare() when a query is unavoidable, wp_enqueue_script/style for assets, the Settings and REST APIs, WC CRUD objects (wc_get_order, $product->get_price()) instead of post meta.",
      "Hook in, don't edit core, WooCommerce or parent-theme files; make strings translatable with the plugin's text domain; follow the WordPress Coding Standards (tabs, Yoda conditions, snake_case).",
      "Declare what it needs in the plugin header (Requires at least, Requires PHP, WC requires at least) and clean up in uninstall.php when it stores data.",
    ],
  },
  {
    id: "python",
    title: "Python project",
    kind: "stack",
    task: /\b(python|django|flask|fastapi|pytest|pandas)\b/i,
    files: /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py|manage\.py)$/,
    rules: [
      "Follow PEP 8 and the project's formatter and linter settings; type hints on public functions; f-strings.",
      "Dependencies go in the project's manifest (pyproject.toml or requirements.txt), not ad-hoc pip installs; use its virtual environment and task runner.",
      "Tests with the project's runner (pytest unless it uses another), next to existing tests; no network or real clock in unit tests.",
      "Raise specific exceptions; no bare except; context managers for files and connections.",
    ],
  },
  {
    id: "mobile-release",
    title: "Building, signing and publishing a mobile app",
    kind: "work",
    task: /\b(app ?store|play ?store|google play|testflight|eas (build|submit|update)|fastlane|provisioning( profile)?|keystore|code ?signing|signing (config|certificate)|\.?aab|\.?ipa|store listing|data safety|app privacy|(submit|publish|release|ship|upload|deploy)\w* (it |this |the |my |our |a |an )?(new )?(app|build|version|update)|objav\w* (aplikacij\w*|app))\b/i,
    rules: [
      "Find the release pipeline the project already has and extend it, don't add a second one: eas.json means EAS Build and Submit; a fastlane/ folder means Fastlane lanes; neither means Xcode archive and Gradle bundle by hand or in CI. Read its config before proposing commands.",
      "Versions: the user-facing version (semver) and the build number (iOS CFBundleVersion, Android versionCode). Every upload needs a higher build number; let the pipeline increment it (EAS autoIncrement or a remote version source, a Fastlane action) and keep the runtime version right when over-the-air updates are used.",
      "iOS signing: bundle identifier, team, a distribution certificate and an App Store provisioning profile, managed by EAS or fastlane match or Xcode's automatic signing. Capabilities (push, associated domains, Sign in with Apple, App Groups) must match the entitlements. Certificates, .p8 keys and profiles never go in the repository.",
      "Android signing: an upload keystore kept outside the repository and backed up, Play App Signing on, an Android App Bundle (.aab) for Play, signing configuration read from properties or CI secrets.",
      "Commands. EAS: eas build --platform ios|android --profile production, then eas submit; secrets as EAS environment variables. Fastlane: lanes built on gym or build_app with pilot or deliver for iOS, gradle with supply for Android. By hand: xcodebuild archive and -exportArchive then Transporter; ./gradlew bundleRelease then Play Console. Show the exact commands and what each needs.",
      "Store rules change every year. As of November 2026 Google Play accepts new apps and updates only when they target Android 16 (API level 36), and App Store Connect only builds made with Xcode 26 and the iOS 26 SDK. Before a submission, check the current requirement on the official Google Play and Apple pages (web_search, then the official page) and say when you checked.",
      "Compliance the stores check: a privacy policy URL; App Privacy answers and the Play Data safety form that match what the app and its SDKs really collect; a privacy manifest; purpose strings for every permission; in-app account deletion when the app has accounts; Sign in with Apple beside other third-party sign-in; StoreKit or Play Billing for digital goods; age and content rating; the export compliance answer; review notes with a demo account.",
      "Roll out in steps: TestFlight internal then external testers; Play internal, closed, then production with a staged percentage (new personal Play accounts must complete a closed test first: check the current rule); phased release on iOS. Watch crashes and reviews and know how to halt the rollout. Fix JavaScript-only problems with an over-the-air update, native ones with a new build.",
      "Before uploading, test the release build itself on real devices on both platforms: no development menu or logs, minification and Hermes fine, deep links and push working against production, icons and splash right, app size reasonable.",
      "You prepare; the user publishes. Never ask for or type an Apple ID, Play credentials, keystore passwords or API keys. Uploading to a store, changing a store listing or releasing to users is the user's decision each time: give the command and the checklist, and run it only when they tell you to.",
    ],
  },
  {
    id: "bug-fix",
    title: "Fixing a bug",
    kind: "work",
    task: /\b(bug|fix|fails?|failing|broken|error|crash(es)?|doesn'?t work|not working|wrong|regression|ne radi|gre[sš]k[au])\b/i,
    rules: [
      "Reproduce first: run the failing check or write a test that fails because of the bug, and read the actual error before changing code.",
      "Find the cause, not the symptom: fix where the wrong value is produced, and look for the same mistake in sibling code.",
      "The smallest change that fixes it; no unrelated refactoring or formatting in the same change.",
      "Done means the new test passes, the old ones still pass, and the answer says what the cause was.",
    ],
  },
  {
    id: "feature",
    title: "Adding a feature",
    kind: "work",
    task: /\b(add|implement|create|build|new|support|make|dodaj|napravi|kreiraj)\b/i,
    rules: [
      "Read how a similar feature is built here and follow it: same folders, naming, error handling and test style.",
      "Cover the unhappy paths: empty, missing, invalid and very large input; loading and error states in UI.",
      "A test for each new behaviour; update the README or docs the feature makes out of date.",
      "No new runtime dependency when the platform or an existing dependency does the job; if one is needed, say why.",
    ],
  },
  {
    id: "refactor",
    title: "Refactoring",
    kind: "work",
    task: /\b(refactor|clean ?up|restructure|rename|extract|simplify|reorgani[sz]e|split)\b/i,
    rules: [
      "Behaviour stays the same: run the checks before starting and after every step; if there are no tests around the code, add characterisation tests first.",
      "Find every use (find_references) before changing a signature or moving something; update them in the same step.",
      "Small mechanical steps, one kind of change at a time; no feature changes or bug fixes mixed in (report bugs you find instead).",
    ],
  },
  {
    id: "seo",
    title: "Search engine optimisation",
    kind: "work",
    task: /\b(seo|search engine|keywords?|rank(ing|s)?|google search|serp|meta tags?|sitemap|schema\.org|structured data)\b/i,
    rules: [
      "Start from intent: name the two or three searches this page should answer (\"bakery in [city]\", \"custom cakes [city]\") and who is searching. If you can search the web, look at what currently ranks for them and what those pages cover; otherwise state the phrases as assumptions.",
      "One page, one topic. The main phrase appears naturally in the <title> (under 60 characters, phrase first, brand last), the h1, the first paragraph, one h2 and the URL; related phrases in other headings. Never repeat phrases unnaturally or hide text.",
      "Answer the searcher: cover the questions people ask about this topic (prices, how it works, where, when), with a questions-and-answers section where it fits. Content written for the reader ranks; filler doesn't.",
      "Technical basics on every page: a unique meta description (120 to 155 characters, a reason to click), canonical URL, Open Graph and Twitter card tags with an image, lang on <html>, headings in order, descriptive link text, alt text that describes the picture.",
      "Structured data as JSON-LD: LocalBusiness (name, address, phone, opening hours, geo) for a business with premises, Organization or Person otherwise, FAQPage for a real questions section, Product or Service with prices where shown. Only facts that are on the page.",
      "Local businesses: the same name, address and phone on the page and in the JSON-LD as on their Google Business Profile; a map link; the city and neighbourhood in the copy.",
      "Speed is ranking: images sized, compressed and lazy-loaded below the fold, fonts with display=swap, scripts deferred, no layout shift. A site with several pages also gets sitemap.xml and robots.txt.",
      "When the user asks for a strategy rather than a page, deliver a document: goals and audience, the keyword map (phrase, intent, target page), the pages to create or fix in priority order, technical fixes, a content plan, links and local listings to earn, and what to measure (Search Console clicks, impressions, position). Mark every number you didn't measure as an estimate.",
    ],
  },
];

/** At most one stack and one kind-of-work playbook for a task, the project's own stack first. */
export function pickPlaybooks(task: string, files: readonly string[], all: readonly Playbook[] = PLAYBOOKS): Playbook[] {
  const byTask = (p: Playbook) => !!p.task && p.task.test(task);
  const byFiles = (p: Playbook) => !!p.files && files.some((f) => p.files!.test(f));
  const stacks = all.filter((p) => p.kind === "stack");
  // What the task names wins; otherwise what the project is.
  const stack = stacks.find(byTask) ?? stacks.find(byFiles);
  // Specific kinds of work before the catch-all "feature".
  const works = all.filter((p) => p.kind === "work");
  const work = works.filter((p) => p.id !== "feature").find(byTask) ?? works.find((p) => p.id === "feature" && byTask(p));
  return [stack, work].filter((p): p is Playbook => !!p);
}

export function renderPlaybooks(picked: readonly Playbook[]): string {
  return picked.map((p) => `${p.title}:\n${p.rules.map((r) => `- ${r}`).join("\n")}`).join("\n\n");
}

// Whether a request asks for something new to be built. The loop runs Expo's generator or the
// page builder on its own for these, so the test has to be strict: a question about apps, a blog
// post about one or an API for one must not start a project.
const ASKS = /^\s*(how|what|why|when|where|which|who|whose|is|are|was|does|do|did|should|would|explain|describe|tell me|compare|review|kako|[sš]ta|[sš]to|za[sš]to|koji|koja|koje|kada|gdje|da li|objasni|opi[sš]i|uporedi)\b/i;
const POLITE = /^\s*(can|could|will|would) you\b|^\s*(mo[zž]e[sš] li|ho[cć]e[sš] li|mo[zž]e li)\b/i;
const MAKE = "(?:build|make|create|develop|design|generate|scaffold|start|set up|write|code|need|want|napravi\\w*|izradi\\w*|kreiraj\\w*|razvij\\w*|dizajniraj\\w*|treba mi|trebam)";
const FILLER = "(?:(?:me|us|a|an|the|my|our|new|simple|small|nice|modern|quick|basic|complete|full|whole|one|single|mobile|native|cross[- ]platform|ios|android|iphone|react[- ]native|expo|and|or|for|responsive|static|landing|web|one[- ]page|mobiln\\w*|nov\\w*|jednostavn\\w*|mal\\w*|modern\\w*|jedn\\w*)[\\s,&]+){0,7}";
const NEW_APP = new RegExp(`\\b${MAKE}\\s+${FILLER}(?:app|application|aplikacij\\w*)\\b(?!\\s+(?:icon|icons|store|logo|screenshots?|name|idea|backend|server|api|review|listing|ikon\\w*)\\b)`, "i");
const NEW_PAGE = new RegExp(`\\b${MAKE}\\s+${FILLER}(?:landing ?page|web ?page|website|web ?site|homepage|home page|page|site|portfolio|sajt\\w*|stranic\\w*)\\b`, "i");
const isRequest = (task: string) => !ASKS.test(task) || POLITE.test(task);

/** "Build a mobile app for …", not "how do I build an app?" or "write a post about our app". */
export const wantsNewApp = (task: string) => isRequest(task) && NEW_APP.test(task);
/** "Make a landing page for …", not "what makes a good landing page?". */
export const wantsNewPage = (task: string) => isRequest(task) && NEW_PAGE.test(task);
