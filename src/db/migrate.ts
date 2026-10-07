import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDotEnv } from "../env.js";
import { createDb } from "./client.js";

// Applies drizzle/ migrations in order. Used by tests (fresh database every
// run), by local dev, and later by the deploy. Read the SQL before you
// commit a new migration; this script runs whatever is there.
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString);
  try {
    await migrate(handle.db, { migrationsFolder: "./drizzle" });
  } finally {
    await handle.close();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/migrate.ts");
if (invokedDirectly) {
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log("migrations applied");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
