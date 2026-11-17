import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the contract from source so tests run without building it first.
export default defineConfig({
  resolve: {
    alias: {
      "@kovach-dev/memory-contract": fileURLToPath(new URL("../memory-contract/src/index.ts", import.meta.url)),
    },
  },
});
