import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockAiClient } from "../src/ai/client.js";
import { mockAnalysis } from "../src/ai/analyst.js";
import { validateClaims } from "../src/ai/claims.js";
import { cpaDrift, dailyCap, fatigue, pacing, platformStatus, runDetectors, zeroConversionSpend } from "../src/analytics/detectors.js";
import { buildMetricPack, entryIndex, renderPack, type MetricPack, type PackEntry } from "../src/analytics/metricPack.js";
import { analyzeBrand, latestReport } from "../src/analytics/morning.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { analysisReports, brands, customerEvents, type Brand } from "../src/db/schema.js";
import { syncBrand } from "../src/ingest/sync.js";
import { devLogin, makeContext } from "./helpers.js";

const e = (id: string, value: number | null, unit: PackEntry["unit"], scope: PackEntry["scope"], extra: Partial<PackEntry> = {}): PackEntry => ({ id, label: scope.name ?? id, value, unit, window: "7d", scope, ...extra });
const basePack = (entries: PackEntry[], ctx: Partial<MetricPack["context"]> = {}, today = "2026-10-10"): MetricPack => ({
  brandId: "b",
  currency: "CAD",
  generatedAt: `${today}T12:00:00Z`,
  windows: { current: { from: "2026-10-03", to: "2026-10-09", timezone: "UTC" }, previous: { from: "2026-09-26", to: "2026-10-02", timezone: "UTC" }, trailing: { from: "2026-09-05", to: "2026-10-02", timezone: "UTC" }, monthToDate: { from: "2026-10-01", to: today, timezone: "UTC" } },
  context: { targetCacMicros: null, monthlyBudgetMicros: null, maxDailySpendMicros: null, minConversions: 10, ...ctx },
  entries,
});
const run = (pack: MetricPack) => runDetectors(pack, entryIndex(pack));

describe("detectors (pure)", () => {
  it("pacing flags over- and under-spend against the pro-rata monthly budget", () => {
    const budget = 1_500_000_000; // 1500/month; Oct 10 → pro rata ≈ 483.87
    const withMtd = (micros: number) => basePack([e("brand.spend.mtd", micros, "micros", { level: "brand" })], { monthlyBudgetMicros: budget });
    const sev = (micros: number) => pacing(withMtd(micros), entryIndex(withMtd(micros))).map((f) => f.severity);
    expect(sev(700_000_000)).toEqual(["warning"]);
    expect(sev(100_000_000)).toEqual(["info"]);
    expect(sev(480_000_000)).toEqual([]);
  });
  it("dailyCap compares the live daily budget (campaigns or their ad sets) against the cap", () => {
    const entries = [e("brand.daily_budget.live", 50_000_000, "micros", { level: "brand" }, { window: "now" }), e("campaign:c1.daily_budget", 50_000_000, "micros", { level: "campaign", name: "A" }, { window: "now", note: "ACTIVE" })];
    const over = basePack(entries, { maxDailySpendMicros: 45_000_000 });
    const f = dailyCap(over, entryIndex(over));
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toEqual(["brand.daily_budget.live", "campaign:c1.daily_budget"]);
    const under = basePack(entries, { maxDailySpendMicros: 75_000_000 });
    expect(dailyCap(under, entryIndex(under))).toEqual([]);
  });
  it("zeroConversionSpend proposes a pause only above the threshold with zero registrations", () => {
    const ad = { level: "ad" as const, name: "Ad X", extObjectId: "x" };
    const pack = basePack([e("ad:x1.spend.7d", 70_000_000, "micros", ad), e("ad:x1.registered.7d", 0, "count", ad), e("ad:x2.spend.7d", 70_000_000, "micros", ad), e("ad:x2.registered.7d", 2, "count", ad), e("ad:x3.spend.7d", 20_000_000, "micros", ad), e("ad:x3.registered.7d", 0, "count", ad)]);
    const f = zeroConversionSpend(pack, entryIndex(pack));
    expect(f).toHaveLength(1);
    expect(f[0]?.suggested).toMatchObject({ type: "PAUSE_AD", payload: { kind: "ad", extObjectId: "x" } });
    expect(f[0]?.evidence).toEqual(["ad:x1.spend.7d", "ad:x1.registered.7d"]);
    // With a target CAC of 15, the threshold is 15: x3 (20 spent) now qualifies.
    const pack2 = basePack(pack.entries, { targetCacMicros: 15_000_000 });
    expect(zeroConversionSpend(pack2, entryIndex(pack2)).map((x) => x.evidence[0])).toEqual(["ad:x1.spend.7d", "ad:x3.spend.7d"]);
  });
  it("cpaDrift compares a campaign to its own 28 days and stays quiet on thin data", () => {
    const c = { level: "campaign" as const, name: "Spring", extObjectId: "c" };
    const up = basePack([e("campaign:c.cpa.7d", 45_000_000, "micros", c), e("campaign:c.cpa.28d", 25_000_000, "micros", c, { window: "28d" })]);
    expect(cpaDrift(up, entryIndex(up))[0]).toMatchObject({ severity: "warning", evidence: ["campaign:c.cpa.7d", "campaign:c.cpa.28d"] });
    const thin = basePack([e("campaign:c.cpa.7d", 45_000_000, "micros", c, { insufficient: true }), e("campaign:c.cpa.28d", 25_000_000, "micros", c, { window: "28d" })]);
    expect(cpaDrift(thin, entryIndex(thin))).toEqual([]);
    const down = basePack([e("campaign:c.cpa.7d", 12_000_000, "micros", c), e("campaign:c.cpa.28d", 25_000_000, "micros", c, { window: "28d" })]);
    expect(cpaDrift(down, entryIndex(down))[0]?.severity).toBe("info");
    const zeroBase = basePack([e("campaign:c.cpa.7d", 12_000_000, "micros", c), e("campaign:c.cpa.28d", 0, "micros", c, { window: "28d" })]);
    expect(cpaDrift(zeroBase, entryIndex(zeroBase))).toEqual([]);
  });
  it("fatigue needs high frequency and a real CTR drop, and says it is not proof", () => {
    const ad = { level: "ad" as const, name: "Ad F", extObjectId: "f" };
    const pack = basePack([e("ad:f.frequency.7d", 3.4, "ratio", ad), e("ad:f.ctr.7d", 1.0, "pct", ad), e("ad:f.ctr.prev7d", 2.0, "pct", ad, { window: "prev7d" })]);
    const f = fatigue(pack, entryIndex(pack));
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toMatch(/not proof/);
    const low = basePack([e("ad:f.frequency.7d", 1.4, "ratio", ad), e("ad:f.ctr.7d", 1.0, "pct", ad), e("ad:f.ctr.prev7d", 2.0, "pct", ad, { window: "prev7d" })]);
    expect(fatigue(low, entryIndex(low))).toEqual([]);
  });
  it("platformStatus reports disapproved ads as serious", () => {
    const ad = { level: "ad" as const, name: "Ad D", extObjectId: "d" };
    const pack = basePack([e("ad:d.spend.7d", 0, "micros", ad, { note: "DISAPPROVED" })]);
    expect(platformStatus(pack, entryIndex(pack))[0]).toMatchObject({ severity: "serious" });
  });
  it("runDetectors orders serious first and every finding cites pack ids", () => {
    const ad = { level: "ad" as const, name: "Ad", extObjectId: "z" };
    const pack = basePack([e("ad:z.spend.7d", 70_000_000, "micros", ad, { note: "DISAPPROVED" }), e("ad:z.registered.7d", 0, "count", ad)]);
    const out = run(pack);
    expect(out.map((f) => f.severity)).toEqual(["serious", "warning"]);
    const ids = entryIndex(pack);
    for (const f of out) for (const id of f.evidence) expect(ids.has(id)).toBe(true);
  });
});

describe("metric pack, analyst and report (db, mock data)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const ai = new MockAiClient(db);
  let brand: Brand;
  let cookie = "";
  let csrf = "";
  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    await seedMockChannelAccount(db, r.brandId);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId));
    await db.delete(analysisReports).where(eq(analysisReports.brandId, r.brandId));
    await db.update(brands).set({ eventsPulledAt: null, eventsCursor: null, eventsExportUrl: null }).where(eq(brands.id, r.brandId));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    await syncBrand(db, new AdapterRegistry(ctx.config), brand, { metricDays: 35, env: {} });
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(() => ctx.handle.close());

  it("builds a pack whose every entry has an id, and whose deltas agree with its windows", async () => {
    const pack = await buildMetricPack(db, brand.id);
    expect(pack.entries.length).toBeGreaterThan(30);
    const ids = pack.entries.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Object ids are ours, not the platform's: two accounts may reuse an external id.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const x of pack.entries) if (x.scope.level === "ad" || x.scope.level === "campaign") expect(x.id.split(":")[1]!.split(".")[0]).toMatch(uuid);
    const by = entryIndex(pack);
    expect(by.get("brand.spend.7d")!.value).toBeGreaterThan(0);
    const cur = by.get("brand.spend.7d")!.value!;
    const prev = by.get("brand.spend.prev7d")!.value!;
    expect(by.get("brand.spend.delta_pct")!.value).toBe(Math.round(((cur - prev) / prev) * 1000) / 10);
    expect(by.get("brand.cac.7d")!.insufficient).toBe(by.get("brand.paid.7d")!.value! < 10);
    expect(pack.context.monthlyBudgetMicros).toBe(1_500_000_000);
    const rendered = renderPack(pack);
    expect(rendered).toContain("brand.spend.7d |");
    expect(rendered).toMatch(/INSUFFICIENT_DATA/);
  });

  it("mock analysis is admissible against its own pack", async () => {
    const pack = await buildMetricPack(db, brand.id);
    const findings = run(pack);
    expect(validateClaims(mockAnalysis(pack, findings), pack)).toEqual([]);
  });

  it("analyzeBrand writes a report with findings, claims and evidence that resolve", async () => {
    const r = await analyzeBrand(db, ai, brand.id, { actor: "test" });
    expect(r.isMock).toBe(true);
    expect(r.dropped).toEqual([]);
    const report = await latestReport(db, brand.id);
    expect(report?.id).toBe(r.report.id);
    const analysis = report!.analysis as { claims: { evidence: string[] }[] };
    const ids = new Set((report!.pack as { entries: { id: string }[] }).entries.map((x) => x.id));
    expect(analysis.claims.length).toBeGreaterThan(0);
    for (const c of analysis.claims) for (const id of c.evidence) expect(ids.has(id)).toBe(true);
  });

  it("serves the latest report and runs analysis on demand behind session + CSRF", async () => {
    expect((await request(ctx.app).get(`/api/brands/${brand.slug}/report`)).status).toBe(401);
    const res = await request(ctx.app).get(`/api/brands/${brand.slug}/report`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.report.analysis.headline).toMatch(/Mock analysis/);
    expect(res.body.report.pack.entries.length).toBeGreaterThan(0);
    expect((await request(ctx.app).post(`/api/brands/${brand.slug}/analyze`).set("Cookie", cookie)).status).toBe(403);
    const ok = await request(ctx.app).post(`/api/brands/${brand.slug}/analyze`).set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(ok.status).toBe(200);
    expect(ok.body.isMock).toBe(true);
  });
});
