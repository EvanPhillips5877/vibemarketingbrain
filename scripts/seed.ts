import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { loadDotEnv } from "../src/env.js";
import { seedMetaChannelAccount, seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { accountRef } from "../src/ingest/structure.js";
import { MetaAdapter } from "../src/channels/meta/index.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { isoDay, syncMetrics } from "../src/ingest/metrics.js";
import { syncStructure } from "../src/ingest/structure.js";

// pnpm run seed — safe to re-run. Seeds the brand and, outside production,
// a mock ad account with 28 days of pretend performance so every screen has
// something to show. In production the mock account is opt-in:
// SEED_MOCK_ACCOUNT=true adds it (clearly labelled "mock" on every screen)
// until real ad accounts exist.
loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
try {
  const r = await seedTryoutBrain(handle.db, "manual:seed-script");
  console.log(
    `TryoutBrain ${r.brandId}: ${r.factsInserted} fact(s) inserted, policy v${r.policyVersion}${r.policyInserted ? " created" : " already present"}`,
  );
  // The real Meta account, when its id and token are configured: the row
  // records currency and timezone as the platform states them, then the
  // first structure sync mirrors whatever the account already holds.
  if (config.meta.adAccountId && !config.mock.meta) {
    const meta = new MetaAdapter({ version: config.meta.apiVersion });
    const probe = { id: "probe", channel: "meta" as const, externalAccountId: config.meta.adAccountId, currency: "CAD", timezone: "America/Toronto", secretRef: "META_ACCESS_TOKEN" };
    const described = await meta.describeAccount(probe);
    const account = await seedMetaChannelAccount(handle.db, r.brandId, config.meta.adAccountId, { currency: described.currency, timezone: described.timezone });
    const s = await syncStructure(handle.db, meta, account);
    console.log(`meta account ${account.externalAccountId} (${described.name}, ${described.currency}, ${described.timezone}): ${s.seen} objects (${s.inserted} new)`);
    void accountRef;
  }
  const wantMock = !config.isProduction || process.env["SEED_MOCK_ACCOUNT"] === "true";
  if (!wantMock) {
    console.log("production: no mock ad account (set SEED_MOCK_ACCOUNT=true to add one)");
  } else {
    const account = await seedMockChannelAccount(handle.db, r.brandId);
    const adapter = new AdapterRegistry(config).get("mock")!;
    const s = await syncStructure(handle.db, adapter, account);
    const m = await syncMetrics(handle.db, adapter, account, isoDay(28), isoDay(1));
    console.log(`mock account ${account.externalAccountId}: ${s.seen} objects (${s.inserted} new), ${m.rows} metric rows`);
  }
} finally {
  await handle.close();
}
