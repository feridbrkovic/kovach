import { fileURLToPath } from "node:url";

const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Resolve workspace packages from source, so nothing needs building first. */
export const workspaceAliases = [
  { find: /^@kovach-dev\/memory-contract\/mock$/, replacement: src("../../packages/memory-contract/src/mock.ts") },
  { find: /^@kovach-dev\/memory-contract$/, replacement: src("../../packages/memory-contract/src/index.ts") },
  { find: /^@kovach-dev\/memory-service$/, replacement: src("../../packages/memory-service/src/index.ts") },
  { find: /^@kovach-dev\/agent$/, replacement: src("../../packages/agent/src/index.ts") },
];
