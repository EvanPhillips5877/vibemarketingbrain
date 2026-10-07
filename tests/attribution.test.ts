import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { customerEvents, extObjects, type Brand, type ChannelAccount } from "../src/db/schema.js";
import { brands } from "../src/db/schema.js";
import { attributeCustomerEvents, decideAttribution, resetUnattributed, type KnownObject } from "../src/ingest/attribute.js";
import { syncStructure } from "../src/ingest/structure.js";
import { makeContext } from "./helpers.js";

const objects: KnownObject[] = [
  { id: "c1", kind: "campaign", externalId: "acct-c1", name: "Spring tryouts - CA", channel: "meta" },
  { id: "g1", kind: "ad_group", externalId: "acct-g1", name: "Coaches", channel: "meta" },
  { id: "a1", kind: "ad", externalId: "acct-a1", name: "Fairness", channel: "meta" },
];

describe("decideAttribution (pure)", () => {
  it("prefers the ad named by utm_content", () => {
    expect(decideAttribution({ utmContent: "ACCT-A1", utmCampaign: "acct-c1", fbclid: "x" }, objects)).toEqual({ extObjectId: "a1", channel: "meta", method: "utm_content" });
  });
  it("falls back to the campaign by id or name", () => {
    expect(decideAttribution({ utmCampaign: "acct-c1" }, objects).extObjectId).toBe("c1");
    expect(decideAttribution({ utmCampaign: "spring tryouts - ca" }, objects)).toMatchObject({ extObjectId: "c1", method: "utm_campaign" });
  });
  it("knows the channel from a bare click id, but not the ad", () => {
    expect(decideAttribution({ gclid: "abc" }, objects)).toEqual({ extObjectId: null, channel: "google", method: "click_id" });
    expect(decideAttribution({ wbraid: "abc" }, objects).channel).toBe("google");
    expect(decideAttribution({ fbclid: "abc" }, objects)).toEqual({ extObjectId: null, channel: "meta", method: "click_id" });
  });
  it("reads the channel from utm_source as a last resort", () => {
    expect(decideAttribution({ utmSource: "Instagram" }, objects)).toMatchObject({ channel: "meta", method: "utm_source" });
    expect(decideAttribution({ utmSource: "google" }, objects)).toMatchObject({ channel: "google", method: "utm_source" });
  });
  it("lets channel evidence veto a name match on another channel, and refuses ambiguous names", () => {
    const two: KnownObject[] = [
      ...objects,
      { id: "gc", kind: "campaign", externalId: "g-c-9", name: "Spring tryouts - CA", channel: "google" },
    ];
    // Same name on Meta and Google: a gclid settles it.
    expect(decideAttribution({ utmCampaign: "Spring tryouts - CA", gclid: "x" }, two)).toEqual({ extObjectId: "gc", channel: "google", method: "utm_campaign" });
    expect(decideAttribution({ utmCampaign: "Spring tryouts - CA", fbclid: "x" }, two)).toEqual({ extObjectId: "c1", channel: "meta", method: "utm_campaign" });
    // No channel evidence and two campaigns with that name: channel unknown, say so.
    expect(decideAttribution({ utmCampaign: "Spring tryouts - CA" }, two)).toEqual({ extObjectId: null, channel: null, method: "unattributed" });
    // An ad id on the wrong channel for the click id is not trusted either.
    expect(decideAttribution({ utmContent: "acct-a1", gclid: "x" }, two)).toEqual({ extObjectId: null, channel: "google", method: "click_id" });
  });

  it("never guesses: nothing known is unattributed", () => {
    expect(decideAttribution({}, objects)).toEqual({ extObjectId: null, channel: null, method: "unattributed" });
    expect(decideAttribution({ utmContent: "unknown-ad", utmCampaign: "nope" }, objects).method).toBe("unattributed");
    expect(decideAttribution({ referrerHost: "google.com" }, objects).method).toBe("unattributed"); // organic is not an ad
  });
});

describe("attributeCustomerEvents (db)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  let brand: Brand;
  let account: ChannelAccount;
  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    account = await seedMockChannelAccount(db, brand!.id);
    await syncStructure(db, new AdapterRegistry(ctx.config).get("mock")!, account);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, brand!.id));
  });
  afterAll(() => ctx.handle.close());

  it("decides every undecided row and leaves decided ones alone", async () => {
    const ad = (await db.select().from(extObjects).where(eq(extObjects.kind, "ad")))[0]!;
    await db.insert(customerEvents).values([
      { brandId: brand!.id, externalCustomerId: "o1", stage: "registered", occurredAt: new Date(), firstTouch: { utmContent: ad.externalId } },
      { brandId: brand!.id, externalCustomerId: "o2", stage: "registered", occurredAt: new Date(), firstTouch: { fbclid: "f" } },
      { brandId: brand!.id, externalCustomerId: "o3", stage: "registered", occurredAt: new Date(), firstTouch: {} },
      { brandId: brand!.id, externalCustomerId: "o4", stage: "registered", occurredAt: new Date(), firstTouch: { utmContent: ad.externalId }, attributionMethod: "unattributed" },
    ]);
    const r = await attributeCustomerEvents(db, brand!.id);
    expect(r.decided).toBe(3);
    expect(r.byMethod).toMatchObject({ utm_content: 1, click_id: 1, unattributed: 1 });
    const rows = await db.select().from(customerEvents).where(eq(customerEvents.brandId, brand!.id));
    expect(rows.find((x) => x.externalCustomerId === "o1")).toMatchObject({ attributedExtObjectId: ad.id, attributedChannel: "mock", attributionMethod: "utm_content" });
    expect(rows.find((x) => x.externalCustomerId === "o4")?.attributionMethod).toBe("unattributed"); // untouched
  });

  it("resetUnattributed lets a later sync retry the weak decisions only", async () => {
    const n = await resetUnattributed(db, brand!.id);
    expect(n).toBe(3); // o2 (click_id), o3 (unattributed), o4 (unattributed)
    const r = await attributeCustomerEvents(db, brand!.id);
    expect(r.decided).toBe(3);
    const o4 = (await db.select().from(customerEvents).where(eq(customerEvents.externalCustomerId, "o4")))[0];
    expect(o4?.attributionMethod).toBe("utm_content"); // now that the ad is known
  });
});
