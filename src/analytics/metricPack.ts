import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brands, channelAccounts, extObjects, missions } from "../db/schema.js";
import { currentPolicy } from "../brands/queries.js";
import { localDay, moneyText } from "./format.js";
import { adsTable, brandSummary, campaignsTable, type Window } from "./ledger.js";

// The metric pack: every number the detectors and the Analyst may speak
// about, each with an id that a claim cites as evidence. The model never
// computes a number; it points at one of these. Entries below the sample
// thresholds are marked `insufficient`, and a claim about them may only
// be a hypothesis.

export type Unit = "micros" | "count" | "ratio" | "pct";

export interface PackEntry {
  /** Unique within the pack. Object-level ids use our ext_objects uuid, never the platform's id, which can repeat across accounts. */
  id: string;
  label: string;
  value: number | null;
  unit: Unit;
  window: string;
  scope: { level: "brand" | "channel" | "campaign" | "ad"; channel?: string; extObjectId?: string; name?: string };
  insufficient?: boolean;
  note?: string;
}

export interface MetricPack {
  brandId: string;
  currency: string;
  generatedAt: string;
  windows: { current: Window; previous: Window; trailing: Window; monthToDate: Window };
  context: {
    targetCacMicros: number | null; // the active mission's target cost per paying customer, if any
    monthlyBudgetMicros: number | null;
    maxDailySpendMicros: number | null;
    minConversions: number;
  };
  entries: PackEntry[];
}

export const SAMPLE_MIN_CONVERSIONS = 10;

const pctDelta = (now: number, before: number): number | null => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

export function entryIndex(pack: MetricPack): Map<string, PackEntry> {
  return new Map(pack.entries.map((e) => [e.id, e]));
}

export async function buildMetricPack(db: Db, brandId: string, today = new Date()): Promise<MetricPack> {
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  if (!brand) throw new Error("brand not found");
  const tz = brand.timezone;
  // Days as the brand's calendar reads them, so "today" and the month do
  // not flip early in the evening.
  const day = (n: number) => localDay(today, tz, n);
  const windows = {
    current: { from: day(7), to: day(1), timezone: tz }, // last 7 complete days
    previous: { from: day(14), to: day(8), timezone: tz },
    trailing: { from: day(35), to: day(8), timezone: tz }, // the 28 days before the current week
    monthToDate: { from: `${day(0).slice(0, 7)}-01`, to: day(0), timezone: tz },
  };

  const policy = await currentPolicy(db, brandId);
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.brandId, brandId), eq(missions.status, "active")))
    .orderBy(desc(missions.createdAt))
    .limit(1);
  const targetCacMicros = mission?.targetCacMicros ?? null;
  // Daily budget actually live: a campaign's own budget, or, where it has
  // none (Meta without CBO), the budgets of its active ad sets.
  const liveBudget = await db.execute(sql`
    select coalesce(sum(coalesce(c.daily_budget_micros, (
      select sum(g.daily_budget_micros) from ${extObjects} g
      where g.channel_account_id = c.channel_account_id and g.kind = 'ad_group'
        and g.parent_external_id = c.external_id and g.status = 'ACTIVE'
    ))), 0)::bigint as total
    from ${extObjects} c
    join ${channelAccounts} a on a.id = c.channel_account_id
    where a.brand_id = ${brandId} and c.kind = 'campaign' and c.status = 'ACTIVE'
  `);
  const liveDailyBudgetMicros = Number((liveBudget.rows[0] as { total: unknown } | undefined)?.total ?? 0);

  const [cur, prev, trail, mtd] = await Promise.all([brandSummary(db, brandId, windows.current), brandSummary(db, brandId, windows.previous), brandSummary(db, brandId, windows.trailing), brandSummary(db, brandId, windows.monthToDate)]);
  const [curCampaigns, trailCampaigns, curAds, prevAds] = await Promise.all([campaignsTable(db, brandId, windows.current), campaignsTable(db, brandId, windows.trailing), adsTable(db, brandId, windows.current), adsTable(db, brandId, windows.previous)]);

  const entries: PackEntry[] = [];
  const push = (e: PackEntry) => entries.push(e);
  // Too few conversions to compare on. (A CAC target says nothing about
  // registrations, so it does not enter here.)
  const insufficient = (_spend: number, conversions: number) => conversions < SAMPLE_MIN_CONVERSIONS;

  const brandScope = { level: "brand" as const };
  push({ id: "brand.daily_budget.live", label: "Daily budget live now (active campaigns, or their active ad sets)", value: liveDailyBudgetMicros, unit: "micros", window: "now", scope: brandScope });
  for (const [w, s] of [
    ["7d", cur],
    ["prev7d", prev],
    ["28d", trail],
    ["mtd", mtd],
  ] as const) {
    const t = s.totals;
    const weak = insufficient(t.spendMicros, t.registered);
    push({ id: `brand.spend.${w}`, label: "Spend", value: t.spendMicros, unit: "micros", window: w, scope: brandScope });
    push({ id: `brand.impressions.${w}`, label: "Impressions", value: t.impressions, unit: "count", window: w, scope: brandScope });
    push({ id: `brand.clicks.${w}`, label: "Clicks", value: t.clicks, unit: "count", window: w, scope: brandScope });
    push({ id: `brand.registered.${w}`, label: "Registrations", value: t.registered, unit: "count", window: w, scope: brandScope });
    push({ id: `brand.paid.${w}`, label: "Paying customers", value: t.paid, unit: "count", window: w, scope: brandScope });
    push({ id: `brand.cpa.${w}`, label: "CPA (spend per registration)", value: t.cpaMicros, unit: "micros", window: w, scope: brandScope, insufficient: weak });
    push({ id: `brand.cac.${w}`, label: "CAC (spend per paying customer)", value: t.cacMicros, unit: "micros", window: w, scope: brandScope, insufficient: t.paid < SAMPLE_MIN_CONVERSIONS });
    push({ id: `brand.ctr.${w}`, label: "CTR", value: t.impressions > 0 ? Math.round((t.clicks / t.impressions) * 10000) / 100 : null, unit: "pct", window: w, scope: brandScope });
  }
  push({ id: "brand.spend.delta_pct", label: "Spend change vs previous 7 days", value: pctDelta(cur.totals.spendMicros, prev.totals.spendMicros), unit: "pct", window: "7d_vs_prev7d", scope: brandScope });
  push({ id: "brand.registered.delta_pct", label: "Registrations change vs previous 7 days", value: pctDelta(cur.totals.registered, prev.totals.registered), unit: "pct", window: "7d_vs_prev7d", scope: brandScope });
  push({
    id: "brand.cpa.delta_pct",
    label: "CPA change vs previous 7 days",
    value: cur.totals.cpaMicros !== null && prev.totals.cpaMicros !== null ? pctDelta(cur.totals.cpaMicros, prev.totals.cpaMicros) : null,
    unit: "pct",
    window: "7d_vs_prev7d",
    scope: brandScope,
    insufficient: insufficient(cur.totals.spendMicros, cur.totals.registered) || insufficient(prev.totals.spendMicros, prev.totals.registered),
  });
  push({ id: "brand.unattributed.7d", label: "Registrations not traceable to an ad", value: cur.attribution.unattributed, unit: "count", window: "7d", scope: brandScope });

  for (const c of cur.byChannel) {
    const scope = { level: "channel" as const, channel: c.channel };
    push({ id: `channel:${c.channel}.spend.7d`, label: `${c.channel} spend`, value: c.spendMicros, unit: "micros", window: "7d", scope });
    push({ id: `channel:${c.channel}.registered.7d`, label: `${c.channel} registrations`, value: c.registered, unit: "count", window: "7d", scope });
    push({ id: `channel:${c.channel}.cpa.7d`, label: `${c.channel} CPA`, value: c.cpaMicros, unit: "micros", window: "7d", scope, insufficient: insufficient(c.spendMicros, c.registered) });
    push({ id: `channel:${c.channel}.paid.7d`, label: `${c.channel} paying customers`, value: c.paid, unit: "count", window: "7d", scope });
  }

  for (const c of curCampaigns) {
    const scope = { level: "campaign" as const, channel: c.channel, extObjectId: c.extObjectId, name: c.name ?? c.externalId };
    const trailing = trailCampaigns.find((t) => t.extObjectId === c.extObjectId);
    push({ id: `campaign:${c.extObjectId}.spend.7d`, label: `${scope.name} spend`, value: c.spendMicros, unit: "micros", window: "7d", scope });
    push({ id: `campaign:${c.extObjectId}.registered.7d`, label: `${scope.name} registrations`, value: c.registered, unit: "count", window: "7d", scope });
    push({ id: `campaign:${c.extObjectId}.cpa.7d`, label: `${scope.name} CPA`, value: c.cpaMicros, unit: "micros", window: "7d", scope, insufficient: insufficient(c.spendMicros, c.registered) });
    push({ id: `campaign:${c.extObjectId}.cpa.28d`, label: `${scope.name} CPA, prior 28 days`, value: trailing?.cpaMicros ?? null, unit: "micros", window: "28d", scope, insufficient: !trailing || insufficient(trailing.spendMicros, trailing.registered) });
    push({ id: `campaign:${c.extObjectId}.daily_budget`, label: `${scope.name} daily budget`, value: c.dailyBudgetMicros, unit: "micros", window: "now", scope, ...(c.status ? { note: c.status } : {}) });
  }

  for (const a of curAds) {
    const scope = { level: "ad" as const, channel: a.channel, extObjectId: a.extObjectId, name: a.name ?? a.externalId };
    const before = prevAds.find((p) => p.extObjectId === a.extObjectId);
    const ctr = a.impressions > 0 ? Math.round((a.clicks / a.impressions) * 10000) / 100 : null;
    const ctrBefore = before && before.impressions > 0 ? Math.round((before.clicks / before.impressions) * 10000) / 100 : null;
    push({ id: `ad:${a.extObjectId}.spend.7d`, label: `${scope.name} spend`, value: a.spendMicros, unit: "micros", window: "7d", scope, ...(a.status ? { note: a.status } : {}) });
    push({ id: `ad:${a.extObjectId}.registered.7d`, label: `${scope.name} registrations`, value: a.registered, unit: "count", window: "7d", scope });
    push({ id: `ad:${a.extObjectId}.cpa.7d`, label: `${scope.name} CPA`, value: a.cpaMicros, unit: "micros", window: "7d", scope, insufficient: insufficient(a.spendMicros, a.registered) });
    push({ id: `ad:${a.extObjectId}.ctr.7d`, label: `${scope.name} CTR`, value: ctr, unit: "pct", window: "7d", scope });
    push({ id: `ad:${a.extObjectId}.ctr.prev7d`, label: `${scope.name} CTR, previous 7 days`, value: ctrBefore, unit: "pct", window: "prev7d", scope });
    push({ id: `ad:${a.extObjectId}.frequency.7d`, label: `${scope.name} frequency`, value: a.frequency === null ? null : Math.round(a.frequency * 100) / 100, unit: "ratio", window: "7d", scope });
  }

  return {
    brandId,
    currency: brand.defaultCurrency,
    generatedAt: today.toISOString(),
    windows,
    context: {
      targetCacMicros,
      monthlyBudgetMicros: policy?.rules.monthlyBudgetMicros ?? null,
      maxDailySpendMicros: policy?.rules.maxDailySpendMicros ?? null,
      minConversions: SAMPLE_MIN_CONVERSIONS,
    },
    entries,
  };
}

/** Compact text form for a prompt: one line per entry, ids first so the model cites them. */
export function renderPack(pack: MetricPack): string {
  const fmt = (e: PackEntry) => {
    if (e.value === null) return "n/a";
    if (e.unit === "micros") return moneyText(pack.currency, e.value);
    if (e.unit === "pct") return `${e.value}%`;
    return String(e.value);
  };
  const lines = pack.entries.map((e) => `${e.id} | ${e.label} | ${fmt(e)}${e.insufficient ? " | INSUFFICIENT_DATA" : ""}${e.note ? ` | ${e.note}` : ""}`);
  return [
    `windows: current=${pack.windows.current.from}..${pack.windows.current.to}, previous=${pack.windows.previous.from}..${pack.windows.previous.to}, trailing28=${pack.windows.trailing.from}..${pack.windows.trailing.to}`,
    `target CAC (per paying customer): ${pack.context.targetCacMicros === null ? "none set" : moneyText(pack.currency, pack.context.targetCacMicros)}`,
    `minimum conversions for a reliable comparison: ${pack.context.minConversions}`,
    "",
    "id | label | value",
    ...lines,
  ].join("\n");
}
