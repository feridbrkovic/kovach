import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { workspaceAliases } from "./workspace-aliases";

// Workspace packages are bundled from source; npm dependencies (better-sqlite3,
// sqlite-vec) stay external because they load native code at runtime.
const bundleWorkspace = { exclude: ["@kovach-dev/memory-contract", "@kovach-dev/memory-service", "@kovach-dev/agent"] };

export default defineConfig({
  main: {
    resolve: { alias: workspaceAliases },
    build: { externalizeDeps: bundleWorkspace },
  },
  preload: {
    resolve: { alias: workspaceAliases },
    build: {
      externalizeDeps: bundleWorkspace,
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
    resolve: { alias: workspaceAliases },
    plugins: [react()],
  },
});
