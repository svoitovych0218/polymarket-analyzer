import { initDb } from "./db/schema";

function main(): void {
  const db = initDb();
  console.log("Database initialised successfully.");

  // Verify all three tables exist
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];

  console.log("Tables:", tables.map((t) => t.name).join(", "));
}

main();
