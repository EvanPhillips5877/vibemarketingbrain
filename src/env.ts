import { existsSync } from "node:fs";
import path from "node:path";

// Loads a .env file into process.env for local runs. Variables already in
// the environment win, so CI and production (where the file never exists)
// are unaffected. Node's own loader, no dependency.
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): boolean {
  if (!existsSync(file)) return false;
  const before = { ...process.env };
  process.loadEnvFile(file);
  // process.loadEnvFile does not override on some Node versions and does on
  // others; make the rule explicit: the real environment always wins.
  for (const [k, v] of Object.entries(before)) {
    if (v !== undefined) process.env[k] = v;
  }
  return true;
}
