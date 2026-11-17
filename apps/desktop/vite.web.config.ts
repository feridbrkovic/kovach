import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { workspaceAliases } from "./workspace-aliases";

/** The renderer alone in a browser, running on the mock MemoryApi with demo data. */
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  resolve: { alias: workspaceAliases },
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./out/web", import.meta.url)), emptyOutDir: true },
});
