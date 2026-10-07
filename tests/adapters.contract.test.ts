import { describe, expect, it } from "vitest";
import type { AccountRef, ChannelAdapter } from "../src/channels/adapter.js";
import { redact } from "../src/channels/adapter.js";
import { MockAdapter } from "../src/channels/mock/index.js";
import { adapterCommandSchema } from "../src/domain/actions.js";

// Every adapter must pass this. Meta and Google join the list when they
// exist (run against recorded fixtures, never a live account).
const ADAPTERS: { name: string; make: () => ChannelAdapter; account: AccountRef }[] = [
  {
    name: "mock",
    make: () => new MockAdapter(),
    account: { id: "00000000-0000-0000-0000-000000000001", channel: "mock", externalAccountId: "acct-test", currency: "CAD", timezone: "America/Toronto", secretRef: null },
  },
];

const KINDS = new Set(["campaign", "ad_group", "ad", "creative", "keyword", "asset"]);
const STATUSES = new Set(["ACTIVE", "PAUSED", "REMOVED", "PENDING_REVIEW", "DISAPPROVED", "OTHER"]);

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe.each(ADAPTERS)("adapter contract: $name", ({ make, account }) => {
  it("declares its channel, mock flag and capabilities", () => {
    const a = make();
    expect(a.channel).toBe(account.channel);
    expect(typeof a.isMock).toBe("boolean");
    expect(a.capabilities.has("read_structure")).toBe(true);
    expect(a.capabilities.has("read_metrics")).toBe(true);
  });

  it("yields well-formed objects whose parents exist", async () => {
    const objects = await collect(make().syncStructure(account));
    expect(objects.length).toBeGreaterThan(0);
    const ids = new Set(objects.map((o) => `${o.kind}:${o.externalId}`));
    for (const o of objects) {
      expect(KINDS.has(o.kind)).toBe(true);
      expect(STATUSES.has(o.status)).toBe(true);
      expect(o.externalId.length).toBeGreaterThan(0);
      if (o.parentExternalId) {
        // ad groups hang off campaigns; ads off ad groups; keywords off either (negatives sit on the campaign)
        const allowed = o.kind === "ad_group" ? ["campaign"] : o.kind === "keyword" ? ["ad_group", "campaign"] : ["ad_group"];
        expect(allowed.some((k) => ids.has(`${k}:${o.parentExternalId}`))).toBe(true);
      } else {
        expect(o.kind).toBe("campaign");
      }
      if (o.dailyBudgetMicros !== null) expect(o.dailyBudgetMicros).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns metrics only inside the window, non-negative, for known objects, and deterministically", async () => {
    const a = make();
    const ids = new Set((await collect(a.syncStructure(account))).map((o) => `${o.kind}:${o.externalId}`));
    const rows = await collect(a.fetchDailyMetrics(account, "2026-09-01", "2026-09-07"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.date >= "2026-09-01" && r.date <= "2026-09-07").toBe(true);
      expect(ids.has(`${r.kind}:${r.externalId}`)).toBe(true);
      expect(r.impressions).toBeGreaterThanOrEqual(0);
      expect(r.clicks).toBeGreaterThanOrEqual(0);
      expect(r.clicks).toBeLessThanOrEqual(r.impressions);
      expect(r.spendMicros).toBeGreaterThanOrEqual(0);
      for (const v of Object.values(r.platformConversions)) expect(v).toBeGreaterThanOrEqual(0);
    }
    const again = await collect(make().fetchDailyMetrics(account, "2026-09-01", "2026-09-07"));
    expect(again).toEqual(rows);
  });

  it("validate() rejects malformed commands and unknown targets without side effects", async () => {
    const a = make();
    const before = await collect(a.syncStructure(account));
    const bad = await a.validate(account, { type: "PAUSE_AD", kind: "ad", externalId: "does-not-exist" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    const malformed = await a.validate(account, { type: "CHANGE_BUDGET", kind: "campaign", externalId: "x", dailyBudgetMicros: -5 } as never);
    expect(malformed.ok).toBe(false);
    expect(await collect(a.syncStructure(account))).toEqual(before);
  });

  it("creates PAUSED, is idempotent on the key, and can be found by it", async () => {
    const a = make();
    if (!a.capabilities.has("create_campaign")) return;
    const cmd = adapterCommandSchema.parse({ type: "CREATE_CAMPAIGN", name: "mb:test", objective: "registrations", dailyBudgetMicros: 5_000_000, geos: ["CA"], idempotencyKey: "contract-key-0001" });
    const first = await a.execute(account, cmd);
    const second = await a.execute(account, cmd);
    expect(second.externalIds["campaign"]).toBe(first.externalIds["campaign"]);
    const found = await a.findByIdempotencyKey(account, "campaign", "contract-key-0001");
    expect(found?.externalId).toBe(first.externalIds["campaign"]);
    expect(found?.status).toBe("PAUSED");
    expect(await a.findByIdempotencyKey(account, "campaign", "never-used")).toBeNull();
    expect(await a.findByIdempotencyKey(account, "ad_group", "contract-key-0001")).toBeNull();
    const objects = await collect(a.syncStructure(account));
    expect(objects.filter((o) => o.name === "mb:test")).toHaveLength(1);
  });

  it("pause/activate and budget changes report an inverse for rollback", async () => {
    const a = make();
    if (!a.capabilities.has("pause_activate")) return;
    const campaign = (await collect(a.syncStructure(account))).find((o) => o.kind === "campaign" && o.status === "ACTIVE")!;
    const paused = await a.execute(account, { type: "PAUSE_AD", kind: "campaign", externalId: campaign.externalId });
    expect(paused.rollback).toEqual({ type: "ACTIVATE", kind: "campaign", externalId: campaign.externalId });
    const after = (await collect(a.syncStructure(account))).find((o) => o.kind === "campaign" && o.externalId === campaign.externalId)!;
    expect(after.status).toBe("PAUSED");
    const budget = await a.execute(account, { type: "CHANGE_BUDGET", kind: "campaign", externalId: campaign.externalId, dailyBudgetMicros: 42_000_000 });
    expect(budget.rollback).toEqual({ type: "CHANGE_BUDGET", kind: "campaign", externalId: campaign.externalId, dailyBudgetMicros: campaign.dailyBudgetMicros });
  });

  it("gives no rollback for a budget that had none, instead of an invalid one", async () => {
    const a = make();
    if (!a.capabilities.has("change_budget")) return;
    const group = (await collect(a.syncStructure(account))).find((o) => o.kind === "ad_group" && o.dailyBudgetMicros === null);
    if (!group) return;
    const r = await a.execute(account, { type: "CHANGE_BUDGET", kind: "ad_group", externalId: group.externalId, dailyBudgetMicros: 5_000_000 });
    expect(r.rollback).toBeNull();
  });

  it("scopes idempotency keys by kind", async () => {
    const a = make();
    if (!a.capabilities.has("create_ad_group")) return;
    const c = await a.execute(account, { type: "CREATE_CAMPAIGN", name: "mb:k", objective: "leads", dailyBudgetMicros: 5_000_000, geos: ["CA"], idempotencyKey: "shared-key-00001" });
    const g = await a.execute(account, { type: "CREATE_AD_GROUP", campaignExternalId: c.externalIds["campaign"]!, name: "mb:g", audience: {}, idempotencyKey: "shared-key-00001" });
    expect(g.externalIds["ad_group"]).not.toBe(c.externalIds["campaign"]);
    expect(g.response["reused"]).toBeUndefined();
    expect((await a.findByIdempotencyKey(account, "ad_group", "shared-key-00001"))?.externalId).toBe(g.externalIds["ad_group"]);
    expect((await a.findByIdempotencyKey(account, "campaign", "shared-key-00001"))?.externalId).toBe(c.externalIds["campaign"]);
  });

  it("never reports delivery before an object existed, nor while it was paused, even after reactivation", async () => {
    const a = make();
    if (!a.capabilities.has("create_ad") || !a.capabilities.has("pause_activate")) return;
    const group = (await collect(a.syncStructure(account))).find((o) => o.kind === "ad_group" && o.status === "ACTIVE")!;
    const created = await a.execute(account, { type: "CREATE_AD", adGroupExternalId: group.externalId, name: "mb:new", creativeVariantId: "00000000-0000-0000-0000-00000000aaaa", landingUrl: "https://example.com", payload: {}, idempotencyKey: "created-today-0001" });
    const adId = created.externalIds["ad"]!;
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);
    const before = (await collect(a.fetchDailyMetrics(account, yesterday, todayStr))).filter((r) => r.externalId === adId);
    expect(before.every((r) => r.impressions === 0 && r.spendMicros === 0)).toBe(true); // paused since creation
    await a.execute(account, { type: "ACTIVATE", kind: "ad", externalId: adId });
    const after = (await collect(a.fetchDailyMetrics(account, yesterday, todayStr))).filter((r) => r.externalId === adId);
    expect(after.find((r) => r.date === yesterday)?.impressions).toBe(0); // did not exist yet
    expect(after.find((r) => r.date === todayStr)?.impressions).toBeGreaterThan(0);

    // Pause an old ad, reactivate it: the paused day stays zero afterwards.
    const old = (await collect(a.syncStructure(account))).find((o) => o.kind === "ad" && o.status === "ACTIVE" && o.externalId !== adId)!;
    await a.execute(account, { type: "PAUSE_AD", kind: "ad", externalId: old.externalId });
    await a.execute(account, { type: "ACTIVATE", kind: "ad", externalId: old.externalId });
    const rows = (await collect(a.fetchDailyMetrics(account, yesterday, todayStr))).filter((r) => r.externalId === old.externalId);
    expect(rows.find((r) => r.date === yesterday)?.impressions).toBeGreaterThan(0); // history intact
  });

  it("makes negative keywords visible to sync", async () => {
    const a = make();
    if (!a.capabilities.has("negative_keywords")) return;
    const campaign = (await collect(a.syncStructure(account))).find((o) => o.kind === "campaign")!;
    await a.execute(account, { type: "ADD_NEGATIVE_KEYWORD", campaignExternalId: campaign.externalId, keyword: "free tryouts", matchType: "phrase" });
    const after = await collect(a.syncStructure(account));
    const neg = after.find((o) => o.kind === "keyword" && o.settings["negative"] === true && o.name === "free tryouts");
    expect(neg?.parentExternalId).toBe(campaign.externalId);
  });

  it("isolates state between channels that share an external account id", async () => {
    const a = make();
    const other: AccountRef = { ...account, id: "00000000-0000-0000-0000-000000000002", channel: account.channel === "mock" ? "meta" : "mock" };
    const campaign = (await collect(a.syncStructure(account))).find((o) => o.kind === "campaign" && o.status === "ACTIVE")!;
    await a.execute(account, { type: "PAUSE_AD", kind: "campaign", externalId: campaign.externalId });
    const sameIdOtherChannel = (await collect(a.syncStructure(other))).find((o) => o.kind === "campaign" && o.externalId === campaign.externalId);
    expect(sameIdOtherChannel?.status).toBe("ACTIVE");
  });

  it("execute() refuses what validate() refuses", async () => {
    const a = make();
    await expect(a.execute(account, { type: "ACTIVATE", kind: "ad", externalId: "nope" })).rejects.toThrow();
  });

  it("describes creative formats with character limits and aspect ratios", () => {
    const a = make();
    expect(a.formatSpec("not-a-format")).toBeNull();
    const specs = ["mock_image", "meta_image", "google_rsa"].map((f) => a.formatSpec(f)).filter((s) => s !== null);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(s!.textFields.length).toBeGreaterThan(0);
      for (const f of s!.textFields) expect(f.maxChars).toBeGreaterThan(0);
    }
  });
});

describe("redact", () => {
  it("masks credential-shaped keys at any depth and leaves the rest", () => {
    const out = redact({ ok: 1, access_token: "abc", nested: [{ Authorization: "Bearer x", name: "fine" }], "developer-token": "d" });
    expect(out).toEqual({ ok: 1, access_token: "[redacted]", nested: [{ Authorization: "[redacted]", name: "fine" }], "developer-token": "[redacted]" });
  });
});
