import { defineConfig } from "vitest/config";
import { workspaceAliases } from "./workspace-aliases";

export default defineConfig({
  // TSX compiles with the automatic JSX runtime; the React plugin is only needed for the app build.
  esbuild: { jsx: "automatic" },
  resolve: { alias: workspaceAliases },
  test: { include: ["test/**/*.test.{ts,tsx}"] },
});
