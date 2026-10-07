import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { brands, channelAccounts, customerEvents, extObjects, metricsDaily, type Brand, type CustomerStage } from "../db/schema.js";
import { getSecret } from "../secrets.js";

// Revenue truth, pulled from the brand's own app. Rows are organizations,
// never people: the schema below is an allowlist and anything else in a
// row is dropped before it is stored. A brand without an export URL (or
// without its token in the environment) gets the mock source, which invents
// a plausible funnel for the mock ad account so the loop runs offline.

const iso = z.string().datetime({ offset: true });
const short = z.string().max(200);

export const exportRowSchema = z
  .object({
    organizationId: z.string().min(1).max(128),
    registeredAt: iso,
    activatedAt: iso.nullable().optional(),
    paidAt: iso.nullable().optional(),
    plan: short.nullable().optional(),
    subscriptionStatus: short.nullable().optional(),
    primarySport: short.nullable().optional(),
    acquisition: z
      .object({
        gclid: short.optional(),
        gbraid: short.optional(),
        wbraid: short.optional(),
        fbclid: short.optional(),
        utmSource: short.optional(),
        utmMedium: short.optional(),
        utmCampaign: short.optional(),
        utmContent: short.optional(),
        utmTerm: short.optional(),
        landingPath: short.optional(),
        referrerHost: short.optional(),
        at: iso.optional(),
      })
      .strip()
      .nullable()
      .optional(),
    updatedAt: iso,
  })
  .strip();
export type ExportRow = z.infer<typeof exportRowSchema>;

export const exportPageSchema = z.object({
  rows: z.array(z.unknown()),
  next: z.string().max(200).nullable(),
});

export interface ExportSource {
  readonly isMock: boolean;
  /** One page. `cursor` is the previous page's `next`; null starts from `since`. */
  fetchPage(since: Date, cursor: string | null, limit: number): Promise<{ rows: unknown[]; next: string | null }>;
}

export class HttpExportSource implements ExportSource {
  readonly isMock = false;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchPage(since: Date, cursor: string | null, limit: number) {
    const u = new URL(this.url);
    u.searchParams.set("limit", String(limit));
    if (cursor) u.searchParams.set("cursor", cursor);
    else u.searchParams.set("since", since.toISOString());
    const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`export ${u.host} answered ${res.status}`); // never the body: it may echo headers
    const page = exportPageSchema.safeParse(await res.json());
    if (!page.success) throw new Error(`export ${u.host} returned an unexpected shape`);
    return page.data;
  }
}

/** A funnel invented from the mock account's own metrics: a few sign-ups per converting ad-day, some activating, some paying, some arriving from nowhere. */
export class MockExportSource implements ExportSource {
  readonly isMock = true;
  constructor(
    private readonly db: Db,
    private readonly brandId: string,
  ) {}

  async fetchPage(since: Date, cursor: string | null, limit: number) {
    // The cursor is an offset into the deterministic list, so paging works
    // the same way as the real export: newer rows are never cut off.
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const rows = await this.db
      .select({
        adExternalId: extObjects.externalId,
        campaign: extObjects.parentExternalId,
        date: metricsDaily.date,
        conversions: metricsDaily.platformConversions,
      })
      .from(metricsDaily)
      .innerJoin(extObjects, eq(extObjects.id, metricsDaily.extObjectId))
      .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
      .where(and(eq(channelAccounts.brandId, this.brandId), eq(channelAccounts.channel, "mock"), eq(extObjects.kind, "ad")))
      .orderBy(metricsDaily.date, extObjects.externalId);

    const out: ExportRow[] = [];
    for (const r of rows) {
      const n = r.conversions["registration"] ?? 0;
      for (let i = 0; i < n; i++) {
        const seed = `${r.adExternalId}|${r.date}|${i}`;
        const h = createHash("sha256").update(seed).digest();
        const registered = new Date(`${r.date}T15:00:00Z`);
        const activated = h[0]! % 10 < 6 ? new Date(registered.getTime() + 36 * 3600_000) : null;
        const paid = activated && h[1]! % 10 < 3 ? new Date(registered.getTime() + 7 * 86400_000) : null;
        const direct = h[2]! % 10 === 0; // one in ten arrives with no trace
        out.push({
          organizationId: `mock-org-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`,
          registeredAt: registered.toISOString(),
          activatedAt: activated?.toISOString() ?? null,
          paidAt: paid?.toISOString() ?? null,
          plan: paid ? "club" : "free",
          subscriptionStatus: "active",
          primarySport: ["volleyball", "soccer", "hockey"][h[3]! % 3] ?? null,
          acquisition: direct ? null : { utmSource: "mock", utmMedium: "paid", utmCampaign: r.campaign ?? "unknown", utmContent: r.adExternalId },
          updatedAt: (paid ?? activated ?? registered).toISOString(),
        });
      }
    }
    const eligible = out.filter((r) => new Date(r.updatedAt) > since);
    const page = eligible.slice(offset, offset + limit);
    const next = offset + limit < eligible.length ? String(offset + limit) : null;
    return { rows: page, next };
  }
}

export function sourceFor(db: Db, brand: Brand, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ExportSource {
  const token = getSecret(brand.eventsExportSecretRef, env);
  if (brand.eventsExportUrl && token) return new HttpExportSource(brand.eventsExportUrl, token, fetchImpl);
  return new MockExportSource(db, brand.id);
}

export interface PullResult {
  pages: number;
  rowsSeen: number;
  rowsRejected: number;
  eventsUpserted: number;
  cursor: string | null;
  isMock: boolean;
}

const STAGES: { stage: CustomerStage; at: (r: ExportRow) => string | null | undefined }[] = [
  { stage: "registered", at: (r) => r.registeredAt },
  { stage: "activated", at: (r) => r.activatedAt },
  { stage: "paid", at: (r) => r.paidAt },
];

/**
 * Pull pages and upsert one customer_events row per stage reached.
 *
 * Two pieces of state on the brand: `eventsCursor` is an unfinished pull
 * (the page cap was hit), resumed verbatim next time; `eventsPulledAt` moves
 * only when a pull reaches the end, and then the next pull starts 24 h
 * before it (the export orders by last change; the overlap is cheap with
 * upserts and forgives a restated row). A mock source never touches either,
 * so the first real pull still starts from the beginning.
 */
export async function pullCustomerEvents(db: Db, brand: Brand, source: ExportSource, opts: { limit?: number; maxPages?: number } = {}): Promise<PullResult> {
  const limit = opts.limit ?? 500;
  const maxPages = opts.maxPages ?? 50;
  const since = brand.eventsPulledAt ? new Date(brand.eventsPulledAt.getTime() - 24 * 3600_000) : new Date(0);
  let cursor: string | null = source.isMock ? null : (brand.eventsCursor ?? null);
  let pages = 0;
  let rowsSeen = 0;
  let rowsRejected = 0;
  let eventsUpserted = 0;
  let lastCursor: string | null = null;

  do {
    const page = await source.fetchPage(since, cursor, limit);
    pages++;
    for (const raw of page.rows) {
      rowsSeen++;
      const parsed = exportRowSchema.safeParse(raw);
      if (!parsed.success) {
        rowsRejected++;
        continue;
      }
      const r = parsed.data;
      for (const { stage, at } of STAGES) {
        const when = at(r);
        if (!when) continue;
        await db
          .insert(customerEvents)
          .values({
            brandId: brand.id,
            externalCustomerId: r.organizationId,
            stage,
            occurredAt: new Date(when),
            firstTouch: r.acquisition ?? {},
            plan: r.plan ?? null,
          })
          .onConflictDoUpdate({
            target: [customerEvents.brandId, customerEvents.externalCustomerId, customerEvents.stage],
            // The brand app may restate a timestamp or learn the plan later.
            // Attribution is ours and is kept, unless the first touch itself
            // changed, in which case it is forgotten and decided again.
            set: {
              occurredAt: new Date(when),
              firstTouch: r.acquisition ?? {},
              plan: r.plan ?? null,
              attributionMethod: sql`case when ${customerEvents.firstTouch} is distinct from excluded.first_touch then null else ${customerEvents.attributionMethod} end`,
              attributedChannel: sql`case when ${customerEvents.firstTouch} is distinct from excluded.first_touch then null else ${customerEvents.attributedChannel} end`,
              attributedExtObjectId: sql`case when ${customerEvents.firstTouch} is distinct from excluded.first_touch then null else ${customerEvents.attributedExtObjectId} end`,
            },
          });
        eventsUpserted++;
      }
    }
    lastCursor = page.next;
    cursor = page.next;
  } while (cursor && pages < maxPages);

  if (!source.isMock) {
    if (lastCursor) {
      // Stopped at the page cap: remember where, finish next time.
      await db.update(brands).set({ eventsCursor: lastCursor }).where(eq(brands.id, brand.id));
    } else {
      await db.update(brands).set({ eventsCursor: null, eventsPulledAt: sql`now()` }).where(eq(brands.id, brand.id));
    }
  }
  return { pages, rowsSeen, rowsRejected, eventsUpserted, cursor: lastCursor, isMock: source.isMock };
}
