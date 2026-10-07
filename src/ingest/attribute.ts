import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { channelAccounts, customerEvents, extObjects, type AttributionMethod, type Channel } from "../db/schema.js";

// Which ad (or at least which channel) a customer came from, decided from
// the first touch the brand's app recorded. Last-non-direct touch is a
// later refinement; V1 is first touch, and it is honest about what it
// cannot know: a bare click id names the channel, not the ad, and nothing at
// all is "unattributed", never smeared across channels.

export interface AttributionDecision {
  extObjectId: string | null;
  channel: Channel | null;
  method: AttributionMethod;
}

export interface KnownObject {
  id: string;
  kind: string;
  externalId: string;
  name: string | null;
  channel: Channel;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

const META_SOURCES = new Set(["meta", "facebook", "fb", "instagram", "ig"]);
const GOOGLE_SOURCES = new Set(["google", "adwords", "google_ads", "googleads"]);

/** What the touch itself says about the channel, before any object lookup. */
function channelEvidence(ft: Record<string, string | undefined>): { channel: Channel; method: "click_id" | "utm_source" } | null {
  if (ft["gclid"] || ft["gbraid"] || ft["wbraid"]) return { channel: "google", method: "click_id" };
  if (ft["fbclid"]) return { channel: "meta", method: "click_id" };
  const source = norm(ft["utmSource"]);
  if (META_SOURCES.has(source)) return { channel: "meta", method: "utm_source" };
  if (GOOGLE_SOURCES.has(source)) return { channel: "google", method: "utm_source" };
  if (source === "mock") return { channel: "mock", method: "utm_source" };
  return null;
}

/** Pure: decide from a first touch and the brand's known objects. */
export function decideAttribution(firstTouch: Record<string, unknown>, objects: KnownObject[]): AttributionDecision {
  const ft = firstTouch as Record<string, string | undefined>;
  const hint = channelEvidence(ft);
  // A click id or utm_source names the channel; an object on another
  // channel cannot be the one, however well its name matches.
  const candidates = hint ? objects.filter((o) => o.channel === hint.channel) : objects;

  const content = norm(ft["utmContent"]);
  if (content) {
    const ad = candidates.find((o) => o.kind === "ad" && norm(o.externalId) === content);
    if (ad) return { extObjectId: ad.id, channel: ad.channel, method: "utm_content" };
  }
  const campaign = norm(ft["utmCampaign"]);
  if (campaign) {
    const byId = candidates.find((o) => o.kind === "campaign" && norm(o.externalId) === campaign);
    // A name is only unambiguous when exactly one campaign carries it.
    const byName = candidates.filter((o) => o.kind === "campaign" && norm(o.name) === campaign);
    const c = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (c) return { extObjectId: c.id, channel: c.channel, method: "utm_campaign" };
  }
  if (hint) return { extObjectId: null, channel: hint.channel, method: hint.method };
  return { extObjectId: null, channel: null, method: "unattributed" };
}

export async function knownObjects(db: Db, brandId: string): Promise<KnownObject[]> {
  return db
    .select({ id: extObjects.id, kind: extObjects.kind, externalId: extObjects.externalId, name: extObjects.name, channel: channelAccounts.channel })
    .from(extObjects)
    .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
    .where(eq(channelAccounts.brandId, brandId));
}

export interface AttributeResult {
  decided: number;
  byMethod: Record<AttributionMethod, number>;
}

/** Attribute every event of the brand that has no decision yet. Idempotent; re-run after a structure sync to pick up new ads. */
export async function attributeCustomerEvents(db: Db, brandId: string): Promise<AttributeResult> {
  const objects = await knownObjects(db, brandId);
  const pending = await db
    .select({ id: customerEvents.id, firstTouch: customerEvents.firstTouch })
    .from(customerEvents)
    .where(and(eq(customerEvents.brandId, brandId), isNull(customerEvents.attributionMethod)));
  const byMethod: Record<AttributionMethod, number> = { click_id: 0, utm_content: 0, utm_campaign: 0, utm_source: 0, unattributed: 0 };
  // One UPDATE per distinct decision, not per row: a brand with a long
  // history and a handful of ads is a handful of statements.
  const groups = new Map<string, { decision: AttributionDecision; ids: string[] }>();
  for (const e of pending) {
    const d = decideAttribution(e.firstTouch, objects);
    byMethod[d.method]++;
    const k = `${d.extObjectId}|${d.channel}|${d.method}`;
    const g = groups.get(k) ?? { decision: d, ids: [] };
    g.ids.push(e.id);
    groups.set(k, g);
  }
  for (const { decision: d, ids } of groups.values()) {
    for (let i = 0; i < ids.length; i += 1000) {
      await db
        .update(customerEvents)
        .set({ attributedExtObjectId: d.extObjectId, attributedChannel: d.channel, attributionMethod: d.method })
        .where(inArray(customerEvents.id, ids.slice(i, i + 1000)));
    }
  }
  return { decided: pending.length, byMethod };
}

/** Forget "unattributed" decisions so a later sync (new ads mirrored) can retry them. */
export async function resetUnattributed(db: Db, brandId: string): Promise<number> {
  const rows = await db
    .update(customerEvents)
    .set({ attributionMethod: null, attributedChannel: null, attributedExtObjectId: null })
    .where(and(eq(customerEvents.brandId, brandId), sql`${customerEvents.attributionMethod} in ('unattributed', 'utm_source', 'click_id')`))
    .returning({ id: customerEvents.id });
  return rows.length;
}
