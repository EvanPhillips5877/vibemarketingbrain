import { execSync } from "node:child_process";
import { runMigrations } from "../src/db/migrate.js";

/** Fresh test database every run, migrated the same way production will be. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:5432/marketingbrain_test";
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = "test";
  process.env.APP_SECRET = "test-suite-secret-0123456789";
  process.env.PUBLIC_BASE_URL = "http://localhost:5100";
  process.env.ALLOWED_EMAILS = "evan@example.com, Second@Example.com";
  process.env.JOBS_ENABLED = "false";
  for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ANTHROPIC_API_KEY", "META_ACCESS_TOKEN", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_REFRESH_TOKEN"]) {
    delete process.env[k];
  }

  const dbName = new URL(url).pathname.slice(1);
  const admin = url.replace(`/${dbName}`, "/postgres");
  try {
    // -d with the URI: a bare positional URI makes psql ignore -c on Windows.
    execSync(`psql -d "${admin}" -q -c "DROP DATABASE IF EXISTS ${dbName};"`, { stdio: "pipe" });
    execSync(`psql -d "${admin}" -q -c "CREATE DATABASE ${dbName};"`, { stdio: "pipe" });
  } catch (e) {
    console.error("Could not (re)create the test database. Is Postgres running and psql on PATH?");
    throw e;
  }
  await runMigrations(url);
}
