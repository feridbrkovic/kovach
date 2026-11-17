// Apply all migrations to a fresh in-memory database and print the tables.
import { migrate, openDatabase } from "../src/index.js";

const db = openDatabase(":memory:");
const { applied } = migrate(db);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];

console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
console.log(`Tables: ${tables.map((t) => t.name).join(", ")}`);
db.close();
