import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadDotEnv } from "../src/env.js";
import { seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";

// pnpm run seed — safe to re-run.
loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
try {
  const r = await seedTryoutBrain(handle.db, "manual:seed-script");
  console.log(
    `TryoutBrain ${r.brandId}: ${r.factsInserted} fact(s) inserted, policy v${r.policyVersion}${r.policyInserted ? " created" : " already present"}`,
  );
} finally {
  await handle.close();
}
