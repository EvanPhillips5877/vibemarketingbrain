import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMetaChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import type { AccountRef } from "../src/channels/adapter.js";
import { GraphClient, MetaApiError, usagePct } from "../src/channels/meta/graph.js";
import { actionsToConversions, idempotencyTag, MetaAdapter, minorToMicros, normalizeStatus, spendToMicros } from "../src/channels/meta/index.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { loadConfig } from "../src/config.js";
import { channelAccounts, extObjects, metricsDaily, type ChannelAccount } from "../src/db/schema.js";
import { syncMetrics } from "../src/ingest/metrics.js";
import { syncStructure } from "../src/ingest/structure.js";
import { makeContext } from "./helpers.js";
import { fakeGraph } from "./meta.fixture.js";

const TOKEN = "EAAtest-not-a-real-token-0123456789";
const env = { META_TEST_TOKEN: TOKEN };
const account: AccountRef = { id: "00000000-0000-0000-0000-000000000003", channel: "meta", externalAccountId: "act_1082877204521539", currency: "CAD", timezone: "America/Toronto", secretRef: "META_TEST_TOKEN" };
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("meta adapter: pure pieces", () => {
  it("normalizes Meta's statuses to the six the system knows", () => {
    expect(normalizeStatus("ACTIVE", "ACTIVE")).toBe("ACTIVE");
    expect(normalizeStatus("CAMPAIGN_PAUSED", "ACTIVE")).toBe("PAUSED");
    expect(normalizeStatus("ARCHIVED", undefined)).toBe("REMOVED");
    expect(normalizeStatus("WITH_ISSUES", "ACTIVE")).toBe("DISAPPROVED");
    expect(normalizeStatus("PENDING_REVIEW", "ACTIVE")).toBe("PENDING_REVIEW");
    expect(normalizeStatus(undefined, "PAUSED")).toBe("PAUSED");
    expect(normalizeStatus("SOMETHING_NEW", undefined)).toBe("OTHER");
  });
  it("converts budgets from minor units and spend from decimal strings", () => {
    expect(minorToMicros("3000")).toBe(30_000_000); // CA$30.00/day
    expect(minorToMicros(undefined)).toBeNull();
    expect(minorToMicros("")).toBeNull();
    expect(spendToMicros("12.57")).toBe(12_570_000);
    expect(spendToMicros(undefined)).toBe(0);
  });
  it("sums lead-type actions into our registration count and keeps the raw action types", () => {
    // "lead" aggregates its pixel component: the same two events must not count twice.
    const c = actionsToConversions([{ action_type: "lead", value: "2" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "2" }, { action_type: "link_click", value: "30" }]);
    expect(c).toEqual({ lead: 2, "offsite_conversion.fb_pixel_lead": 2, link_click: 30, registration: 2 });
    // Without the aggregate, the component stands in; a registration event is a separate thing and adds.
    expect(actionsToConversions([{ action_type: "offsite_conversion.fb_pixel_lead", value: "1" }, { action_type: "complete_registration", value: "3" }])["registration"]).toBe(4);
    expect(actionsToConversions(undefined)).toEqual({});
  });
  it("derives a short stable name marker from an idempotency key", () => {
    expect(idempotencyTag("experiment-abc")).toBe(idempotencyTag("experiment-abc"));
    expect(idempotencyTag("experiment-abc")).not.toBe(idempotencyTag("experiment-abd"));
    expect(idempotencyTag("x")).toMatch(/^#[0-9a-f]{10}$/);
  });
  it("reads the highest usage percentage out of Meta's throttling headers", () => {
    const h = new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "ads_management", call_count: 12, total_cputime: 80, total_time: 5 }] }), "x-app-usage": JSON.stringify({ call_count: 40, total_cputime: 1, total_time: 1 }) });
    expect(usagePct(h)).toBe(80);
    expect(usagePct(new Headers({ "x-ad-account-usage": "not json" }))).toBe(0);
  });
});

describe("graph client: transport discipline", () => {
  it("sends the token only in the Authorization header, paginates with cursors, and never puts it in an error", async () => {
    const fake = fakeGraph();
    const g = new GraphClient({ token: TOKEN, fetchImpl: fake.fetchImpl, sleep: async () => {} });
    const all = await collect(g.paginate<{ id: string }>("act_1082877204521539/campaigns", { fields: "id,name" }));
    expect(all.map((c) => c.id)).toEqual(["120001", "120002", "120003"]);
    expect(fake.requests.length).toBe(2); // page size 2 → two requests
    for (const r of fake.requests) {
      expect(r.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.url).toMatch(/^https:\/\/graph\.facebook\.com\/v21\.0\//);
    }
    await expect(g.get("act_1082877204521539/nothing-here")).rejects.toSatisfy((e: unknown) => e instanceof MetaApiError && e.code === 100 && !e.message.includes(TOKEN));
  });
  it("backs off when usage passes 75% and retries throttling errors with a pause", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const hot = fakeGraph({ usagePct: 90 });
    const g = new GraphClient({ token: TOKEN, fetchImpl: hot.fetchImpl, sleep });
    await g.get("act_1082877204521539", { fields: "name" });
    await g.get("act_1082877204521539", { fields: "name" });
    expect(sleeps).toEqual([20_000]); // the first response was hot, so the second call waited
    expect(g.stats.backoffs).toBe(1);

    const throttled = fakeGraph({ throttleFirst: 2 });
    const g2 = new GraphClient({ token: TOKEN, fetchImpl: throttled.fetchImpl, sleep });
    const r = await g2.get<{ name: string }>("act_1082877204521539", { fields: "name" });
    expect(r.name).toBe("TryoutBrain");
    expect(g2.stats.retries).toBe(2);
    expect(throttled.requests).toHaveLength(3);

    const hopeless = fakeGraph({ throttleFirst: 10 });
    const g3 = new GraphClient({ token: TOKEN, fetchImpl: hopeless.fetchImpl, sleep, maxRetries: 2 });
    await expect(g3.get("act_1082877204521539")).rejects.toBeInstanceOf(MetaApiError);
    expect(hopeless.requests).toHaveLength(3); // 1 + 2 retries, then it gives up
  });
});

describe("meta adapter: reads against recorded fixtures", () => {
  it("mirrors campaigns, ad sets and ads with normalized status, budgets in micros, and redacted raw", async () => {
    const fake = fakeGraph();
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env });
    const objects = await collect(a.syncStructure(account));
    expect(objects.map((o) => `${o.kind}:${o.externalId}:${o.status}`)).toEqual(["campaign:120001:ACTIVE", "campaign:120002:PAUSED", "campaign:120003:REMOVED", "ad_group:130001:ACTIVE", "ad_group:130002:PAUSED", "ad:140001:ACTIVE", "ad:140002:DISAPPROVED", "ad:140003:PAUSED"]);
    const spring = objects.find((o) => o.externalId === "120001")!;
    expect(spring.dailyBudgetMicros).toBe(30_000_000);
    expect(spring.settings["objective"]).toBe("OUTCOME_TRAFFIC");
    const set = objects.find((o) => o.externalId === "130001")!;
    expect(set.parentExternalId).toBe("120001");
    expect(set.settings["geos"]).toEqual(["CA"]);
    expect(set.dailyBudgetMicros).toBeNull(); // campaign-level budget
    const ad = objects.find((o) => o.externalId === "140001")!;
    expect(ad.parentExternalId).toBe("130001");
    expect(ad.settings["landingUrl"]).toBe("https://tryoutbrain.com/?utm_content={{ad.id}}");
    expect(JSON.stringify(ad.raw)).not.toContain("should-never-leak");
    expect(JSON.stringify(ad.raw)).toContain("[redacted]");
    // The adapter asks for fields explicitly and nothing in a URL carries the token.
    expect(fake.requests.every((r) => r.url.includes("fields=") && !r.url.includes(TOKEN))).toBe(true);
  });

  it("turns ad-level insights into one row per ad per day inside the window, link clicks preferred", async () => {
    const fake = fakeGraph();
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env });
    const rows = await collect(a.fetchDailyMetrics(account, "2026-09-01", "2026-09-03"));
    expect(rows).toHaveLength(6);
    const first = rows.find((r) => r.externalId === "140001" && r.date === "2026-09-01")!;
    expect(first).toMatchObject({ kind: "ad", impressions: 1000, clicks: 30, spendMicros: 12_500_000, reach: 800, frequency: 1.25 });
    expect(first.platformConversions).toMatchObject({ lead: 2, registration: 2, link_click: 30 });
    expect(first.raw).toMatchObject({ allClicks: 40, linkClicks: 30 });
    const noLink = rows.find((r) => r.externalId === "140002" && r.date === "2026-09-02")!;
    expect(noLink.clicks).toBe(20); // falls back to all clicks
    expect(noLink.platformConversions).toEqual({});
    const insightsUrl = fake.requests.find((r) => r.url.includes("/insights"))!.url;
    expect(decodeURIComponent(insightsUrl)).toContain('"since":"2026-09-01","until":"2026-09-03"');
    expect(insightsUrl).toContain("level=ad");
    expect(insightsUrl).toContain("time_increment=1");
  });

  it("finds a created object by its name marker, scoped by kind, and reads one object's live state", async () => {
    const fake = fakeGraph({ missingIds: ["999999"] });
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env });
    // The fixture's archived campaign carries the marker for this key.
    expect((await a.findByIdempotencyKey(account, "campaign", "old-test-key"))?.externalId).toBe("120003");
    expect(await a.findByIdempotencyKey(account, "campaign", "no-such-key")).toBeNull();
    expect(await a.findByIdempotencyKey(account, "keyword", "anything")).toBeNull();
    const live = await a.fetchObject(account, "ad", "140002");
    expect(live?.status).toBe("DISAPPROVED");
    expect(await a.fetchObject(account, "ad", "999999")).toBeNull();
  });

  it("refuses every write until Phase 12 and says so, without touching the platform", async () => {
    const fake = fakeGraph();
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env });
    expect(a.capabilities.has("pause_activate")).toBe(false);
    expect(a.capabilities.has("create_campaign")).toBe(false);
    const v = await a.validate(account, { type: "PAUSE_AD", kind: "ad", externalId: "140001" });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/Phase 12/);
    await expect(a.execute(account, { type: "PAUSE_AD", kind: "ad", externalId: "140001" })).rejects.toThrow(/refused/);
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("a rotated token is picked up on the next call instead of the cached client reusing the old one", async () => {
    const fake = fakeGraph();
    const rotating: NodeJS.ProcessEnv = { META_TEST_TOKEN: "EAAfirst-token-0123456789" };
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env: rotating });
    await collect(a.syncStructure(account));
    rotating["META_TEST_TOKEN"] = "EAAsecond-token-0123456789";
    await collect(a.syncStructure(account));
    const auths = [...new Set(fake.requests.map((r) => r.authorization))];
    expect(auths).toEqual(["Bearer EAAfirst-token-0123456789", "Bearer EAAsecond-token-0123456789"]);
    expect(a.statsFor(account)?.calls).toBeGreaterThan(0);
  });

  it("fails clearly when the account's secret is not set, before any network call", async () => {
    const fake = fakeGraph();
    const a = new MetaAdapter({ fetchImpl: fake.fetchImpl, sleep: async () => {}, env: {} });
    await expect(collect(a.syncStructure(account))).rejects.toThrow(/no token under secret ref META_TEST_TOKEN/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("meta adapter: registry and ingest (db)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  let brandId: string;
  let row: ChannelAccount;
  beforeAll(async () => {
    brandId = (await seedTryoutBrain(db)).brandId;
    row = await seedMetaChannelAccount(db, brandId, "1082877204521539", { currency: "CAD", timezone: "America/Toronto" });
  });
  afterAll(async () => {
    await db.delete(channelAccounts).where(eq(channelAccounts.id, row.id)); // ext_objects and metrics cascade
    await ctx.handle.close();
  });

  it("the registry hands out the real adapter only when the token is configured", () => {
    const withToken = loadConfig({ ...process.env, DATABASE_URL: "postgres://x", APP_SECRET: "test-suite-secret-not-real-0123", META_ACCESS_TOKEN: "EAAx", META_AD_ACCOUNT_ID: "1082877204521539" });
    expect(withToken.mock.meta).toBe(false);
    expect(withToken.meta.adAccountId).toBe("act_1082877204521539");
    const reg = new AdapterRegistry(withToken);
    reg.register(new MetaAdapter({ fetchImpl: fakeGraph().fetchImpl, env }));
    expect(reg.get("meta")?.isMock).toBe(false);
    const without = new AdapterRegistry(loadConfig({ ...process.env, DATABASE_URL: "postgres://x", APP_SECRET: "test-suite-secret-not-real-0123", META_ACCESS_TOKEN: "" }));
    without.register(new MetaAdapter({ fetchImpl: fakeGraph().fetchImpl, env }));
    expect(without.get("meta")?.isMock).toBe(true); // credentials absent → the mock, whatever is registered
  });

  it("the seeded account row names the secret and holds no token; structure and metrics land in the mirror", async () => {
    expect(row.secretRef).toBe("META_ACCESS_TOKEN");
    expect(row.externalAccountId).toBe("act_1082877204521539");
    expect(JSON.stringify(row)).not.toMatch(/EAA/);
    const a = new MetaAdapter({ fetchImpl: fakeGraph().fetchImpl, sleep: async () => {}, env: { META_ACCESS_TOKEN: TOKEN } });
    const s = await syncStructure(db, a, row);
    expect(s.seen).toBe(8);
    const m = await syncMetrics(db, a, row, "2026-09-01", "2026-09-02");
    expect(m.rows).toBe(4);
    expect(m.orphaned).toBe(0);
    const mirrored = await db.select().from(extObjects).where(eq(extObjects.channelAccountId, row.id));
    expect(mirrored.find((o) => o.externalId === "120001")?.dailyBudgetMicros).toBe(30_000_000);
    const metrics = await db.select().from(metricsDaily).where(eq(metricsDaily.extObjectId, mirrored.find((o) => o.externalId === "140001")!.id));
    expect(metrics).toHaveLength(2);
    expect(metrics[0]!.platformConversions["registration"]).toBe(2);
  });
});
