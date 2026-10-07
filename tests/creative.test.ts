import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProposals } from "../src/actions/proposals.js";
import { MockAiClient } from "../src/ai/client.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { approveVariant, createHypothesis, creativeTree, editVariant, generateForHypothesis, rejectVariant, shipVariants } from "../src/creative/factory.js";
import { copyOf, googleRsaPayloadSchema, metaImagePayloadSchema, parsePayload } from "../src/creative/formats.js";
import { mockHooks, mockMetaVariant, mockRsaVariant } from "../src/creative/generate.js";
import { readAsset, renderOne, wrap } from "../src/creative/render.js";
import { brandAssets, brands, creativeVariants, extObjects, type Brand, type ChannelAccount, type Hypothesis } from "../src/db/schema.js";
import { syncStructure } from "../src/ingest/structure.js";
import { devLogin, makeContext } from "./helpers.js";

const fakeHypothesis = (over: Partial<Hypothesis> = {}): Hypothesis => ({ id: "h", brandId: "b", missionId: null, statement: "Fairness messaging works for volleyball clubs", dimensions: { sport: "volleyball", pain_point: "spreadsheets" }, status: "untested", parentId: null, createdAt: new Date(), ...over });

describe("formats (pure)", () => {
  it("enforce the platforms' character and count limits", () => {
    expect(() => metaImagePayloadSchema.parse({ primaryText: "x".repeat(126), headline: "h", cta: "LEARN_MORE", template: "plain_headline", overlayText: "o" })).toThrow();
    expect(() => googleRsaPayloadSchema.parse({ headlines: ["a", "b"], descriptions: ["d", "d2"], keywords: Array(5).fill({ text: "k", matchType: "phrase" }) })).toThrow(); // 3 headlines min
    expect(() => googleRsaPayloadSchema.parse({ headlines: ["Same", "same", "c"], descriptions: ["d", "d2"], keywords: Array(5).fill({ text: "k", matchType: "phrase" }) })).toThrow(/distinct/);
    const ok = parsePayload("google_rsa", { headlines: ["a", "b", "c"], descriptions: ["d", "e"], keywords: Array(5).fill({ text: "k", matchType: "exact" }) });
    expect(copyOf("google_rsa", ok)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("mock generators always produce payloads inside the limits", () => {
    const brand = { id: "b", name: "TryoutBrain" } as Brand;
    for (let seed = 0; seed < 4; seed++) {
      expect(() => metaImagePayloadSchema.parse(mockMetaVariant(brand, { text: "x".repeat(200), hookType: "pain" }, seed))).not.toThrow();
      expect(() => googleRsaPayloadSchema.parse(mockRsaVariant(brand, { text: "y".repeat(200), hookType: "pain" }, fakeHypothesis({ dimensions: { sport: "s".repeat(80) } }), seed))).not.toThrow();
    }
    expect(mockHooks(fakeHypothesis()).hooks).toHaveLength(3);
  });
});

describe("render (pure)", () => {
  it("wraps text to a line budget and truncates with an ellipsis", () => {
    expect(wrap("stop running tryouts on spreadsheets", 14)).toEqual(["stop running", "tryouts on", "spreadsheets"]);
    const lines = wrap("one two three four five six seven eight nine ten", 9, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
  });
  it("renders every aspect ratio at the right size, with and without a screenshot", async () => {
    const payload = metaImagePayloadSchema.parse({ primaryText: "p", headline: "h", cta: "LEARN_MORE", template: "screenshot_headline", overlayText: "Stop running tryouts on spreadsheets", overlaySubtext: "TryoutBrain" });
    const shot = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#22c55e" } }).png().toBuffer();
    for (const ratio of ["1:1", "4:5", "9:16", "16:9"] as const) {
      const img = await renderOne({ payload, brandName: "TryoutBrain", screenshot: shot }, ratio);
      const meta = await sharp(img.png).metadata();
      expect([meta.width, meta.height]).toEqual([img.width, img.height]);
    }
    const plain = await renderOne({ payload: { ...payload, template: "plain_headline" }, brandName: "TryoutBrain", screenshot: null }, "1:1");
    const again = await renderOne({ payload: { ...payload, template: "plain_headline" }, brandName: "TryoutBrain", screenshot: null }, "1:1");
    expect(plain.png.equals(again.png)).toBe(true); // deterministic
  });
});

describe("factory (db, mock AI)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const ai = new MockAiClient(db);
  const registry = new AdapterRegistry(ctx.config);
  let brand: Brand;
  let account: ChannelAccount;
  let hyp: Hypothesis;
  let cookie = "";
  let csrf = "";

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    account = await seedMockChannelAccount(db, brand.id);
    await syncStructure(db, registry.get("mock")!, account);
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(() => ctx.handle.close());

  it("turns a hypothesis into hooks, creatives and variants, all within limits, rendered in four sizes", async () => {
    hyp = await createHypothesis(db, brand.id, "manual:evan@example.com", { statement: "Fairness messaging with a real Room screenshot works for volleyball clubs", dimensions: { sport: "volleyball", pain_point: "spreadsheets" } });
    const r = await generateForHypothesis(db, ai, brand, hyp.id, { variantsPerHook: 2 });
    expect(r.isMock).toBe(true);
    expect(r.hooks).toBe(3);
    expect(r.creatives).toBe(3);
    expect(r.variants).toBe(12); // 3 hooks × 2 formats × 2
    expect(r.rendered).toBe(24); // 6 meta variants × 4 ratios
    const tree = await creativeTree(db, brand.id);
    expect(tree.variants).toHaveLength(12);
    for (const v of tree.variants) {
      expect(() => parsePayload(v.format as "meta_image" | "google_rsa", v.payload)).not.toThrow();
      expect(v.tags["hook_type"]).toBeDefined();
      if (v.format === "meta_image") {
        expect(v.renderedAssetIds).toHaveLength(4);
        const [asset] = await db.select().from(brandAssets).where(eq(brandAssets.id, v.renderedAssetIds[0]!));
        expect(readAsset(asset!.storageKey)?.length).toBeGreaterThan(1000);
      }
    }
    const [h] = await db.select().from(brands).where(eq(brands.id, brand.id));
    expect(h).toBeDefined();
  });

  it("copy that breaks a brand rule cannot be approved until edited", async () => {
    const tree = await creativeTree(db, brand.id);
    const v = tree.variants.find((x) => x.format === "meta_image")!;
    const bad = await editVariant(db, ai, brand.id, v.id, "manual:evan@example.com", { primaryText: "We guarantee you never miss the right player.", headline: "Guaranteed fair", description: "", cta: "LEARN_MORE", template: "plain_headline", overlayText: "Guaranteed", overlaySubtext: "" });
    expect((bad.payload as { compliance: { ok: boolean } }).compliance.ok).toBe(false);
    await expect(approveVariant(db, brand.id, v.id, "manual:evan@example.com")).rejects.toThrow(/breaks a brand rule/);
    const fixed = await editVariant(db, ai, brand.id, v.id, "manual:evan@example.com", { primaryText: "Every placement has receipts.", headline: "Tryouts, run by voice", description: "", cta: "LEARN_MORE", template: "plain_headline", overlayText: "Every placement has receipts", overlaySubtext: "" });
    expect((fixed.payload as { compliance: { ok: boolean } }).compliance.ok).toBe(true);
    expect(fixed.renderedAssetIds).toHaveLength(4);
    expect((await approveVariant(db, brand.id, v.id, "manual:evan@example.com")).status).toBe("approved");
    await expect(editVariant(db, ai, brand.id, v.id, "manual:evan@example.com", fixed.payload)).rejects.toThrow(/only drafts/);
  });

  it("ten approved variants from one hypothesis ship as CREATE_AD proposals in one group, awaiting approval", async () => {
    const tree = await creativeTree(db, brand.id);
    const drafts = tree.variants.filter((v) => v.status === "draft").slice(0, 9);
    for (const v of drafts) await approveVariant(db, brand.id, v.id, "manual:evan@example.com");
    const approved = (await creativeTree(db, brand.id)).variants.filter((v) => v.status === "approved");
    expect(approved).toHaveLength(10);
    const [group] = await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, "ad_group")));
    const results = await shipVariants(db, brand.id, "manual:evan@example.com", { variantIds: approved.map((v) => v.id), channelAccountId: account.id, adGroupExternalId: group!.externalId, landingUrl: "https://tryoutbrain.com/for/volleyball" });
    expect(results).toHaveLength(10);
    expect(new Set(results.map((r) => r.proposal.groupId)).size).toBe(1);
    expect(results.every((r) => r.proposal.type === "CREATE_AD" && r.proposal.status === "awaiting_approval")).toBe(true);
    const again = await shipVariants(db, brand.id, "manual:evan@example.com", { variantIds: approved.map((v) => v.id), channelAccountId: account.id, adGroupExternalId: group!.externalId, landingUrl: "https://tryoutbrain.com/for/volleyball" });
    expect(again.every((r) => r.duplicate)).toBe(true);
    expect((await listProposals(db, brand.id, ["awaiting_approval"])).filter((p) => p.type === "CREATE_AD")).toHaveLength(10);
  });

  it("shipping refuses drafts and variants from another brand", async () => {
    const tree = await creativeTree(db, brand.id);
    const draft = tree.variants.find((v) => v.status === "draft")!;
    const [group] = await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, "ad_group")));
    await expect(shipVariants(db, brand.id, "manual:x@y.z", { variantIds: [draft.id], channelAccountId: account.id, adGroupExternalId: group!.externalId, landingUrl: "https://x.test" })).rejects.toThrow(/not approved/);
    await expect(shipVariants(db, "00000000-0000-0000-0000-000000000000", "manual:x@y.z", { variantIds: [draft.id], channelAccountId: account.id, adGroupExternalId: group!.externalId, landingUrl: "https://x.test" })).rejects.toThrow();
    await rejectVariant(db, brand.id, draft.id, "manual:evan@example.com", "weak");
    expect((await db.select().from(creativeVariants).where(eq(creativeVariants.id, draft.id)))[0]?.status).toBe("retired");
  });

  it("the API serves the tree and images behind a session, and validates input", async () => {
    expect((await request(ctx.app).get(`/api/brands/${brand.slug}/creative`)).status).toBe(401);
    const tree = await request(ctx.app).get(`/api/brands/${brand.slug}/creative`).set("Cookie", cookie);
    expect(tree.status).toBe(200);
    expect(tree.body.hypotheses).toHaveLength(1);
    const assetId = tree.body.variants.find((v: { format: string }) => v.format === "meta_image").renderedAssetIds[0];
    expect((await request(ctx.app).get(`/api/assets/${assetId}`)).status).toBe(401);
    const img = await request(ctx.app).get(`/api/assets/${assetId}`).set("Cookie", cookie);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toMatch(/image\/png/);
    expect((await request(ctx.app).get(`/api/assets/00000000-0000-0000-0000-000000000000`).set("Cookie", cookie)).status).toBe(404);
    const bad = await request(ctx.app).post(`/api/brands/${brand.slug}/creative/hypotheses`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ statement: "hi" });
    expect(bad.status).toBe(400);
    const ok = await request(ctx.app).post(`/api/brands/${brand.slug}/creative/hypotheses`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ statement: "Time-saving messaging works for hockey", dimensions: { sport: "hockey" } });
    expect(ok.status).toBe(201);
  });
});
