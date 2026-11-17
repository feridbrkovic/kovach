import type { Migration } from "@kovach-dev/memory-service";

// The SQL is embedded at build time, so a bundled app never looks for files next to itself.
const files = import.meta.glob("../../../../packages/memory-service/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const MIGRATIONS: Migration[] = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));
