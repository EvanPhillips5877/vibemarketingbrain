import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { channelAccounts, extObjects, metricsDaily, type ChannelAccount } from "../src/db/schema.js";
import { isoDay, syncMetrics } from "../src/ingest/metrics.js";
import { syncStructure } from "../src/ingest/structure.js";
import { makeContext } from "./helpers.js";

describe("ingest: mock account → ext_objects / metrics_daily", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  const adapter = registry.get("mock")!;
  let account: ChannelAccount;

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    account = await seedMockChannelAccount(db, r.brandId);
    await db.delete(extObjects).where(eq(extObjects.channelAccountId, account.id));
  });
  afterAll(() => ctx.handle.close());

  it("registry hands out the mock for meta/google while they have no credentials, and nothing for reddit", () => {
    expect(registry.get("meta")?.isMock).toBe(true);
    expect(registry.get("google")?.isMock).toBe(true);
    expect(registry.isMocked("meta")).toBe(true);
    expect(registry.get("reddit")).toBeNull();
  });

  it("mirrors structure, then updates in place on re-sync", async () => {
    const first = await syncStructure(db, adapter, account);
    expect(first.seen).toBeGreaterThan(0);
    expect(first.inserted).toBe(first.seen);
    const rows = await db.select().from(extObjects).where(eq(extObjects.channelAccountId, account.id));
    expect(rows).toHaveLength(first.seen);
    expect(rows.filter((r) => r.kind === "campaign").length).toBeGreaterThan(0);

    const second = await syncStructure(db, adapter, account);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.seen);
    expect(await db.select().from(extObjects).where(eq(extObjects.channelAccountId, account.id))).toHaveLength(first.seen);
    const [acct] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, account.id));
    expect(acct?.lastSyncedAt).not.toBeNull();
  });

  it("keeps our join columns when the platform restates an object", async () => {
    const [ad] = await db.select().from(extObjects).where(eq(extObjects.kind, "ad")).limit(1);
    const missionId = "11111111-1111-1111-1111-111111111111";
    await db.update(extObjects).set({ missionId }).where(eq(extObjects.id, ad!.id));
    await syncStructure(db, adapter, account);
    const [after] = await db.select().from(extObjects).where(eq(extObjects.id, ad!.id));
    expect(after?.missionId).toBe(missionId);
  });

  it("reflects a platform-side change (pause) on the next sync", async () => {
    const [campaign] = await db.select().from(extObjects).where(eq(extObjects.status, "ACTIVE")).limit(1);
    await adapter.execute({ ...account, secretRef: null }, { type: "PAUSE_AD", kind: campaign!.kind as "campaign", externalId: campaign!.externalId });
    await syncStructure(db, adapter, account);
    const [after] = await db.select().from(extObjects).where(eq(extObjects.id, campaign!.id));
    expect(after?.status).toBe("PAUSED");
    await adapter.execute({ ...account, secretRef: null }, { type: "ACTIVATE", kind: campaign!.kind as "campaign", externalId: campaign!.externalId });
  });

  it("upserts a 7-day window and restates it without duplicates", async () => {
    const from = isoDay(7);
    const to = isoDay(1);
    const r = await syncMetrics(db, adapter, account, from, to);
    expect(r.orphaned).toBe(0);
    expect(r.rows).toBeGreaterThan(0);
    const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(metricsDaily))[0]!.n;
    const n1 = await count();
    const r2 = await syncMetrics(db, adapter, account, from, to);
    expect(r2.rows).toBe(r.rows);
    expect(await count()).toBe(n1);
    const dates = await db.selectDistinct({ date: metricsDaily.date }).from(metricsDaily);
    expect(dates.map((d) => d.date).sort()).toEqual([...Array(7)].map((_, i) => isoDay(7 - i)).sort());
  });

  it("does not restate history to zero when an object is paused after the fact", async () => {
    const from = isoDay(7);
    const to = isoDay(1);
    await syncMetrics(db, adapter, account, from, to);
    const [campaign] = await db.select().from(extObjects).where(eq(extObjects.status, "ACTIVE")).limit(1);
    const spendBefore = async () =>
      (await db.select({ s: sql<number>`coalesce(sum(spend_micros),0)::bigint` }).from(metricsDaily))[0]!.s;
    const before = Number(await spendBefore());
    expect(before).toBeGreaterThan(0);
    await adapter.execute({ ...account, secretRef: null }, { type: "PAUSE_AD", kind: campaign!.kind as "campaign", externalId: campaign!.externalId });
    await syncMetrics(db, adapter, account, from, to);
    expect(Number(await spendBefore())).toBe(before);
    await adapter.execute({ ...account, secretRef: null }, { type: "ACTIVATE", kind: campaign!.kind as "campaign", externalId: campaign!.externalId });
  });

  it("counts metrics for unknown objects as orphaned instead of failing", async () => {
    await db.delete(extObjects).where(eq(extObjects.kind, "ad"));
    const r = await syncMetrics(db, adapter, account, isoDay(2), isoDay(1));
    expect(r.rows).toBe(0);
    expect(r.orphaned).toBeGreaterThan(0);
    await syncStructure(db, adapter, account);
  });

  it("rejects an inverted window", async () => {
    await expect(syncMetrics(db, adapter, account, "2026-09-10", "2026-09-01")).rejects.toThrow(/after/);
  });
});
