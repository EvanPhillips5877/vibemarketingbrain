import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadDotEnv } from "../src/env.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { isoDay, syncMetrics } from "../src/ingest/metrics.js";
import { syncStructure } from "../src/ingest/structure.js";

// pnpm run seed — safe to re-run. Seeds the brand and, outside production,
// a mock ad account with 28 days of pretend performance so every screen has
// something to show.
loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
try {
  const r = await seedTryoutBrain(handle.db, "manual:seed-script");
  console.log(
    `TryoutBrain ${r.brandId}: ${r.factsInserted} fact(s) inserted, policy v${r.policyVersion}${r.policyInserted ? " created" : " already present"}`,
  );
  if (!config.isProduction) {
    const account = await seedMockChannelAccount(handle.db, r.brandId);
    const adapter = new AdapterRegistry(config).get("mock")!;
    const s = await syncStructure(handle.db, adapter, account);
    const m = await syncMetrics(handle.db, adapter, account, isoDay(28), isoDay(1));
    console.log(`mock account ${account.externalAccountId}: ${s.seen} objects (${s.inserted} new), ${m.rows} metric rows`);
  }
} finally {
  await handle.close();
}
