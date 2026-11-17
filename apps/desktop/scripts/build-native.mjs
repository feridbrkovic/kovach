#!/usr/bin/env node
/**
 * Make sure the Electron binary is downloaded, then put a better-sqlite3 binary built for this Electron version at
 * native/better_sqlite3.node. The app loads it through better-sqlite3's
 * `nativeBinding` option, so the Node build in node_modules stays as it is
 * for tests and scripts.
 *
 * Tries the prebuilt binary first (fast, no compiler), then compiles with
 * @electron/rebuild (needs the Xcode command line tools on macOS).
 *
 *   node scripts/build-native.mjs              # (re)build
 *   node scripts/build-native.mjs --if-missing # skip when already built for this Electron
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const outDir = join(appDir, "native");
const outFile = join(outDir, "better_sqlite3.node");
const stampFile = join(outDir, "better_sqlite3.json");

const require = createRequire(join(appDir, "package.json"));
const electronVersion = require("electron/package.json").version;

// Recent Electron packages no longer download their binary on install, so
// fetch it here the first time.
const electronDir = dirname(require.resolve("electron/package.json"));
if (!existsSync(join(electronDir, "path.txt"))) {
  console.log(`Downloading Electron ${electronVersion}`);
  execFileSync(process.execPath, [join(electronDir, "install.js")], { cwd: electronDir, stdio: "inherit" });
}
const sqlitePkgPath = require.resolve("better-sqlite3/package.json");
const sqliteDir = dirname(sqlitePkgPath);
const sqliteVersion = JSON.parse(readFileSync(sqlitePkgPath, "utf8")).version;
const target = { electron: electronVersion, betterSqlite3: sqliteVersion, platform: process.platform, arch: process.arch };

if (process.argv.includes("--if-missing") && existsSync(outFile) && existsSync(stampFile)) {
  const stamp = JSON.parse(readFileSync(stampFile, "utf8"));
  if (JSON.stringify(stamp) === JSON.stringify(target)) process.exit(0);
}

console.log(`Building better-sqlite3 ${sqliteVersion} for Electron ${electronVersion} (${process.platform}-${process.arch})`);

// Work on a copy so the Node build in node_modules is never touched.
const work = mkdtempSync(join(tmpdir(), "kovach-native-"));
const pkgCopy = join(work, "node_modules", "better-sqlite3");
cpSync(sqliteDir, pkgCopy, {
  recursive: true,
  dereference: true,
  filter: (src) => !src.includes(`${join(sqliteDir, "build")}`),
});
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "kovach-native", private: true, dependencies: { "better-sqlite3": sqliteVersion } }));

const built = join(pkgCopy, "build", "Release", "better_sqlite3.node");

function tryPrebuilt() {
  try {
    const sqliteRequire = createRequire(sqlitePkgPath);
    const bin = sqliteRequire.resolve("prebuild-install/bin.js");
    execFileSync(process.execPath, [bin, "--runtime", "electron", "--target", electronVersion, "--arch", process.arch, "--platform", process.platform], {
      cwd: pkgCopy,
      stdio: "inherit",
    });
    return existsSync(built);
  } catch (err) {
    console.warn(`Prebuilt binary not available: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function compile() {
  const { rebuild } = await import("@electron/rebuild");
  await rebuild({ buildPath: work, electronVersion, arch: process.arch, onlyModules: ["better-sqlite3"], force: true });
  return existsSync(built);
}

try {
  if (!tryPrebuilt() && !(await compile())) throw new Error("no binary was produced");
  mkdirSync(outDir, { recursive: true });
  cpSync(built, outFile);
  writeFileSync(stampFile, `${JSON.stringify(target, null, 2)}\n`);
  console.log(`Wrote ${outFile}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
