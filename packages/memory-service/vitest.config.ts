import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve workspace packages from source so tests run without building them first.
const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kovach-dev/memory-contract": src("../memory-contract/src/index.ts"),
      "@kovach-dev/agent-fixtures": src("../agent-fixtures/src/index.ts"),
    },
  },
});
