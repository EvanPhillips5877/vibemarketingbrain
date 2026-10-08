import { and, desc, eq, like } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockAiClient } from "../src/ai/client.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { createHypothesis, generateForHypothesis } from "../src/creative/factory.js";
import { mockHooks } from "../src/creative/generate.js";
import { aiRuns, brands, creativeVariants, creatives, customerEvents, extObjects, hooks, hypotheses, learnings, type Brand, type ChannelAccount, type Hypothesis, type Learning } from "../src/db/schema.js";
import { syncBrand } from "../src/ingest/sync.js";
import { compareByDimension, distillBrand, JOB_ACTOR, relevantLearnings, statementFor } from "../src/learnings/distill.js";
import { devLogin, makeContext } from "./helpers.js";

const ad = (dims: Record<string, string>, spendMicros: number, registered: number) => ({ dims, spendMicros, registered });

describe("distillation (pure)", () => {
  it("needs two groups over the minimum sample and a real gap before it says anything", () => {
    const thin = [ad({ hook_type: "fairness" }, 100_000_000, 9), ad({ hook_type: "pain" }, 100_000_000, 20)];
    expect(compareByDimension(thin, "hook_type")).toBeNull(); // fairness below 10
    const close = [ad({ hook_type: "fairness" }, 100_000_000, 20), ad({ hook_type: "pain" }, 110_000_000, 20)];
    expect(compareByDimension(close, "hook_type")).toBeNull(); // 9% gap
    const clear = [ad({ hook_type: "fairness" }, 100_000_000, 20), ad({ hook_type: "fairness" }, 50_000_000, 10), ad({ hook_type: "pain" }, 200_000_000, 20)];
    const c = compareByDimension(clear, "hook_type")!;
    expect(c.best).toMatchObject({ value: "fairness", ads: 2, registered: 30, cpaMicros: 5_000_000 });
    expect(c.worst).toMatchObject({ value: "pain", cpaMicros: 10_000_000 });
    expect(c.gapPct).toBe(50);
    expect(compareByDimension(clear, "visual_style")).toBeNull(); // no such dimension on these ads
    const free = [ad({ hook_type: "fairness" }, 0, 20), ad({ hook_type: "pain" }, 200_000_000, 20)];
    expect(compareByDimension(free, "hook_type")).toBeNull(); // zero spend is not a cost to compare, never NaN
    expect(statementFor(c, "CAD", 28)).toMatch(/hook_type "fairness".*CAD 5.00 CPA over 30 registrations.*"pain".*50% lower/);
  });
  it("the mock hook writer leads with a learned hook type and names the learning", () => {
    const h = { id: "h", brandId: "b", missionId: null, statement: "s", dimensions: { sport: "volleyball" }, status: "untested", parentId: null, createdAt: new Date() } as Hypothesis;
    const l = { id: "L1", kind: "validated", dimensions: { hook_type: "time_saving" }, statement: "x" } as unknown as Learning;
    const out = mockHooks(h, [l]);
    expect(out.hooks[0]?.hookType).toBe("time_saving");
    expect(out.hooks[0]?.rationale).toContain("L1");
    expect(mockHooks(h, [{ ...l, kind: "refuted" } as Learning]).hooks[0]?.hookType).toBe("pain"); // a refuted one does not lead
  });
});

describe("learnings (db, mock adapter)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  const ai = new MockAiClient(db);
  let brand: Brand;
  let account: ChannelAccount;
  let cookie = "";
  let csrf = "";
  const actor = "manual:learn-test@example.com";
  const base = () => `/api/brands/${brand.slug}/learnings`;
  const adBySuffix = async (s: string) => (await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.externalId, `${account.externalAccountId}${s}`))))[0]!;

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    account = await seedMockChannelAccount(db, r.brandId);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId));
    await db.delete(learnings).where(eq(learnings.brandId, r.brandId));
    await db.update(brands).set({ eventsPulledAt: null, eventsCursor: null, eventsExportUrl: null }).where(eq(brands.id, r.brandId));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    await syncBrand(db, registry, brand, { metricDays: 14, env: {} });
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId)); // only the events this file writes
    // 30 registrations on the fairness ad, 10 on the pain ad: a clear gap on hook_type, nothing on other dimensions.
    const a1 = await adBySuffix("-a1");
    const a2 = await adBySuffix("-a2");
    const rows = [...Array(30).keys()].map((i) => ({ ad: a1, i })).concat([...Array(10).keys()].map((i) => ({ ad: a2, i: 100 + i })));
    await db.insert(customerEvents).values(rows.map(({ ad: a, i }) => ({ brandId: brand.id, externalCustomerId: `learn-${i}`, stage: "registered" as const, occurredAt: new Date(Date.now() - 86400_000 * (i % 10)), firstTouch: {}, attributionMethod: "utm_content" as const, attributedExtObjectId: a.id })));
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(async () => {
    await db.delete(customerEvents).where(and(eq(customerEvents.brandId, brand.id), like(customerEvents.externalCustomerId, "learn-%")));
    await db.delete(learnings).where(eq(learnings.brandId, brand.id));
    const hyps = await db.select({ id: hypotheses.id }).from(hypotheses).where(and(eq(hypotheses.brandId, brand.id), like(hypotheses.statement, "learn-test:%")));
    for (const h of hyps) {
      const cs = await db.select({ id: creatives.id, hookId: creatives.hookId }).from(creatives).where(eq(creatives.hypothesisId, h.id));
      for (const c of cs) await db.delete(creativeVariants).where(eq(creativeVariants.creativeId, c.id));
      await db.delete(creatives).where(eq(creatives.hypothesisId, h.id));
      for (const c of cs) if (c.hookId) await db.delete(hooks).where(eq(hooks.id, c.hookId));
      await db.delete(hypotheses).where(eq(hypotheses.id, h.id));
    }
    await ctx.handle.close();
  });

  it("the weekly pass writes one observation per dimension with a clear gap, with the groups as evidence, and never a validated one", async () => {
    const r = await distillBrand(db, brand.id);
    expect(r.written.map((w) => w.dimension)).toEqual(["hook_type"]);
    expect(r.skipped).toContain("visual_style");
    const [l] = await db.select().from(learnings).where(eq(learnings.id, r.written[0]!.id));
    expect(l).toMatchObject({ kind: "observation", scope: "creative", status: "active", createdBy: JOB_ACTOR, dimensions: { hook_type: "fairness" }, supersedesId: null });
    const ev = l!.evidence as { dimension: string; groups: { value: string; registered: number }[]; gapPct: number };
    expect(ev.dimension).toBe("hook_type");
    expect(ev.groups.map((g) => [g.value, g.registered])).toEqual([
      ["fairness", 30],
      ["pain", 10],
    ]);
    expect(ev.gapPct).toBeGreaterThanOrEqual(20);
    expect(l!.statement).toMatch(/^Over the last 28 days, ads with hook_type "fairness"/);
  });

  it("running it again supersedes last week's observation instead of duplicating it", async () => {
    const before = (await db.select().from(learnings).where(and(eq(learnings.brandId, brand.id), eq(learnings.createdBy, JOB_ACTOR), eq(learnings.status, "active"))))[0]!;
    const r = await distillBrand(db, brand.id);
    expect(r.retired).toBe(1);
    const active = await db.select().from(learnings).where(and(eq(learnings.brandId, brand.id), eq(learnings.createdBy, JOB_ACTOR), eq(learnings.status, "active")));
    expect(active).toHaveLength(1);
    expect(active[0]!.supersedesId).toBe(before.id);
    expect((await db.select().from(learnings).where(eq(learnings.id, before.id)))[0]!.status).toBe("retired");
  });

  it("two distillations at once leave exactly one active observation per dimension", async () => {
    await Promise.all([distillBrand(db, brand.id), distillBrand(db, brand.id)]);
    const active = await db.select().from(learnings).where(and(eq(learnings.brandId, brand.id), eq(learnings.createdBy, JOB_ACTOR), eq(learnings.status, "active")));
    expect(active).toHaveLength(1);
    const retiredRows = await db.select().from(learnings).where(and(eq(learnings.brandId, brand.id), eq(learnings.createdBy, JOB_ACTOR), eq(learnings.status, "retired")));
    expect(retiredRows).toHaveLength(3); // the first two runs' rows plus the loser of this pair
  });

  it("the generators read the relevant learnings and the run records which ones", async () => {
    const [validated] = await db.insert(learnings).values({ brandId: brand.id, statement: "Time-saving hooks beat fairness for volleyball clubs.", kind: "validated", scope: "creative", dimensions: { hyp_sport: "volleyball", hook_type: "time_saving" }, evidence: { experimentId: "x" }, confidence: 0.7, createdBy: "job:mission-progress" }).returning();
    await db.insert(learnings).values({ brandId: brand.id, statement: "Hockey directors ignore anything in September.", kind: "observation", scope: "audience", dimensions: { sport: "hockey" }, evidence: {}, createdBy: actor });
    const rel = await relevantLearnings(db, brand.id, { sport: "volleyball", angle: "fairness" });
    expect(rel[0]!.id).toBe(validated!.id); // shared sport dimension and validated: first
    expect(rel.some((l) => l.dimensions["sport"] === "hockey")).toBe(false); // a different sport is not relevant

    const h = await createHypothesis(db, brand.id, actor, { statement: "learn-test: fairness works for volleyball clubs", dimensions: { sport: "volleyball", angle: "fairness" } });
    const g = await generateForHypothesis(db, ai, brand, h.id, { actor, formats: ["meta_image"], variantsPerHook: 1 });
    expect(g.variants).toBe(g.hooks);
    const runs = await db.select().from(aiRuns).where(eq(aiRuns.brandId, brand.id)).orderBy(desc(aiRuns.createdAt)).limit(g.hooks + 1);
    for (const run of runs) expect((run.inputRefs as { learningIds: string[] }).learningIds).toContain(validated!.id);
    // The mock leads with the learned hook type; the creative's concept records it.
    const cs = await db.select().from(creatives).where(eq(creatives.hypothesisId, h.id)).orderBy(creatives.createdAt);
    expect(cs[0]!.concept.startsWith("time_saving:")).toBe(true);
  });

  it("a person can add observations and hypotheses, edit and retire; validated is not theirs to write", async () => {
    const created = await request(ctx.app).post(base()).set("Cookie", cookie).set("x-csrf-token", csrf).send({ statement: "Club directors reply on Sunday evenings.", kind: "observation", scope: "audience", dimensions: { audience: "directors" } });
    expect(created.status).toBe(201);
    const id = created.body.learning.id as string;
    expect(created.body.learning.createdBy).toBe("manual:evan@example.com");
    expect((await request(ctx.app).post(base()).set("Cookie", cookie).set("x-csrf-token", csrf).send({ statement: "I say so.", kind: "validated", scope: "creative" })).status).toBe(400);

    const edited = await request(ctx.app).patch(`${base()}/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "edit", fields: { statement: "Club directors reply on Sunday evenings, not Mondays." } });
    expect(edited.status).toBe(200);
    expect(edited.body.learning.statement).toMatch(/not Mondays/);
    expect(edited.body.learning.evidence.edits).toHaveLength(1);
    expect(edited.body.learning.evidence.edits[0].was.statement).toBe("Club directors reply on Sunday evenings.");
    expect((await request(ctx.app).patch(`${base()}/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "edit", fields: { kind: "validated" } })).status).toBe(400); // strict: kind is not editable

    const retired = await request(ctx.app).patch(`${base()}/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "retire", reason: "wrong" });
    expect(retired.body.learning.status).toBe("retired");
    const list = await request(ctx.app).get(base()).set("Cookie", cookie);
    expect(list.body.learnings.some((l: { id: string }) => l.id === id)).toBe(false);
    const all = await request(ctx.app).get(`${base()}?all=1`).set("Cookie", cookie);
    expect(all.body.learnings.some((l: { id: string }) => l.id === id)).toBe(true);
    expect((await request(ctx.app).patch(`${base()}/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "restore" })).body.learning.status).toBe("active");
    expect((await request(ctx.app).patch(`${base()}/00000000-0000-4000-8000-000000000000`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "retire" })).status).toBe(404);
    expect((await request(ctx.app).get(base())).status).toBe(401);
  });

  it("distill on demand answers through the API", async () => {
    const res = await request(ctx.app).post(`${base()}/distill`).set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(res.status).toBe(200);
    expect(res.body.written).toHaveLength(1);
    expect(res.body.retired).toBe(1);
    const active = await db.select().from(learnings).where(and(eq(learnings.brandId, brand.id), eq(learnings.createdBy, JOB_ACTOR), eq(learnings.status, "active")));
    expect(active).toHaveLength(1);
  });
});
