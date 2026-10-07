import { eq, sql } from "drizzle-orm";
import type { AccountRef, ChannelAdapter } from "../channels/adapter.js";
import type { Db } from "../db/client.js";
import { channelAccounts, extObjects, type ChannelAccount } from "../db/schema.js";

export function accountRef(row: ChannelAccount): AccountRef {
  return {
    id: row.id,
    channel: row.channel,
    externalAccountId: row.externalAccountId,
    currency: row.currency,
    timezone: row.timezone,
    secretRef: row.secretRef,
  };
}

export interface StructureSyncResult {
  seen: number;
  inserted: number;
  updated: number;
}

/** Mirror the platform's objects into ext_objects. The platform wins for every platform-owned column; our join columns are kept. */
export async function syncStructure(db: Db, adapter: ChannelAdapter, account: ChannelAccount): Promise<StructureSyncResult> {
  const ref = accountRef(account);
  let seen = 0;
  let inserted = 0;
  let updated = 0;
  for await (const o of adapter.syncStructure(ref)) {
    seen++;
    const rows = await db
      .insert(extObjects)
      .values({
        channelAccountId: account.id,
        kind: o.kind,
        externalId: o.externalId,
        parentExternalId: o.parentExternalId,
        name: o.name,
        status: o.status,
        dailyBudgetMicros: o.dailyBudgetMicros,
        settings: o.settings,
        raw: o.raw,
      })
      .onConflictDoUpdate({
        target: [extObjects.channelAccountId, extObjects.kind, extObjects.externalId],
        set: {
          parentExternalId: o.parentExternalId,
          name: o.name,
          status: o.status,
          dailyBudgetMicros: o.dailyBudgetMicros,
          settings: o.settings,
          raw: o.raw,
          syncedAt: sql`now()`,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (rows[0]?.inserted) inserted++;
    else updated++;
  }
  await db.update(channelAccounts).set({ lastSyncedAt: sql`now()` }).where(eq(channelAccounts.id, account.id));
  return { seen, inserted, updated };
}
