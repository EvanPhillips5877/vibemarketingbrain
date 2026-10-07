import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { localDay } from "../analytics/format.js";
import type { Db } from "../db/client.js";
import { actionExecutions, actionProposals, brands, channelAccounts, extObjects, metricsDaily } from "../db/schema.js";
import type { ProposalPayload } from "../domain/proposals.js";
import type { LedgerSnapshot } from "./policy.js";

// Everything the policy evaluator needs, read once. The evaluator itself
// never touches the database; this is the only place that does.

function objectIds(p: ProposalPayload): string[] {
  switch (p.type) {
    case "PAUSE_AD":
    case "ACTIVATE":
    case "CHANGE_BUDGET":
      return [p.extObjectId];
    case "ROTATE_AD":
      return [p.pause.extObjectId, p.activate.extObjectId];
    case "REALLOCATE_BUDGET":
      return [p.from.extObjectId, p.to.extObjectId];
    default:
      return [];
  }
}

/** Budget changes a proposal made, with the previous value taken from the stored inverse. */
function budgetMoves(p: ProposalPayload, rollback: unknown): { extObjectId: string; from: number; to: number }[] {
  const inverses = (Array.isArray(rollback) ? rollback : rollback ? [rollback] : []) as { type?: string; externalId?: string; dailyBudgetMicros?: number }[];
  const previous = (externalId: string) => inverses.find((i) => i.type === "CHANGE_BUDGET" && i.externalId === externalId)?.dailyBudgetMicros ?? 0;
  if (p.type === "CHANGE_BUDGET") return [{ extObjectId: p.extObjectId, from: previous(p.externalId), to: p.dailyBudgetMicros }];
  if (p.type === "REALLOCATE_BUDGET") return [
    { extObjectId: p.from.extObjectId, from: previous(p.from.externalId), to: p.from.dailyBudgetMicros },
    { extObjectId: p.to.extObjectId, from: previous(p.to.externalId), to: p.to.dailyBudgetMicros },
  ];
  return [];
}

export async function ledgerSnapshot(db: Db, brandId: string, payload: ProposalPayload, now = new Date()): Promise<LedgerSnapshot> {
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  if (!brand) throw new Error("brand not found");
  const today = localDay(now, brand.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [y, m] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const daysLeftInMonth = daysInMonth - Number(today.slice(8, 10));

  const [spend] = await db
    .select({ s: sql<number>`coalesce(sum(${metricsDaily.spendMicros}), 0)::bigint` })
    .from(metricsDaily)
    .innerJoin(extObjects, eq(extObjects.id, metricsDaily.extObjectId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
    .where(and(eq(channelAccounts.brandId, brandId), gte(metricsDaily.date, monthStart)));

  const live = await db.execute(sql`
    select coalesce(sum(coalesce(c.daily_budget_micros, (
      select sum(g.daily_budget_micros) from ${extObjects} g
      where g.channel_account_id = c.channel_account_id and g.kind = 'ad_group' and g.parent_external_id = c.external_id and g.status = 'ACTIVE'
    ))), 0)::bigint as total
    from ${extObjects} c join ${channelAccounts} a on a.id = c.channel_account_id
    where a.brand_id = ${brandId} and c.kind = 'campaign' and c.status = 'ACTIVE'`);

  const ids = objectIds(payload);
  const objects: LedgerSnapshot["objects"] = {};
  if (ids.length) {
    const rows = await db
      .select({ id: extObjects.id, channel: channelAccounts.channel, status: extObjects.status, dailyBudgetMicros: extObjects.dailyBudgetMicros, externalId: extObjects.externalId })
      .from(extObjects)
      .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
      .where(and(eq(channelAccounts.brandId, brandId), inArray(extObjects.id, ids)));
    for (const r of rows) objects[r.id] = { channel: r.channel, status: r.status, dailyBudgetMicros: r.dailyBudgetMicros, externalId: r.externalId };
  }

  // Changes MarketingBrain made: executed proposals touching these objects.
  const recentChanges: LedgerSnapshot["recentChanges"] = [];
  const recentAutoShifts: LedgerSnapshot["recentAutoShifts"] = [];
  if (ids.length) {
    const since = new Date(now.getTime() - 7 * 24 * 3600_000);
    const execs = await db
      .select({ payload: actionProposals.payload, type: actionProposals.type, at: actionExecutions.startedAt, rollback: actionExecutions.rollback, approvedBy: actionProposals.approvedBy })
      .from(actionExecutions)
      .innerJoin(actionProposals, eq(actionProposals.id, actionExecutions.proposalId))
      .where(and(eq(actionProposals.brandId, brandId), inArray(actionExecutions.outcome, ["executed", "unknown"]), gte(actionExecutions.startedAt, since)))
      .orderBy(desc(actionExecutions.startedAt));
    for (const e of execs) {
      const touched = objectIds(e.payload as ProposalPayload).filter((id) => ids.includes(id));
      for (const id of touched) {
        recentChanges.push({ extObjectId: id, at: e.at ?? now });
        if (e.approvedBy === "system:autopilot") {
          // Every budget move autopilot made on this object this week, whether
          // a single change or one side of a reallocation.
          for (const m of budgetMoves(e.payload as ProposalPayload, e.rollback)) {
            if (m.extObjectId === id && m.from > 0) recentAutoShifts.push({ extObjectId: id, pct: (Math.abs(m.to - m.from) / m.from) * 100, at: e.at ?? now });
          }
        }
      }
    }
  }

  return {
    now,
    brandStatus: brand.status,
    monthSpendMicros: Number(spend?.s ?? 0),
    daysLeftInMonth,
    liveDailyBudgetMicros: Number((live.rows[0] as { total: unknown } | undefined)?.total ?? 0),
    objects,
    recentAutoShifts,
    recentChanges,
  };
}
