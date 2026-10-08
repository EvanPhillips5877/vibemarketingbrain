import { and, eq, like, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApproved } from "../src/actions/executor.js";
import { approve, listProposals } from "../src/actions/proposals.js";
import { seedMockChannelAccount, seedTryoutBrain, TRYOUTBRAIN_POLICY_V1 } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { actionProposals, autonomyPolicies, brands, customerEvents, experiments, extObjects, hypotheses, learnings, metricsDaily, missions, type Brand, type ChannelAccount, type Mission } from "../src/db/schema.js";
import { syncStructure } from "../src/ingest/structure.js";
import { experimentLedger, linkCreatedObjects, missionProgress } from "../src/missions/ledger.js";
import { mockParse } from "../src/missions/parse.js";
import { mockPlan, planSchema } from "../src/missions/plan.js";
import { judge, MIN_CONVERSIONS, progressBrand } from "../src/missions/progress.js";
import { devLogin, makeContext } from "./helpers.js";

const defaults = { markets: ["CA", "US"], budgetMicros: 1_500_000_000 };

describe("mission parse (pure mock)", () => {
  it("reads target, cost cap, budget, markets, channels and duration from the text", () => {
    const d = mockParse("Get TryoutBrain 50 new coaches for less than $20 each in Canada on Meta. You have $1,000 over 6 weeks.", defaults);
    expect(d.goal).toEqual({ metric: "registrations", target: 50 });
    expect(d.targetCacMicros).toBe(20_000_000);
    expect(d.budgetMicros).toBe(1_000_000_000);
    expect(d.markets).toEqual(["CA"]);
    expect(d.channels).toEqual(["meta"]);
    expect(d.durationDays).toBe(42);
    expect(d.assumptions).toEqual([]);
  });
  it("falls back to brand defaults and says so; paying customers switch the metric", () => {
    const d = mockParse("Find 10 paying customers.", defaults);
    expect(d.goal).toEqual({ metric: "paid_customers", target: 10 });
    expect(d.targetCacMicros).toBeNull();
    expect(d.budgetMicros).toBe(defaults.budgetMicros);
    expect(d.markets).toEqual(["CA", "US"]);
    expect(d.channels).toEqual(["meta", "google"]);
    expect(d.assumptions).toHaveLength(4);
  });
});

describe("mock plan (pure)", () => {
  it("never plans fewer than two hypotheses, even for a one-sport brand", () => {
    const mission = { id: "m", channels: ["meta"], targetCacMicros: 20_000_000, goal: { metric: "registrations", target: 50 }, budgetMicros: 300_000_000 } as unknown as Mission;
    const oneSport = [{ category: "sport", status: "active", value: { sports: ["soccer"] } }] as unknown as Parameters<typeof mockPlan>[1];
    const plan = mockPlan(mission, oneSport);
    expect(plan.hypotheses).toHaveLength(2);
    expect(() => planSchema.parse(plan)).not.toThrow();
    expect(new Set(plan.hypotheses.map((h) => h.dimensions["angle"])).size).toBe(2);
  });
});

describe("judge (pure)", () => {
  const ledger = { spendMicros: 200_000_000, impressions: 10_000, clicks: 300, registered: 10, activated: 2, paid: 1, cpaMicros: 20_000_000, cacMicros: 200_000_000, objects: 1 };
  it("needs a minimum sample before it calls anything", () => {
    expect(judge({ primaryMetric: "cpa", targetValue: 25_000_000 }, { ...ledger, registered: MIN_CONVERSIONS - 1 }).conclusion).toBe("inconclusive");
  });
  it("lower is better for costs, higher for rates; no target is inconclusive", () => {
    expect(judge({ primaryMetric: "cpa", targetValue: 25_000_000 }, ledger).conclusion).toBe("supported");
    expect(judge({ primaryMetric: "cpa", targetValue: 15_000_000 }, ledger).conclusion).toBe("refuted");
    expect(judge({ primaryMetric: "ctr", targetValue: 0.02 }, ledger).conclusion).toBe("supported");
    expect(judge({ primaryMetric: "ctr", targetValue: 0.05 }, ledger).conclusion).toBe("refuted");
    expect(judge({ primaryMetric: "cpa", targetValue: null }, ledger).conclusion).toBe("inconclusive");
    expect(judge({ primaryMetric: "paid_cac", targetValue: 100_000_000 }, ledger).conclusion).toBe("inconclusive"); // 1 paid < minimum
  });
});

describe("missions (db, mock AI and adapter)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  let brand: Brand;
  let account: ChannelAccount;
  let cookie = "";
  let csrf = "";
  const base = () => `/api/brands/${brand.slug}/missions`;
  const patch = (id: string, body: object) => request(ctx.app).patch(`${base()}/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send(body);

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    account = await seedMockChannelAccount(db, r.brandId);
    await db.delete(missions).where(eq(missions.brandId, r.brandId));
    await db.delete(actionProposals).where(eq(actionProposals.brandId, r.brandId));
    await db.delete(learnings).where(eq(learnings.brandId, r.brandId));
    await db.delete(extObjects).where(and(eq(extObjects.channelAccountId, account.id), like(extObjects.name, "%[mb:%")));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    // The mock account spends more per day than the seeded CAD 1,500/month policy allows, so the
    // engine would block every new campaign; this file tests missions, not that rule.
    await db.delete(autonomyPolicies).where(and(eq(autonomyPolicies.brandId, brand.id), eq(autonomyPolicies.version, 99)));
    await db.insert(autonomyPolicies).values({ brandId: brand.id, version: 99, level: TRYOUTBRAIN_POLICY_V1.level, rules: { ...TRYOUTBRAIN_POLICY_V1.rules, monthlyBudgetMicros: 10_000_000_000 }, createdBy: "manual:test" });
    await syncStructure(db, registry.mockAdapter, account);
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(async () => {
    // Objects this file created carry their metrics and events; remove them so later files see the fixture account as seeded.
    const mine = await db.select({ id: extObjects.id }).from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), like(extObjects.name, "%[mb:%")));
    for (const o of mine) {
      await db.delete(customerEvents).where(eq(customerEvents.attributedExtObjectId, o.id));
      await db.delete(extObjects).where(eq(extObjects.id, o.id));
    }
    await db.delete(actionProposals).where(eq(actionProposals.brandId, brand.id));
    await db.delete(learnings).where(eq(learnings.createdBy, "job:mission-progress"));
    const hyps = await db.select({ id: hypotheses.id }).from(hypotheses).where(sql`${hypotheses.missionId} in (select id from missions where brand_id = ${brand.id})`);
    await db.delete(missions).where(eq(missions.brandId, brand.id)); // experiments cascade; they hold the hypotheses
    await db.delete(autonomyPolicies).where(and(eq(autonomyPolicies.brandId, brand.id), eq(autonomyPolicies.version, 99)));
    for (const h of hyps) await db.delete(hypotheses).where(eq(hypotheses.id, h.id));
    await ctx.handle.close();
  });

  let mission: Mission;

  it("drafts a mission from text; the fields and assumptions come back for a person to confirm", async () => {
    const res = await request(ctx.app).post(base()).set("Cookie", cookie).set("x-csrf-token", csrf).send({ text: "Get 50 new coaches for less than $20 each. You have $300. 30 days." });
    expect(res.status).toBe(201);
    expect(res.body.isMock).toBe(true);
    mission = res.body.mission;
    expect(mission.status).toBe("draft");
    expect(mission.goal).toEqual({ metric: "registrations", target: 50 });
    expect(mission.budgetMicros).toBe(300_000_000);
    expect(mission.targetCacMicros).toBe(20_000_000);
    expect(res.body.assumptions).toContain("No markets stated; used the brand's markets.");
    expect(await request(ctx.app).post(base()).set("Cookie", cookie).set("x-csrf-token", csrf).send({ text: "short" }).then((r) => r.status)).toBe(400);
  });

  it("a person can correct the parsed fields; activating before planning is refused", async () => {
    const res = await patch(mission.id, { action: "edit", fields: { targetCacMicros: 25_000_000, channels: ["meta"] } });
    expect(res.status).toBe(200);
    expect(res.body.mission.targetCacMicros).toBe(25_000_000);
    expect(res.body.mission.channels).toEqual(["meta"]);
    expect((await patch(mission.id, { action: "edit", fields: { budgetMicros: -5 } })).status).toBe(400);
    expect((await patch(mission.id, { action: "activate" })).status).toBe(409);
    expect((await patch("00000000-0000-4000-8000-000000000000", { action: "plan" })).status).toBe(404);
  });

  it("plans: the strategist's hypotheses land on the mission with kill and scale rules", async () => {
    const res = await patch(mission.id, { action: "plan" });
    expect(res.status).toBe(200);
    expect(res.body.isMock).toBe(true);
    expect(res.body.mission.status).toBe("planned");
    const plan = res.body.plan as ReturnType<typeof mockPlan>;
    expect(plan.hypotheses.length).toBeGreaterThanOrEqual(2);
    for (const h of plan.hypotheses) {
      expect(h.channel).toBe("meta"); // the edited channel list is respected
      expect(h.targetValue).toBe(25_000_000);
      expect(h.killRule).toMatch(/kill/);
    }
    // Nothing was proposed by planning: the AI only plans.
    expect((await listProposals(db, brand.id, ["awaiting_approval", "approved", "executed", "blocked", "failed", "unknown"])).filter((p) => p.missionId === mission.id)).toHaveLength(0);
  });

  it("editing a planned mission drops the plan: the fields changed under it", async () => {
    const res = await patch(mission.id, { action: "edit", fields: { durationDays: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.mission.status).toBe("draft");
    expect(res.body.mission.plan.strategist).toBeUndefined();
    expect(res.body.mission.plan.durationDays).toBe(30);
    expect((await patch(mission.id, { action: "activate" })).status).toBe(409);
    expect((await patch(mission.id, { action: "plan" })).body.mission.status).toBe("planned");
  });

  it("activates: experiments up to the policy cap are running, each with a CREATE_CAMPAIGN proposal that waits for approval", async () => {
    // Two clicks at once: one activation wins, the other is refused, one set of experiments exists.
    const both = await Promise.all([patch(mission.id, { action: "activate" }), patch(mission.id, { action: "activate" })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const res = both.find((r) => r.status === 200)!;
    const planned = ((await db.select().from(missions).where(eq(missions.id, mission.id)))[0]!.plan as { strategist: { hypotheses: unknown[] } }).strategist.hypotheses.length;
    expect(await db.select().from(experiments).where(eq(experiments.missionId, mission.id))).toHaveLength(planned);
    expect(res.body.mission.status).toBe("active");
    const exps = res.body.experiments as { status: string; budgetMicros: number }[];
    const running = exps.filter((e) => e.status === "running");
    expect(running.length).toBeLessThanOrEqual(3);
    expect(running.length).toBe(Math.min(3, exps.length));
    expect(exps.reduce((s, e) => s + e.budgetMicros, 0)).toBeLessThanOrEqual(300_000_000 + exps.length); // rounding only
    const proposals = (await listProposals(db, brand.id, ["awaiting_approval", "approved", "executed", "blocked", "failed", "unknown"])).filter((p) => p.missionId === mission.id);
    expect(proposals).toHaveLength(running.length);
    for (const p of proposals) {
      expect(p.status, JSON.stringify(p.policyResult)).toBe("awaiting_approval");
      expect(p.payload.type).toBe("CREATE_CAMPAIGN");
      expect(p.experimentId).not.toBeNull();
      const daily = (p.payload as { dailyBudgetMicros: number }).dailyBudgetMicros;
      expect(daily).toBeGreaterThanOrEqual(brand.defaults.dailyBudgetFloorMicros);
      expect(daily).toBeLessThanOrEqual(brand.defaults.dailyBudgetCeilingMicros);
    }
    expect((await patch(mission.id, { action: "activate" })).status).toBe(409); // once
    expect((await patch(mission.id, { action: "edit", fields: { budgetMicros: 5 } })).status).toBe(409); // no edits once live
  });

  it("after approval and execution the paused campaign is linked back to its experiment, and the ledgers see its numbers", async () => {
    const [p] = (await listProposals(db, brand.id, ["awaiting_approval", "approved", "executed", "blocked", "failed", "unknown"])).filter((x) => x.missionId === mission.id);
    await approve(db, brand.id, p!.id, "manual:evan@example.com");
    const reports = await executeApproved(db, registry, brand.id);
    expect(reports.map((r) => r.outcome)).toContain("executed");
    await syncStructure(db, registry.mockAdapter, account);
    expect(await linkCreatedObjects(db, brand.id)).toBe(1);
    const [obj] = await db.select().from(extObjects).where(eq(extObjects.experimentId, p!.experimentId!));
    expect(obj?.status).toBe("PAUSED");
    expect(obj?.missionId).toBe(mission.id);
    expect(obj?.createdByActionId).toBe(p!.id);
    expect(await linkCreatedObjects(db, brand.id)).toBe(0); // idempotent

    const today = new Date().toISOString().slice(0, 10);
    await db.insert(metricsDaily).values({ extObjectId: obj!.id, date: today, impressions: 5000, clicks: 100, spendMicros: 90_000_000 });
    for (let i = 0; i < 12; i++) await db.insert(customerEvents).values({ brandId: brand.id, externalCustomerId: `m-${i}`, stage: "registered", occurredAt: new Date(), firstTouch: {}, attributionMethod: "utm_campaign", attributedExtObjectId: obj!.id });
    const [exp] = await db.select().from(experiments).where(eq(experiments.id, p!.experimentId!));
    const l = await experimentLedger(db, exp!);
    expect(l).toMatchObject({ spendMicros: 90_000_000, registered: 12, cpaMicros: 7_500_000, objects: 1 });
    const m = (await db.select().from(missions).where(eq(missions.id, mission.id)))[0]!;
    const progress = await missionProgress(db, m);
    expect(progress.goalReached).toBe(12);
    expect(progress.goalPct).toBe(24);
    expect(progress.cacVsTargetPct).toBe(30);
  });

  it("the daily pass closes a finished experiment with a verdict, writes the learning, and starts the next one in the queue", async () => {
    const [p] = (await listProposals(db, brand.id, ["awaiting_approval", "approved", "executed", "blocked", "failed", "unknown"])).filter((x) => x.missionId === mission.id);
    const before = await db.select().from(experiments).where(eq(experiments.missionId, mission.id));
    expect(await progressBrand(db, brand.id).then((r) => r.closed)).toEqual([]); // still within budget and dates
    // Spent its budget: the experiment ends; under target with enough registrations → supported.
    await db.update(experiments).set({ budgetMicros: 50_000_000 }).where(eq(experiments.id, p!.experimentId!));
    const report = await progressBrand(db, brand.id);
    expect(report.closed).toEqual([{ experimentId: p!.experimentId, conclusion: "supported", reason: expect.stringMatching(/cpa 7500000 vs target 25000000 on 12/) }]);
    const [ended] = await db.select().from(experiments).where(eq(experiments.id, p!.experimentId!));
    expect(ended?.status).toBe("ended");
    expect(ended?.learningId).not.toBeNull();
    const [learning] = await db.select().from(learnings).where(eq(learnings.id, ended!.learningId!));
    expect(learning?.kind).toBe("validated");
    expect(learning?.statement).toMatch(/^Supported:/);
    expect(learning?.createdBy).toBe("job:mission-progress");
    const planned = before.filter((e) => e.status === "planned").length;
    expect(report.started).toHaveLength(Math.min(planned, 1));
    // A newly started experiment gets its campaign ask the same pass; running ones with a live ask are left alone.
    expect(report.asked).toEqual(report.started);
    for (const id of report.started) {
      const asks = (await listProposals(db, brand.id, ["awaiting_approval", "blocked"])).filter((x) => x.experimentId === id);
      expect(asks).toHaveLength(1);
      expect(asks[0]!.source).toBe("system:mission-progress");
    }
    expect((await progressBrand(db, brand.id)).asked).toEqual([]); // same day: no second ask
    expect(report.missionsDone).toEqual([]); // 12 of 50, budget not spent, time left
    expect((await db.select().from(missions).where(eq(missions.id, mission.id)))[0]?.status).toBe("active");
  });

  it("the mission closes when its goal is reached; the list shows progress", async () => {
    const m = (await db.select().from(missions).where(eq(missions.id, mission.id)))[0]!;
    await db.update(missions).set({ goal: { metric: "registrations", target: 12 } }).where(eq(missions.id, m.id));
    const report = await progressBrand(db, brand.id);
    expect(report.missionsDone).toEqual([mission.id]);
    // Nothing is left running or queued under a closed mission; the running one got a verdict with the reason.
    const all = await db.select().from(experiments).where(eq(experiments.missionId, mission.id));
    expect(all.every((e) => e.status === "ended")).toBe(true);
    expect(report.closed.length).toBeGreaterThanOrEqual(1);
    expect(report.closed.every((c) => c.reason.endsWith("mission goal reached"))).toBe(true);
    expect(all.filter((e) => e.learningId === null).every((e) => (e.result as { verdict: { reason: string } }).verdict.reason.startsWith("never ran"))).toBe(true);
    const res = await request(ctx.app).get(base()).set("Cookie", cookie);
    expect(res.status).toBe(200);
    const row = (res.body.missions as { mission: Mission; progress: { goalPct: number } | null }[]).find((x) => x.mission.id === mission.id)!;
    expect(row.mission.status).toBe("done");
    expect(row.progress?.goalPct).toBe(100);
    const detail = await request(ctx.app).get(`${base()}/${mission.id}`).set("Cookie", cookie);
    expect(detail.body.experiments.some((e: { experiment: { conclusion: string | null } }) => e.experiment.conclusion === "supported")).toBe(true);
  });

  it("unauthenticated and cross-brand requests are refused", async () => {
    expect((await request(ctx.app).get(base())).status).toBe(401);
    expect((await request(ctx.app).get(`/api/brands/nope/missions`).set("Cookie", cookie)).status).toBe(404);
  });
});
