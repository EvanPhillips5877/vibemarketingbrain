import PgBoss from "pg-boss";
import type { AdapterRegistry } from "../channels/registry.js";
import type { Db } from "../db/client.js";
import { syncAllBrands } from "../ingest/sync.js";

// pg-boss keeps its queue in the same Postgres (schema "pgboss"). Every job
// is a singleton per schedule: a slow run never overlaps the next one.
// Ingestion only, so far; detectors and the morning analysis plug in here
// in Phase 10, and nothing here can spend money.
const TZ = "America/Toronto";

export async function startJobs(connectionString: string, db: Db, registry: AdapterRegistry): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (err) => console.error("[jobs]", err));
  await boss.start();

  const schedule = async (name: string, cron: string, run: () => Promise<unknown>) => {
    await boss.createQueue(name);
    await boss.schedule(name, cron, {}, { tz: TZ, singletonKey: name });
    await boss.work(name, async () => {
      const started = Date.now();
      try {
        const result = await run();
        console.log(`[jobs] ${name} ok in ${Date.now() - started}ms`, JSON.stringify(result).slice(0, 400));
      } catch (err) {
        console.error(`[jobs] ${name} failed:`, err instanceof Error ? err.message : err);
        throw err; // let pg-boss record the failure and retry per its policy
      }
    });
  };

  await schedule("heartbeat", "*/5 * * * *", async () => ({ at: new Date().toISOString() }));
  // Morning pull: trailing 7 days restated; the brand funnel; attribution.
  await schedule("sync-morning", "0 6 * * *", () => syncAllBrands(db, registry, { metricDays: 7, actor: "system:sync-morning" }));
  // Through the day: today's pacing plus any new sign-ups, hourly.
  await schedule("sync-hourly", "15 7-23 * * *", () => syncAllBrands(db, registry, { metricDays: 1, actor: "system:sync-hourly" }));
  // Weekly: platforms restate up to four weeks back.
  await schedule("sync-weekly", "30 5 * * 1", () => syncAllBrands(db, registry, { metricDays: 28, actor: "system:sync-weekly" }));

  return boss;
}
