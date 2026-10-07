import { aiClientFor } from "./ai/client.js";
import { createApp } from "./app.js";
import { AdapterRegistry } from "./channels/registry.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { loadDotEnv } from "./env.js";
import { startJobs } from "./jobs/boss.js";

loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
const registry = new AdapterRegistry(config);
const ai = aiClientFor(handle.db, config.anthropicApiKey);
const app = createApp({ config, db: handle.db, registry, ai });

const server = app.listen(config.port, () => {
  const mocks = Object.entries(config.mock)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log(
    `MarketingBrain listening on ${config.publicBaseUrl} (${config.env}, auth=${config.auth.mode}, mocked: ${mocks.join(", ") || "none"})`,
  );
});

const boss = config.jobsEnabled ? await startJobs(config.databaseUrl, handle.db, registry, ai) : null;
if (boss) console.log("[jobs] scheduler running");

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  if (boss) await boss.stop({ graceful: true, timeout: 5000 });
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
