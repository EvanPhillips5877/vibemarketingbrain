import { and, eq, inArray } from "drizzle-orm";
import type { ChannelAdapter } from "../channels/adapter.js";
import type { Db } from "../db/client.js";
import { extObjects, metricsDaily, type ChannelAccount } from "../db/schema.js";
import { accountRef } from "./structure.js";

export interface MetricsSyncResult {
  rows: number;
  /** Metric rows whose object is not in ext_objects yet (run syncStructure first). */
  orphaned: number;
}

/** Day in YYYY-MM-DD for `daysAgo` days before `today`, in UTC calendar terms. */
export function isoDay(daysAgo: number, today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Upsert daily metrics over [fromDate, toDate]. Platforms restate recent days, so re-pulling a window overwrites. */
export async function syncMetrics(
  db: Db,
  adapter: ChannelAdapter,
  account: ChannelAccount,
  fromDate: string,
  toDate: string,
): Promise<MetricsSyncResult> {
  if (fromDate > toDate) throw new Error(`fromDate ${fromDate} is after toDate ${toDate}`);
  const known = await db
    .select({ id: extObjects.id, kind: extObjects.kind, externalId: extObjects.externalId })
    .from(extObjects)
    .where(and(eq(extObjects.channelAccountId, account.id), inArray(extObjects.kind, ["campaign", "ad_group", "ad", "keyword"])));
  const byKey = new Map(known.map((k) => [`${k.kind}:${k.externalId}`, k.id]));

  let rows = 0;
  let orphaned = 0;
  for await (const m of adapter.fetchDailyMetrics(accountRef(account), fromDate, toDate)) {
    if (m.date < fromDate || m.date > toDate) throw new Error(`adapter returned ${m.date} outside ${fromDate}..${toDate}`);
    const extObjectId = byKey.get(`${m.kind}:${m.externalId}`);
    if (!extObjectId) {
      orphaned++;
      continue;
    }
    await db
      .insert(metricsDaily)
      .values({
        extObjectId,
        date: m.date,
        impressions: m.impressions,
        clicks: m.clicks,
        spendMicros: m.spendMicros,
        platformConversions: m.platformConversions,
        frequency: m.frequency,
        reach: m.reach,
        raw: m.raw,
      })
      .onConflictDoUpdate({
        target: [metricsDaily.extObjectId, metricsDaily.date],
        set: {
          impressions: m.impressions,
          clicks: m.clicks,
          spendMicros: m.spendMicros,
          platformConversions: m.platformConversions,
          frequency: m.frequency,
          reach: m.reach,
          raw: m.raw,
        },
      });
    rows++;
  }
  return { rows, orphaned };
}
