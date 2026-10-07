import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { channelAccounts, customerEvents, extObjects, metricsDaily, type Experiment, type Mission } from "../db/schema.js";

// What a mission or experiment has spent and got. Objects are tied to a
// mission/experiment by the executor's name tag at sync time, so this is a
// filter over the same tables Today uses, never a separate count.

export interface Ledger {
  spendMicros: number;
  impressions: number;
  clicks: number;
  registered: number;
  activated: number;
  paid: number;
  cpaMicros: number | null;
  cacMicros: number | null;
  objects: number;
}

const ratio = (n: number, d: number) => (d > 0 ? Math.round(n / d) : null);

async function ledgerFor(db: Db, where: "mission" | "experiment", id: string, from: Date | null, to: Date | null): Promise<Ledger> {
  const col = where === "mission" ? extObjects.missionId : extObjects.experimentId;
  const objs = await db.select({ id: extObjects.id }).from(extObjects).where(eq(col, id));
  const ids = objs.map((o) => o.id);
  if (ids.length === 0) return { spendMicros: 0, impressions: 0, clicks: 0, registered: 0, activated: 0, paid: 0, cpaMicros: null, cacMicros: null, objects: 0 };
  const dateFrom = from ? from.toISOString().slice(0, 10) : "1970-01-01";
  const dateTo = to ? to.toISOString().slice(0, 10) : "2999-12-31";
  const [m] = await db
    .select({
      spend: sql<number>`coalesce(sum(${metricsDaily.spendMicros}), 0)::bigint`,
      impressions: sql<number>`coalesce(sum(${metricsDaily.impressions}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricsDaily.clicks}), 0)::int`,
    })
    .from(metricsDaily)
    .where(and(inArray(metricsDaily.extObjectId, ids), gte(metricsDaily.date, dateFrom), lte(metricsDaily.date, dateTo)));
  const stages = await db
    .select({ stage: customerEvents.stage, n: sql<number>`count(*)::int` })
    .from(customerEvents)
    .where(and(inArray(customerEvents.attributedExtObjectId, ids), ...(from ? [gte(customerEvents.occurredAt, from)] : []), ...(to ? [lte(customerEvents.occurredAt, to)] : [])))
    .groupBy(customerEvents.stage);
  const count = (s: string) => Number(stages.find((x) => x.stage === s)?.n ?? 0);
  const spend = Number(m?.spend ?? 0);
  const registered = count("registered");
  const paid = count("paid");
  return { spendMicros: spend, impressions: Number(m?.impressions ?? 0), clicks: Number(m?.clicks ?? 0), registered, activated: count("activated"), paid, cpaMicros: ratio(spend, registered), cacMicros: ratio(spend, paid), objects: ids.length };
}

export const missionLedger = (db: Db, m: Mission) => ledgerFor(db, "mission", m.id, m.startsAt, m.endsAt);
export const experimentLedger = (db: Db, e: Experiment) => ledgerFor(db, "experiment", e.id, e.startsAt, e.endsAt);

export interface MissionProgress {
  ledger: Ledger;
  goalMetric: string;
  goalTarget: number;
  goalReached: number;
  goalPct: number;
  budgetPct: number;
  daysElapsed: number;
  daysTotal: number;
  onPace: boolean | null;
  targetCacMicros: number | null;
  cacVsTargetPct: number | null;
}

export async function missionProgress(db: Db, m: Mission, now = new Date()): Promise<MissionProgress> {
  const ledger = await missionLedger(db, m);
  const reached = m.goal.metric === "paid_customers" ? ledger.paid : ledger.registered;
  const goalPct = Math.round((100 * reached) / Math.max(1, m.goal.target));
  const budgetPct = Math.round((100 * ledger.spendMicros) / Math.max(1, m.budgetMicros));
  const daysTotal = m.startsAt && m.endsAt ? Math.max(1, Math.round((m.endsAt.getTime() - m.startsAt.getTime()) / 86400_000)) : 0;
  const daysElapsed = m.startsAt ? Math.min(daysTotal, Math.max(0, Math.round((now.getTime() - m.startsAt.getTime()) / 86400_000))) : 0;
  const timePct = daysTotal ? (100 * daysElapsed) / daysTotal : 0;
  const onPace = daysTotal && daysElapsed >= 3 ? goalPct >= timePct * 0.8 : null;
  const unitCost = m.goal.metric === "paid_customers" ? ledger.cacMicros : ledger.cpaMicros;
  const cacVsTargetPct = m.targetCacMicros && unitCost !== null ? Math.round((100 * unitCost) / m.targetCacMicros) : null;
  return { ledger, goalMetric: m.goal.metric, goalTarget: m.goal.target, goalReached: reached, goalPct, budgetPct, daysElapsed, daysTotal, onPace, targetCacMicros: m.targetCacMicros, cacVsTargetPct };
}

/** Link mirrored objects to the proposal that created them, by the executor's name tag. */
export async function linkCreatedObjects(db: Db, brandId: string): Promise<number> {
  const rows = await db.execute(sql`
    update ${extObjects} o
    set mission_id = p.mission_id, experiment_id = p.experiment_id, created_by_action_id = p.id
    from (
      select id, mission_id, experiment_id, substr(replace(id::text, '-', ''), 1, 8) as tag
      from action_proposals where brand_id = ${brandId} and status = 'executed'
    ) p
    join ${channelAccounts} a on a.brand_id = ${brandId}
    where o.channel_account_id = a.id and o.created_by_action_id is null and o.name like '%[mb:' || substr(p.id::text, 1, 8) || ']%'
  `);
  return rows.rowCount ?? 0;
}
