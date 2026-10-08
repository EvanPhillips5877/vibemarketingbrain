import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProposals } from "../src/actions/proposals.js";
import { buildCommandContext, mockCommand, pickModel, renderContext, runCommand } from "../src/ai/command.js";
import { activateMission, draftMission, planForMission } from "../src/missions/missions.js";
import { MockAiClient, MODELS } from "../src/ai/client.js";
import { validateClaims } from "../src/ai/claims.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { actionProposals, brands, creativeVariants, creatives, customerEvents, extObjects, hooks, hypotheses, learnings, missions, type Brand, type ChannelAccount } from "../src/db/schema.js";
import { syncBrand } from "../src/ingest/sync.js";
import { devLogin, makeContext } from "./helpers.js";

describe("command bar (db, mock AI and adapter)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  const ai = new MockAiClient(db);
  let brand: Brand;
  let account: ChannelAccount;
  let cookie = "";
  let csrf = "";
  const actor = "manual:evan@example.com";
  const STATEMENT = `"fairness" messaging works for volleyball clubs`;
  const ask = (text: string) => request(ctx.app).post(`/api/brands/${brand.slug}/command`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ text });
  const open = () => listProposals(db, brand.id, ["awaiting_approval", "approved", "blocked"]);

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    account = await seedMockChannelAccount(db, r.brandId);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId));
    await db.delete(actionProposals).where(eq(actionProposals.brandId, r.brandId));
    await db.delete(missions).where(eq(missions.brandId, r.brandId));
    await db.update(brands).set({ eventsPulledAt: null, eventsCursor: null, eventsExportUrl: null }).where(eq(brands.id, r.brandId));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    await syncBrand(db, registry, brand, { metricDays: 14, env: {} });
    await db.insert(learnings).values({ brandId: brand.id, statement: "Fairness messaging beat the pain-point angle for volleyball clubs.", kind: "validated", scope: "creative", createdBy: "manual:test" });
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(async () => {
    await db.delete(actionProposals).where(eq(actionProposals.brandId, brand.id));
    await db.delete(learnings).where(eq(learnings.createdBy, "manual:test"));
    const missionHyps = await db.select({ id: hypotheses.id }).from(hypotheses).where(sql`${hypotheses.missionId} in (select id from missions where brand_id = ${brand.id})`);
    await db.delete(missions).where(eq(missions.brandId, brand.id)); // experiments cascade
    for (const h of missionHyps) await db.delete(hypotheses).where(eq(hypotheses.id, h.id));
    const hyps = await db.select({ id: hypotheses.id }).from(hypotheses).where(and(eq(hypotheses.brandId, brand.id), eq(hypotheses.statement, STATEMENT)));
    for (const h of hyps) {
      const cs = await db.select({ id: creatives.id, hookId: creatives.hookId }).from(creatives).where(eq(creatives.hypothesisId, h.id));
      for (const c of cs) await db.delete(creativeVariants).where(eq(creativeVariants.creativeId, c.id));
      await db.delete(creatives).where(eq(creatives.hypothesisId, h.id));
      for (const c of cs) if (c.hookId) await db.delete(hooks).where(eq(hooks.id, c.hookId));
      await db.delete(hypotheses).where(eq(hypotheses.id, h.id));
    }
    await ctx.handle.close();
  });

  it("the context holds the pack, the objects, learnings and proposals, and every synthetic id is citable", async () => {
    const c = await buildCommandContext(db, brand);
    expect(c.campaigns.length).toBeGreaterThanOrEqual(2);
    expect(c.ads.length).toBeGreaterThanOrEqual(2);
    expect(c.learnings.map((l) => l.statement)).toContain("Fairness messaging beat the pain-point angle for volleyball clubs.");
    const ids = new Set(c.evidence.entries.map((e) => e.id));
    for (const l of c.learnings) expect(ids.has(`learning:${l.id}`)).toBe(true);
    const text = renderContext(c);
    for (const tag of ["<brief>", "<metric_pack>", "<objects>", "<mission>", "<learnings>", "<open_proposals>"]) expect(text).toContain(tag);
    expect(text).not.toMatch(/access_token|Authorization/i);
  });

  it("\"why\" goes to the stronger model; everything else to the cheaper one", () => {
    expect(pickModel("Why is CPA up?")).toBe(MODELS.commandWhy);
    expect(pickModel("How did we do this week?")).toBe(MODELS.command);
  });

  it("questions answer with claims the validator admits, and propose nothing", async () => {
    const c = await buildCommandContext(db, brand);
    for (const q of ["How did we do this week?", "Why is CPA up?", "What have we learned?", "What proposals are waiting?"]) {
      const out = mockCommand(q, c);
      expect(out.actions).toEqual([]);
      expect(validateClaims({ headline: "", claims: out.claims, nextTests: [] }, c.evidence)).toEqual([]);
      if (!/proposals/.test(q)) expect(out.claims.length).toBeGreaterThan(0); // no proposals are open yet: nothing to claim
    }
    const why = mockCommand("Why is CPA up?", c);
    expect(why.claims.some((k) => k.kind === "HYPOTHESIS")).toBe(true);
    expect(why.claims.filter((k) => k.kind !== "HYPOTHESIS").every((k) => !/because/i.test(k.text))).toBe(true);
    const learned = mockCommand("What have we learned?", c);
    expect(learned.claims[0]?.evidence[0]).toMatch(/^learning:/);
  });

  it("\"pause <ad>\" becomes a PAUSE_AD proposal through the engine, with the object's state assumed; a paused ad is refused", async () => {
    const res = await ask("Pause Fairness / Room screenshot");
    expect(res.status).toBe(200);
    expect(res.body.isMock).toBe(true);
    expect(res.body.actions).toHaveLength(1);
    const o = res.body.actions[0];
    expect(o.ok, o.detail).toBe(true);
    expect(o.proposal.type).toBe("PAUSE_AD");
    expect(o.proposal.status).toBe("awaiting_approval");
    expect(o.proposal.source).toMatch(/^command:/);
    expect(o.proposal.payload.assumptions.status).toBe("ACTIVE");
    expect(o.proposal.payload.kind).toBe("ad");
    const [obj] = await db.select().from(extObjects).where(eq(extObjects.id, o.proposal.payload.extObjectId));
    expect(obj?.name).toBe("Fairness / Room screenshot");
    expect(res.body.claims.some((k: { kind: string }) => k.kind === "ACTION")).toBe(true);
    expect(res.body.claims.some((k: { kind: string }) => k.kind === "FACT")).toBe(true);

    const again = await ask("Pause Volleyball - abstract art");
    expect(again.body.actions[0].ok).toBe(false);
    expect(again.body.actions[0].detail).toMatch(/already paused/);
  });

  it("\"set <campaign> budget to $X/day\" becomes a CHANGE_BUDGET proposal evaluated by policy", async () => {
    const res = await ask('Set "Spring tryouts - CA" budget to $25/day');
    expect(res.status).toBe(200);
    const o = res.body.actions[0];
    expect(o.ok).toBe(true);
    expect(o.proposal.type).toBe("CHANGE_BUDGET");
    expect(o.proposal.payload.dailyBudgetMicros).toBe(25_000_000);
    expect(o.proposal.payload.kind).toBe("campaign");
    expect(["awaiting_approval", "blocked"]).toContain(o.proposal.status);
    // Over the policy's daily cap: still a proposal, but blocked, and the bar says why.
    const big = await ask('Set "Spring tryouts - CA" budget to $500/day');
    expect(big.body.actions[0].proposal.status).toBe("blocked");
    expect(big.body.actions[0].proposal.policyResult.violations.map((v: { rule: string }) => v.rule)).toContain("daily_cap");
  });

  it("a geo exclusion is refused plainly with the nearest action named; an unknown object is not guessed", async () => {
    const geo = await ask("Stop advertising in California");
    expect(geo.body.actions).toEqual([]);
    expect(geo.body.cannot).toMatch(/California/);
    const unknown = await ask("Pause the purple campaign");
    expect(unknown.body.actions).toEqual([]);
    expect(unknown.body.cannot).toBe("no matching object");
    expect(await open().then((p) => p.length)).toBe(3); // nothing new from either
  });

  it("a question about the mission reports progress and drafts nothing; without a mission it says so", async () => {
    const before = await buildCommandContext(db, brand);
    expect(before.mission).toBeNull();
    const none = mockCommand("Is the mission on track?", before);
    expect(none.actions).toEqual([]);
    expect(none.answer).toMatch(/no active mission/);

    const d = await draftMission(db, ai, brand, "Get 20 new coaches under $30 each. You have $200. 30 days.", actor);
    await planForMission(db, ai, brand, d.mission.id, actor);
    await activateMission(db, brand, d.mission.id, actor);
    const c = await buildCommandContext(db, brand);
    expect(c.mission?.mission.id).toBe(d.mission.id);
    for (const q of ["Is the mission on track?", "How is the mission doing", "Are we on pace for the goal?"]) {
      const out = mockCommand(q, c);
      expect(out.actions, q).toEqual([]);
      expect(out.claims[0]?.evidence[0]).toMatch(/^mission:/);
      expect(validateClaims({ headline: "", claims: out.claims, nextTests: [] }, c.evidence)).toEqual([]);
    }
    expect((await db.select().from(missions).where(eq(missions.brandId, brand.id))).length).toBe(1); // nothing drafted by the questions
    // The context carries the experiments too, so a claim can cite one.
    expect(c.evidence.entries.some((e) => e.id.startsWith("experiment:"))).toBe(true);
  });

  it("a goal becomes a draft mission, never an active one", async () => {
    const res = await ask("Get 50 new coaches under $20 each with $500");
    const o = res.body.actions[0];
    expect(o.ok).toBe(true);
    expect(o.missionId).toBeTruthy();
    const [m] = await db.select().from(missions).where(eq(missions.id, o.missionId));
    expect(m?.status).toBe("draft");
    expect(mockCommand("Start a new mission: 30 clubs in Ontario with $400", await buildCommandContext(db, brand)).actions[0]?.tool).toBe("propose_mission");
    expect(m?.goal).toEqual({ metric: "registrations", target: 50 });
    expect(m?.targetCacMicros).toBe(20_000_000);
    expect(m?.budgetMicros).toBe(500_000_000);
  });

  it("\"make ads about …\" generates draft variants under a new hypothesis", async () => {
    const res = await ask("Make ads about fairness for volleyball clubs");
    const o = res.body.actions[0];
    expect(o.ok).toBe(true);
    expect(o.generated.variants).toBeGreaterThan(0);
    const [h] = await db.select().from(hypotheses).where(and(eq(hypotheses.brandId, brand.id), eq(hypotheses.statement, STATEMENT)));
    expect(h?.dimensions).toEqual({ sport: "volleyball", angle: "fairness" });
    const cs = await db.select({ id: creatives.id }).from(creatives).where(eq(creatives.hypothesisId, h!.id));
    const vs = await db.select().from(creativeVariants).where(inArray(creativeVariants.creativeId, cs.map((c) => c.id)));
    expect(vs.length).toBe(o.generated.variants);
    expect(vs.every((v) => v.status === "draft")).toBe(true); // nothing is approved or shipped by a command
  });

  it("runCommand records the run and the audit event; the route needs a session and a CSRF token", async () => {
    const r = await runCommand(db, ai, brand, "How did we do this week?", actor);
    expect(r.runId).toBeTruthy();
    expect(r.model).toBe("mock");
    expect(r.evidence.map((e) => e.id)).toContain("brand.spend.7d");
    expect([401, 403]).toContain((await request(ctx.app).post(`/api/brands/${brand.slug}/command`).send({ text: "hi there" })).status);
    expect((await request(ctx.app).post(`/api/brands/${brand.slug}/command`).set("Cookie", cookie).send({ text: "hi there" })).status).toBe(403); // no CSRF token
    expect((await ask("x")).status).toBe(400);
  });
});
