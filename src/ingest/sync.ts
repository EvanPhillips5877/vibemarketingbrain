import { eq } from "drizzle-orm";
import type { AdapterRegistry } from "../channels/registry.js";
import type { Db } from "../db/client.js";
import { auditEvents, brands, channelAccounts, type Brand } from "../db/schema.js";
import { attributeCustomerEvents, resetUnattributed } from "./attribute.js";
import { pullCustomerEvents, sourceFor } from "./customerEvents.js";
import { isoDay, syncMetrics } from "./metrics.js";
import { syncStructure } from "./structure.js";

// The whole read side for one brand, in the order the pieces depend on
// each other: structure, then metrics (which need the objects), then the
// brand's own funnel, then attribution (which needs both). Used by the
// scheduled jobs and by the manual "sync now" button.

export interface BrandSyncReport {
  brand: string;
  accounts: { channel: string; isMock: boolean; objects: number; metricRows: number }[];
  events: { isMock: boolean; rowsSeen: number; rowsRejected: number; eventsUpserted: number };
  attribution: { decided: number; byMethod: Record<string, number> };
}

export async function syncBrand(
  db: Db,
  registry: AdapterRegistry,
  brand: Brand,
  opts: { metricDays?: number; actor?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<BrandSyncReport> {
  const metricDays = opts.metricDays ?? 7;
  const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.brandId, brand.id));
  const accountReports: BrandSyncReport["accounts"] = [];
  for (const account of accounts) {
    if (account.status !== "active") continue;
    const adapter = registry.get(account.channel);
    if (!adapter) continue;
    const s = await syncStructure(db, adapter, account);
    const m = await syncMetrics(db, adapter, account, isoDay(metricDays), isoDay(0));
    accountReports.push({ channel: account.channel, isMock: adapter.isMock, objects: s.seen, metricRows: m.rows });
  }

  const source = sourceFor(db, brand, opts.env, opts.fetchImpl);
  const pulled = await pullCustomerEvents(db, brand, source);
  // New ads may have been mirrored since; give every undecided row another look.
  await resetUnattributed(db, brand.id);
  const attributed = await attributeCustomerEvents(db, brand.id);

  await db.insert(auditEvents).values({
    actor: opts.actor ?? "system:sync",
    verb: "brand_synced",
    subject: `brand:${brand.id}`,
    data: { accounts: accountReports, events: { isMock: pulled.isMock, rowsSeen: pulled.rowsSeen, rowsRejected: pulled.rowsRejected }, attributed: attributed.byMethod },
  });

  return {
    brand: brand.slug,
    accounts: accountReports,
    events: { isMock: pulled.isMock, rowsSeen: pulled.rowsSeen, rowsRejected: pulled.rowsRejected, eventsUpserted: pulled.eventsUpserted },
    attribution: attributed,
  };
}

export async function syncAllBrands(db: Db, registry: AdapterRegistry, opts: Parameters<typeof syncBrand>[3] = {}): Promise<BrandSyncReport[]> {
  const all = await db.select().from(brands).where(eq(brands.status, "active"));
  const out: BrandSyncReport[] = [];
  for (const b of all) out.push(await syncBrand(db, registry, b, opts));
  return out;
}
