import { and, eq, gte, lte, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { channelAccounts, customerEvents, extObjects, metricsDaily, type Channel } from "../db/schema.js";

// The numbers the screens show. SQL only; the AI (Phase 10) reads these
// packs and never computes a number itself. Money is micros in the brand's
// currency; a ratio with a zero denominator is null, never Infinity.

export interface Window {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  /** IANA zone the days are counted in (the brand's); metrics dates are already the account's own day. */
  timezone: string;
}

// Day boundaries in the brand's zone, computed by Postgres so an event at
// 23:30 Toronto time lands on that day, not the next UTC day.
const dayStart = (w: Window) => sql`(${w.from}::date)::timestamp at time zone ${w.timezone}`;
const dayEnd = (w: Window) => sql`((${w.to}::date + 1)::timestamp at time zone ${w.timezone})`;

export interface Totals {
  spendMicros: number;
  impressions: number;
  clicks: number;
  platformConversions: number;
  registered: number;
  activated: number;
  paid: number;
  cpaMicros: number | null; // spend / registered
  cacMicros: number | null; // spend / paid
}

export interface ChannelTotals extends Totals {
  channel: Channel;
  isMock: boolean;
}

export interface BrandSummary {
  window: Window;
  totals: Totals;
  byChannel: ChannelTotals[];
  attribution: { registered: number; attributedToAd: number; attributedToChannelOnly: number; unattributed: number; pending: number };
}

const ratio = (num: number, den: number): number | null => (den > 0 ? Math.round(num / den) : null);

function totals(spend: number, imp: number, clicks: number, conv: number, reg: number, act: number, paid: number): Totals {
  return { spendMicros: spend, impressions: imp, clicks, platformConversions: conv, registered: reg, activated: act, paid, cpaMicros: ratio(spend, reg), cacMicros: ratio(spend, paid) };
}

export async function brandSummary(db: Db, brandId: string, w: Window): Promise<BrandSummary> {
  const spendRows = await db
    .select({
      channel: channelAccounts.channel,
      spend: sql<number>`coalesce(sum(${metricsDaily.spendMicros}), 0)::bigint`,
      impressions: sql<number>`coalesce(sum(${metricsDaily.impressions}), 0)::int`,
      clicks: sql<number>`coalesce(sum(${metricsDaily.clicks}), 0)::int`,
      conversions: sql<number>`coalesce(sum((${metricsDaily.platformConversions}->>'registration')::int), 0)::int`,
    })
    .from(metricsDaily)
    .innerJoin(extObjects, eq(extObjects.id, metricsDaily.extObjectId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
    .where(and(eq(channelAccounts.brandId, brandId), gte(metricsDaily.date, w.from), lte(metricsDaily.date, w.to)))
    .groupBy(channelAccounts.channel);

  const stageRows = await db
    .select({
      channel: customerEvents.attributedChannel,
      stage: customerEvents.stage,
      method: customerEvents.attributionMethod,
      n: sql<number>`count(*)::int`,
    })
    .from(customerEvents)
    .where(and(eq(customerEvents.brandId, brandId), sql`${customerEvents.occurredAt} >= ${dayStart(w)}`, sql`${customerEvents.occurredAt} < ${dayEnd(w)}`))
    .groupBy(customerEvents.attributedChannel, customerEvents.stage, customerEvents.attributionMethod);

  const stageCount = (channel: Channel | null | "all", stage: string) =>
    stageRows.filter((r) => (channel === "all" || r.channel === channel) && r.stage === stage).reduce((a, r) => a + Number(r.n), 0);

  const channels = new Set<Channel>([...spendRows.map((r) => r.channel), ...stageRows.flatMap((r) => (r.channel ? [r.channel] : []))]);
  const byChannel: ChannelTotals[] = [...channels].sort().map((channel) => {
    const s = spendRows.find((r) => r.channel === channel);
    return {
      channel,
      isMock: channel === "mock",
      ...totals(Number(s?.spend ?? 0), Number(s?.impressions ?? 0), Number(s?.clicks ?? 0), Number(s?.conversions ?? 0), stageCount(channel, "registered"), stageCount(channel, "activated"), stageCount(channel, "paid")),
    };
  });

  const all = totals(
    byChannel.reduce((a, c) => a + c.spendMicros, 0),
    byChannel.reduce((a, c) => a + c.impressions, 0),
    byChannel.reduce((a, c) => a + c.clicks, 0),
    byChannel.reduce((a, c) => a + c.platformConversions, 0),
    stageCount("all", "registered"),
    stageCount("all", "activated"),
    stageCount("all", "paid"),
  );

  const reg = stageRows.filter((r) => r.stage === "registered");
  const sum = (pred: (r: (typeof reg)[number]) => boolean) => reg.filter(pred).reduce((a, r) => a + Number(r.n), 0);
  return {
    window: w,
    totals: all,
    byChannel,
    attribution: {
      registered: all.registered,
      attributedToAd: sum((r) => r.method === "utm_content" || r.method === "utm_campaign"),
      attributedToChannelOnly: sum((r) => r.method === "click_id" || r.method === "utm_source"),
      unattributed: sum((r) => r.method === "unattributed"),
      pending: sum((r) => r.method === null),
    },
  };
}

export interface CampaignRow {
  extObjectId: string;
  channel: Channel;
  isMock: boolean;
  externalId: string;
  name: string | null;
  status: string | null;
  dailyBudgetMicros: number | null;
  spendMicros: number;
  impressions: number;
  clicks: number;
  platformConversions: number;
  registered: number;
  paid: number;
  cpaMicros: number | null;
  cacMicros: number | null;
}

/** One row per campaign, metrics rolled up from its ads (ad → ad group → campaign by external parent id). */
export async function campaignsTable(db: Db, brandId: string, w: Window): Promise<CampaignRow[]> {
  const rows = await db.execute(sql`
    with objs as (
      select o.*, a.channel
      from ${extObjects} o
      join ${channelAccounts} a on a.id = o.channel_account_id
      where a.brand_id = ${brandId}
    ),
    lineage as (
      select ad.id as ad_id, c.id as campaign_id
      from objs ad
      join objs g on g.kind = 'ad_group' and g.channel_account_id = ad.channel_account_id and g.external_id = ad.parent_external_id
      join objs c on c.kind = 'campaign' and c.channel_account_id = g.channel_account_id and c.external_id = g.parent_external_id
      where ad.kind = 'ad'
    ),
    m as (
      select l.campaign_id,
             coalesce(sum(md.spend_micros), 0)::bigint as spend,
             coalesce(sum(md.impressions), 0)::int as impressions,
             coalesce(sum(md.clicks), 0)::int as clicks,
             coalesce(sum((md.platform_conversions->>'registration')::int), 0)::int as conversions
      from lineage l
      join ${metricsDaily} md on md.ext_object_id = l.ad_id
      where md.date >= ${w.from} and md.date <= ${w.to}
      group by l.campaign_id
    ),
    ev as (
      select coalesce(l.campaign_id, e.attributed_ext_object_id) as campaign_id,
             count(*) filter (where e.stage = 'registered')::int as registered,
             count(*) filter (where e.stage = 'paid')::int as paid
      from ${customerEvents} e
      left join lineage l on l.ad_id = e.attributed_ext_object_id
      where e.brand_id = ${brandId}
        and e.attributed_ext_object_id is not null
        and e.occurred_at >= ${dayStart(w)} and e.occurred_at < ${dayEnd(w)}
      group by 1
    )
    select c.id, c.channel, c.external_id, c.name, c.status, c.daily_budget_micros,
           coalesce(m.spend, 0)::bigint as spend, coalesce(m.impressions, 0)::int as impressions, coalesce(m.clicks, 0)::int as clicks,
           coalesce(m.conversions, 0)::int as conversions, coalesce(ev.registered, 0)::int as registered, coalesce(ev.paid, 0)::int as paid
    from objs c
    left join m on m.campaign_id = c.id
    left join ev on ev.campaign_id = c.id
    where c.kind = 'campaign'
    order by spend desc, c.name
  `);
  return (rows.rows as Record<string, unknown>[]).map((r) => {
    const spend = Number(r["spend"]);
    const registered = Number(r["registered"]);
    const paid = Number(r["paid"]);
    return {
      extObjectId: String(r["id"]),
      channel: r["channel"] as Channel,
      isMock: r["channel"] === "mock",
      externalId: String(r["external_id"]),
      name: (r["name"] as string | null) ?? null,
      status: (r["status"] as string | null) ?? null,
      dailyBudgetMicros: r["daily_budget_micros"] === null ? null : Number(r["daily_budget_micros"]),
      spendMicros: spend,
      impressions: Number(r["impressions"]),
      clicks: Number(r["clicks"]),
      platformConversions: Number(r["conversions"]),
      registered,
      paid,
      cpaMicros: ratio(spend, registered),
      cacMicros: ratio(spend, paid),
    };
  });
}
