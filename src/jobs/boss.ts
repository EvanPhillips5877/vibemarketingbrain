import PgBoss from "pg-boss";

// pg-boss keeps its queue in the same Postgres (schema "pgboss"). Phase 1
// registers one job so the wiring is proven; ingestion, detectors and the
// morning analysis plug in here in later phases.
export async function startJobs(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (err) => console.error("[jobs]", err));
  await boss.start();

  await boss.createQueue("heartbeat");
  await boss.schedule("heartbeat", "*/5 * * * *", {}, { tz: "America/Toronto" });
  await boss.work("heartbeat", async () => {
    console.log(`[jobs] heartbeat ${new Date().toISOString()}`);
  });

  return boss;
}
