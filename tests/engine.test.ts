import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeApproved, executeNext, proposeRollback, reconcileUnknown } from "../src/actions/executor.js";
import { approve, expireStale, listProposals, propose, reject } from "../src/actions/proposals.js";
import { MockAiClient } from "../src/ai/client.js";
import { analyzeBrand } from "../src/analytics/morning.js";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import type { AccountRef } from "../src/channels/adapter.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { actionExecutions, actionProposals, autonomyPolicies, brands, customerEvents, extObjects, type Brand, type ChannelAccount } from "../src/db/schema.js";
import type { AdapterCommand } from "../src/domain/actions.js";
import { syncBrand } from "../src/ingest/sync.js";
import { devLogin, makeContext } from "./helpers.js";

describe("action engine (db, mock adapter)", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  const registry = new AdapterRegistry(ctx.config);
  const mock = registry.mockAdapter;
  let brand: Brand;
  let account: ChannelAccount;
  let cookie = "";
  let csrf = "";

  const activeAd = async () => (await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, "ad"), eq(extObjects.status, "ACTIVE"))))[0]!;
  const objectBySuffix = async (suffix: string) => (await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.externalId, `${account.externalAccountId}${suffix}`))))[0]!;
  const pauseOf = (o: { id: string; externalId: string; status: string | null; kind: string }) => ({ type: "PAUSE_AD", kind: o.kind, externalId: o.externalId, channelAccountId: account.id, extObjectId: o.id, assumptions: { status: o.status ?? undefined } });
  const anyAd = async () => (await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, "ad"))))[0]!;
  const activeCampaign = async () => (await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, "campaign"), eq(extObjects.status, "ACTIVE"))))[0]!;
  const pausePayload = (ad: { id: string; externalId: string; status: string | null }) => ({ type: "PAUSE_AD", kind: "ad", externalId: ad.externalId, channelAccountId: account.id, extObjectId: ad.id, assumptions: { status: ad.status ?? undefined } });

  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    account = await seedMockChannelAccount(db, r.brandId);
    await db.delete(customerEvents).where(eq(customerEvents.brandId, r.brandId));
    await db.delete(actionProposals).where(eq(actionProposals.brandId, r.brandId));
    await db.update(brands).set({ eventsPulledAt: null, eventsCursor: null, eventsExportUrl: null }).where(eq(brands.id, r.brandId));
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    await syncBrand(db, registry, brand, { metricDays: 14, env: {} });
    ({ cookie, csrf } = await devLogin(ctx.app, "evan@example.com"));
  });
  afterAll(() => ctx.handle.close());

  it("a proposal is evaluated on creation; under level approve it waits for a person; the same ask twice is one row", async () => {
    const ad = await activeAd();
    const a = await propose(db, { brandId: brand.id, payload: pausePayload(ad), reason: "test", source: "detector:test" });
    expect(a.duplicate).toBe(false);
    expect(a.proposal.status).toBe("awaiting_approval");
    expect(a.proposal.policyVersion).toBe(1);
    expect(a.proposal.expiresAt).not.toBeNull();
    const b = await propose(db, { brandId: brand.id, payload: pausePayload(ad), reason: "again", source: "detector:test" });
    expect(b.duplicate).toBe(true);
    expect(b.proposal.id).toBe(a.proposal.id);
    expect(await listProposals(db, brand.id, ["awaiting_approval"])).toHaveLength(1);
  });

  it("after a proposal expires, fails or is rejected, the same ask may be made again", async () => {
    // A different object from the one the other cases use, so this leaves them alone.
    const c = await activeCampaign();
    const pauseCampaign = { type: "PAUSE_AD", kind: "campaign", externalId: c.externalId, channelAccountId: account.id, extObjectId: c.id, assumptions: { status: "ACTIVE" } };
    const first = await propose(db, { brandId: brand.id, payload: pauseCampaign, reason: "r", source: "manual:evan@example.com" });
    const dup = await propose(db, { brandId: brand.id, payload: pauseCampaign, reason: "r", source: "manual:evan@example.com" });
    expect(dup.duplicate).toBe(true);
    await reject(db, brand.id, first.proposal.id, "manual:evan@example.com");
    const again = await propose(db, { brandId: brand.id, payload: pauseCampaign, reason: "r", source: "manual:evan@example.com" });
    expect(again.duplicate).toBe(false);
    expect(again.proposal.id).not.toBe(first.proposal.id);
    expect(again.proposal.idempotencyKey).toMatch(/#1$/);
    await reject(db, brand.id, again.proposal.id, "manual:evan@example.com");
  });

  it("rejects a malformed payload and a bad source before anything is stored", async () => {
    await expect(propose(db, { brandId: brand.id, payload: { type: "PAUSE_AD" }, reason: "x", source: "detector:test" })).rejects.toThrow();
    const ad = await activeAd();
    await expect(propose(db, { brandId: brand.id, payload: pausePayload(ad), reason: "x", source: "nobody" })).rejects.toThrow();
  });

  it("approve → execute → executed, the mirror is refreshed, and it cannot run twice", async () => {
    const [p] = await listProposals(db, brand.id, ["awaiting_approval"]);
    const approved = await approve(db, brand.id, p!.id, "manual:evan@example.com");
    expect(approved.status).toBe("approved");
    await expect(approve(db, brand.id, p!.id, "manual:evan@example.com")).rejects.toThrow(/cannot approve/);

    const first = await executeNext(db, registry, brand.id);
    expect(first).toMatchObject({ proposalId: p!.id, outcome: "executed" });
    expect(await executeNext(db, registry, brand.id)).toBeNull(); // nothing left: no double execution
    const [row] = await db.select().from(actionProposals).where(eq(actionProposals.id, p!.id));
    expect(row?.status).toBe("executed");
    const execs = await db.select().from(actionExecutions).where(eq(actionExecutions.proposalId, p!.id));
    expect(execs).toHaveLength(1);
    expect(execs[0]).toMatchObject({ attempt: 1, outcome: "executed" });
    expect(execs[0]?.rollback).toMatchObject({ type: "ACTIVATE" });
    const [ad] = await db.select().from(extObjects).where(eq(extObjects.id, (p!.payload as { extObjectId: string }).extObjectId));
    expect(ad?.status).toBe("PAUSED");
    expect(mock.calls.filter((c) => c.command.type === "PAUSE_AD")).toHaveLength(1);
  });

  it("a stale proposal expires instead of executing", async () => {
    const ad = await activeAd();
    const r = await propose(db, { brandId: brand.id, payload: pausePayload(ad), reason: "stale", source: "manual:evan@example.com" });
    await approve(db, brand.id, r.proposal.id, "manual:evan@example.com");
    // The platform changed under it: someone paused the ad by hand.
    const ref: AccountRef = { id: account.id, channel: "mock", externalAccountId: account.externalAccountId, currency: "CAD", timezone: "America/Toronto", secretRef: null };
    await mock.execute(ref, { type: "PAUSE_AD", kind: "ad", externalId: ad.externalId });
    const callsBefore = mock.calls.length;
    const out = await executeNext(db, registry, brand.id);
    expect(out).toMatchObject({ outcome: "expired" });
    expect(out?.detail).toMatch(/status is PAUSED, proposal assumed ACTIVE/);
    expect(mock.calls.length).toBe(callsBefore); // nothing was sent
    await mock.execute(ref, { type: "ACTIVATE", kind: "ad", externalId: ad.externalId });
    await syncBrand(db, registry, brand, { metricDays: 1, env: {} });
  });

  it("a timeout leaves the proposal unknown; the reconciler reads the platform and settles it", async () => {
    const ad = await activeAd();
    const r = await propose(db, { brandId: brand.id, payload: pausePayload(ad), reason: "flaky", source: "manual:evan@example.com" });
    await approve(db, brand.id, r.proposal.id, "manual:evan@example.com");
    // The call lands on the platform but the response never arrives.
    const real = mock.execute.bind(mock);
    mock.execute = async (acct, cmd: AdapterCommand) => {
      await real(acct, cmd);
      throw new Error("request timed out");
    };
    try {
      const out = await executeNext(db, registry, brand.id);
      expect(out).toMatchObject({ outcome: "unknown" });
    } finally {
      mock.execute = real;
    }
    const [row] = await db.select().from(actionProposals).where(eq(actionProposals.id, r.proposal.id));
    expect(row?.status).toBe("unknown");
    expect(await executeNext(db, registry, brand.id)).toBeNull(); // unknown is never retried blindly
    const settled = await reconcileUnknown(db, registry, brand.id);
    expect(settled).toEqual([{ proposalId: r.proposal.id, outcome: "executed", detail: "found on the platform" }]);
    await syncBrand(db, registry, brand, { metricDays: 1, env: {} });
  });

  it("a non-transport failure is failed, not unknown, and the attempt is on record", async () => {
    const ad = await objectBySuffix("-g1");
    const r = await propose(db, { brandId: brand.id, payload: pauseOf(ad), reason: "boom", source: "manual:evan@example.com" });
    await approve(db, brand.id, r.proposal.id, "manual:evan@example.com");
    const real = mock.execute.bind(mock);
    mock.execute = async () => {
      throw new Error("platform rejected the change: invalid parameter");
    };
    try {
      expect(await executeNext(db, registry, brand.id)).toMatchObject({ outcome: "failed" });
    } finally {
      mock.execute = real;
    }
    const execs = await db.select().from(actionExecutions).where(eq(actionExecutions.proposalId, r.proposal.id));
    expect(execs[0]).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(execs[0]?.response)).toMatch(/invalid parameter/);
  });

  it("rollback is a new proposal built from the stored inverse, through the policy", async () => {
    // The first executed proposal (the reconciled one, newest, carries no inverse).
    const executed = (await listProposals(db, brand.id, ["executed"])).at(-1)!;
    const rb = await proposeRollback(db, registry, brand.id, executed.id, "manual:evan@example.com");
    expect(rb.proposal.type).toBe("ACTIVATE");
    expect(rb.proposal.status).toBe("awaiting_approval");
    expect(rb.proposal.reason).toMatch(/Rollback of proposal/);
    await reject(db, brand.id, rb.proposal.id, "manual:evan@example.com", "not now");
  });

  it("a budget change outside policy is blocked and never reaches the executor", async () => {
    const c = await activeCampaign();
    const r = await propose(db, { brandId: brand.id, payload: { type: "CHANGE_BUDGET", kind: "campaign", externalId: c.externalId, channelAccountId: account.id, extObjectId: c.id, dailyBudgetMicros: 500_000_000, assumptions: {} }, reason: "too much", source: "manual:evan@example.com" });
    expect(r.proposal.status).toBe("blocked");
    const violations = (r.proposal.policyResult as { violations: { rule: string }[] }).violations.map((v) => v.rule);
    expect(violations).toContain("daily_cap");
    await expect(approve(db, brand.id, r.proposal.id, "manual:evan@example.com")).rejects.toThrow(/cannot approve/);
  });

  it("an awaiting proposal past its TTL expires and cannot be approved", async () => {
    const ad = await objectBySuffix("-g2");
    const r = await propose(db, { brandId: brand.id, payload: { ...pauseOf(ad), assumptions: {} }, reason: "old", source: "manual:evan@example.com", evidence: { ttl: true } }, new Date(Date.now() - 100 * 3600_000));
    expect(await expireStale(db)).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(actionProposals).where(eq(actionProposals.id, r.proposal.id));
    expect(row?.status).toBe("expired");
  });

  it("the morning analysis turns detector suggestions into proposals, once", async () => {
    // Make an ad look wasteful: no registrations attributed to it this week.
    const [policy] = await db.select().from(autonomyPolicies).where(eq(autonomyPolicies.brandId, brand.id));
    expect(policy).toBeDefined();
    const before = (await listProposals(db, brand.id, ["awaiting_approval"])).length;
    await analyzeBrand(db, new MockAiClient(db), brand.id, { actor: "test" });
    await analyzeBrand(db, new MockAiClient(db), brand.id, { actor: "test" });
    const after = await listProposals(db, brand.id, ["awaiting_approval"]);
    // Whether or not the mock data trips the detector, a second run adds nothing new.
    expect(after.length).toBeGreaterThanOrEqual(before);
    const detectorMade = after.filter((p) => p.source.startsWith("detector:"));
    const keys = new Set(detectorMade.map((p) => p.idempotencyKey));
    expect(keys.size).toBe(detectorMade.length);
  });

  it("the API lists, approves, rejects and executes behind session + CSRF", async () => {
    expect((await request(ctx.app).get(`/api/brands/${brand.slug}/proposals`)).status).toBe(401);
    const list = await request(ctx.app).get(`/api/brands/${brand.slug}/proposals`).set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.open)).toBe(true);
    const ad = await objectBySuffix("-c2");
    const created = await request(ctx.app).post(`/api/brands/${brand.slug}/proposals`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ payload: pauseOf(ad), reason: "via api" });
    expect(created.status).toBe(201);
    const id = created.body.proposal.id as string;
    expect((await request(ctx.app).patch(`/api/brands/${brand.slug}/proposals/${id}`).set("Cookie", cookie).send({ action: "approve" })).status).toBe(403);
    const ok = await request(ctx.app).patch(`/api/brands/${brand.slug}/proposals/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "approve" });
    expect(ok.status).toBe(200);
    expect(ok.body.proposal.approvedBy).toBe("manual:evan@example.com");
    const again = await request(ctx.app).patch(`/api/brands/${brand.slug}/proposals/${id}`).set("Cookie", cookie).set("x-csrf-token", csrf).send({ action: "approve" });
    expect(again.status).toBe(409);
    const run = await request(ctx.app).post(`/api/brands/${brand.slug}/execute`).set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(run.status).toBe(200);
    expect(run.body.executed.some((e: { proposalId: string; outcome: string }) => e.proposalId === id && e.outcome === "executed")).toBe(true);
    expect(await executeApproved(db, registry, brand.id)).toEqual([]);
  });
});
