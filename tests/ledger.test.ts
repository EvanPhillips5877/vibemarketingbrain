import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandSummary, campaignsTable } from "../src/analytics/ledger.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { brands, customerEvents, metricsDaily, type Brand } from "../src/db/schema.js";
import { isoDay } from "../src/ingest/metrics.js";
import { syncBrand } from "../src/ingest/sync.js";
import { devLogin, makeContext } from "./helpers.js";

describe("ledger and the Today/Campaigns API", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  let brand: Brand;
  let cookie = "";
  let csrf = "";

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    await seedMockChannelAccount(db, r.brandId);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId));
    // Earlier test files may have pulled already; start this one from scratch.
    await db.update(brands).set({ eventsPulledAt: null, eventsCursor: null, eventsExportUrl: null }).where(eq(brands.id, r.brandId));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(() => ctx.handle.close());

  it("syncBrand runs the whole read side with the mock adapter and mock funnel", async () => {
    const report = await syncBrand(db, registry, brand!, { metricDays: 14, env: {} });
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]).toMatchObject({ channel: "mock", isMock: true });
    expect(report.accounts[0]!.metricRows).toBeGreaterThan(0);
    expect(report.events.isMock).toBe(true);
    expect(report.events.rowsRejected).toBe(0);
    expect(report.events.eventsUpserted).toBeGreaterThan(0);
    expect(report.attribution.byMethod.utm_content).toBeGreaterThan(0);
  });

  it("summary totals equal the sum of channels and ratios are null-safe", async () => {
    const w = { from: isoDay(13), to: isoDay(0), timezone: "America/Toronto" };
    const s = await brandSummary(db, brand!.id, w);
    const sum = (k: "spendMicros" | "registered" | "paid" | "clicks") => s.byChannel.reduce((a, c) => a + c[k], 0);
    expect(s.totals.spendMicros).toBe(sum("spendMicros"));
    expect(s.totals.clicks).toBe(sum("clicks"));
    expect(s.totals.spendMicros).toBeGreaterThan(0);
    expect(s.totals.registered).toBeGreaterThan(0);
    expect(s.totals.cpaMicros).toBe(Math.round(s.totals.spendMicros / s.totals.registered));
    if (s.totals.paid === 0) expect(s.totals.cacMicros).toBeNull();
    expect(s.attribution.attributedToAd + s.attribution.attributedToChannelOnly + s.attribution.unattributed + s.attribution.pending).toBe(s.attribution.registered);
    expect(s.attribution.pending).toBe(0);
    const empty = await brandSummary(db, brand!.id, { from: "2000-01-01", to: "2000-01-02", timezone: "America/Toronto" });
    expect(empty.totals).toMatchObject({ spendMicros: 0, registered: 0, cpaMicros: null, cacMicros: null });
  });

  it("campaign rows roll ads up through their ad group and agree with the channel total", async () => {
    const w = { from: isoDay(13), to: isoDay(0), timezone: "America/Toronto" };
    const rows = await campaignsTable(db, brand!.id, w);
    const s = await brandSummary(db, brand!.id, w);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.reduce((a, r) => a + r.spendMicros, 0)).toBe(s.totals.spendMicros);
    expect(rows.reduce((a, r) => a + r.registered, 0)).toBe(s.attribution.attributedToAd);
    const spring = rows.find((r) => r.name?.startsWith("Spring"))!;
    expect(spring.spendMicros).toBeGreaterThan(0);
    expect(spring.cpaMicros).toBe(spring.registered > 0 ? Math.round(spring.spendMicros / spring.registered) : null);
    const paused = rows.find((r) => r.name?.startsWith("Volleyball"))!;
    expect(paused.spendMicros).toBe(0); // paused since the epoch in the fixture
    const [anyMetric] = await db.select().from(metricsDaily).limit(1);
    expect(anyMetric).toBeDefined();
  });

  it("counts an event by the brand's local day, not the UTC day", async () => {
    // 23:30 in Toronto on the 10th is 03:30 UTC on the 11th.
    await db.insert(customerEvents).values({ brandId: brand!.id, externalCustomerId: "late-night", stage: "registered", occurredAt: new Date("2026-09-11T03:30:00Z"), firstTouch: {}, attributionMethod: "unattributed" });
    const tenth = await brandSummary(db, brand!.id, { from: "2026-09-10", to: "2026-09-10", timezone: "America/Toronto" });
    const eleventh = await brandSummary(db, brand!.id, { from: "2026-09-11", to: "2026-09-11", timezone: "America/Toronto" });
    expect(tenth.totals.registered).toBe(1);
    expect(eleventh.totals.registered).toBe(0);
    const utc = await brandSummary(db, brand!.id, { from: "2026-09-11", to: "2026-09-11", timezone: "UTC" });
    expect(utc.totals.registered).toBe(1);
    await db.delete(customerEvents).where(eq(customerEvents.externalCustomerId, "late-night"));
  });

  it("serves Today and Campaigns to a signed-in user only, and validates the window", async () => {
    expect((await request(ctx.app).get(`/api/brands/${brand!.slug}/today`)).status).toBe(401);
    const today = await request(ctx.app).get(`/api/brands/${brand!.slug}/today?days=14`).set("Cookie", cookie);
    expect(today.status).toBe(200);
    expect(today.body.brand).toMatchObject({ slug: "tryoutbrain", currency: "CAD", eventsSourceIsMock: true });
    expect(today.body.brand.lastSyncAt).not.toBeNull(); // syncBrand ran in the first case
    expect(today.body.summary.totals.spendMicros).toBeGreaterThan(0);
    expect((await request(ctx.app).get(`/api/brands/${brand!.slug}/today?days=0`).set("Cookie", cookie)).status).toBe(404);
    const campaigns = await request(ctx.app).get(`/api/brands/${brand!.slug}/campaigns?days=14`).set("Cookie", cookie);
    expect(campaigns.status).toBe(200);
    expect(campaigns.body.campaigns.length).toBeGreaterThan(0);
    expect((await request(ctx.app).get(`/api/brands/nope/campaigns`).set("Cookie", cookie)).status).toBe(404);
  });

  it("sync now needs the CSRF token and reports what it did", async () => {
    expect((await request(ctx.app).post(`/api/brands/${brand!.slug}/sync`).set("Cookie", cookie)).status).toBe(403);
    const res = await request(ctx.app).post(`/api/brands/${brand!.slug}/sync`).set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(res.status).toBe(200);
    expect(res.body.brand).toBe("tryoutbrain");
    expect(res.body.events.isMock).toBe(true);
  });
});
