import { describe, expect, it } from "vitest";
import { evaluatePolicy, type LedgerSnapshot } from "../src/actions/policy.js";
import { CAD } from "../src/domain/brand.js";
import { ACTION_TYPES, autonomyRulesSchema, type AutonomyLevel, type AutonomyRules } from "../src/domain/policy.js";
import type { ProposalPayload } from "../src/domain/proposals.js";

// The policy evaluator is pure, so every rule gets a table.

const ACCT = "11111111-1111-1111-1111-111111111111";
const C1 = "22222222-2222-2222-2222-222222222221";
const C2 = "22222222-2222-2222-2222-222222222222";
const AD = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2026-10-15T12:00:00Z");

const modes = Object.fromEntries(ACTION_TYPES.map((t) => [t, "approve"])) as AutonomyRules["actionModes"];
const rules: AutonomyRules = autonomyRulesSchema.parse({
  currency: "CAD",
  monthlyBudgetMicros: CAD(1500),
  maxDailySpendMicros: CAD(75),
  maxAutoShiftPct: 20,
  minHoursBetweenChanges: 24,
  maxRunningExperiments: 3,
  allowedGeos: ["CA", "US"],
  actionModes: { ...modes, PAUSE_AD: "auto", CHANGE_BUDGET: "auto", CREATE_CAMPAIGN: "never" },
  monthlyAiBudgetMicros: CAD(100),
});

const ledger = (over: Partial<LedgerSnapshot> = {}): LedgerSnapshot => ({
  now: NOW,
  brandStatus: "active",
  monthSpendMicros: CAD(400),
  daysLeftInMonth: 16,
  liveDailyBudgetMicros: CAD(45),
  objects: {
    [C1]: { channel: "meta", status: "ACTIVE", dailyBudgetMicros: CAD(30), externalId: "c1" },
    [C2]: { channel: "google", status: "ACTIVE", dailyBudgetMicros: CAD(15), externalId: "c2" },
    [AD]: { channel: "meta", status: "ACTIVE", dailyBudgetMicros: null, externalId: "a1" },
  },
  recentAutoShifts: [],
  recentChanges: [],
  ...over,
});

const pause: ProposalPayload = { type: "PAUSE_AD", kind: "ad", externalId: "a1", channelAccountId: ACCT, extObjectId: AD, assumptions: {} };
const budget = (micros: number, extObjectId = C1, externalId = "c1"): ProposalPayload => ({ type: "CHANGE_BUDGET", kind: "campaign", externalId, channelAccountId: ACCT, extObjectId, dailyBudgetMicros: micros, assumptions: {} });
const create = (geos: string[], daily = CAD(10)): ProposalPayload => ({ type: "CREATE_CAMPAIGN", channelAccountId: ACCT, name: "n", objective: "registrations", dailyBudgetMicros: daily, geos, idempotencyKey: "test-campaign-fixture-not-real" });

const run = (payload: ProposalPayload, level: AutonomyLevel = "autopilot", l: LedgerSnapshot = ledger()) => evaluatePolicy({ payload, level, rules, ledger: l });
const rulesHit = (r: ReturnType<typeof run>) => r.violations.map((v) => v.rule);

describe("levels and modes", () => {
  it.each<[AutonomyLevel, boolean, boolean]>([
    ["suggest", false, false],
    ["approve", true, true],
    ["autopilot", true, false],
  ])("level %s: PAUSE_AD (auto) → allowed %s, needsApproval %s", (level, allowed, needsApproval) => {
    const r = run(pause, level);
    expect(r.allowed).toBe(allowed);
    expect(r.needsApproval).toBe(needsApproval);
  });

  it("a type marked never is blocked at every level", () => {
    for (const level of ["suggest", "approve", "autopilot"] as const) expect(rulesHit(run(create(["CA"]), level))).toContain("action_mode");
  });

  it("a halted brand blocks everything", () => {
    const r = run(pause, "autopilot", ledger({ brandStatus: "halted" }));
    expect(r.allowed).toBe(false);
    expect(rulesHit(r)).toEqual(["brand_halted"]);
  });
});

describe("geo allowlist", () => {
  const permissive: AutonomyRules = { ...rules, actionModes: { ...rules.actionModes, CREATE_CAMPAIGN: "approve" } };
  const go = (geos: string[]) => evaluatePolicy({ payload: create(geos), level: "approve", rules: permissive, ledger: ledger() });
  it("accepts allowed countries and their regions, blocks the rest", () => {
    expect(go(["CA", "US", "CA-ON"]).allowed).toBe(true);
    const r = go(["CA", "GB"]);
    expect(r.allowed).toBe(false);
    expect(r.violations[0]).toMatchObject({ rule: "geo_allowlist", detail: "geos not allowed: GB" });
  });
});

describe("cooldown", () => {
  it("blocks a second change inside the window and allows one after it", () => {
    const recent = ledger({ recentChanges: [{ extObjectId: AD, at: new Date(NOW.getTime() - 5 * 3600_000) }] });
    expect(rulesHit(run(pause, "autopilot", recent))).toEqual(["cooldown"]);
    const old = ledger({ recentChanges: [{ extObjectId: AD, at: new Date(NOW.getTime() - 30 * 3600_000) }] });
    expect(run(pause, "autopilot", old).allowed).toBe(true);
  });
  it("a rollback is exempt from the cooldown and nothing else", () => {
    const recent = ledger({ recentChanges: [{ extObjectId: AD, at: new Date(NOW.getTime() - 5 * 3600_000) }], brandStatus: "active" });
    expect(evaluatePolicy({ payload: pause, level: "autopilot", rules, ledger: recent, rollback: true }).allowed).toBe(true);
    expect(evaluatePolicy({ payload: pause, level: "autopilot", rules, ledger: { ...recent, brandStatus: "halted" }, rollback: true }).allowed).toBe(false);
  });

  it("a composite checks every object it touches", () => {
    const rotate: ProposalPayload = { type: "ROTATE_AD", channelAccountId: ACCT, pause: { extObjectId: AD, externalId: "a1", assumptions: {} }, activate: { extObjectId: C1, externalId: "c1", assumptions: {} } };
    const l = ledger({ recentChanges: [{ extObjectId: C1, at: new Date(NOW.getTime() - 1000) }] });
    expect(rulesHit(run(rotate, "autopilot", l))).toEqual(["cooldown"]);
  });
});

describe("daily cap", () => {
  it("evaluates the state after the change, not the delta alone", () => {
    expect(rulesHit(run(budget(CAD(60))))).not.toContain("daily_cap"); // 45 - 30 + 60 = 75, at the cap
    expect(rulesHit(run(budget(CAD(61))))).toContain("daily_cap");
  });
});

describe("monthly projection", () => {
  it("blocks a budget that would overrun the month, counting Google at twice its daily budget", () => {
    // 400 spent + 16 days × (other live 15 + new 30) = 1120: fine.
    expect(run(budget(CAD(30))).allowed).toBe(true);
    // Google object: 400 + 16 × (30 other + 2×40 new) = 2160: blocked.
    const r = run(budget(CAD(40), C2, "c2"));
    expect(rulesHit(r)).toContain("monthly_budget");
    // Same move on the Meta object: 400 + 16 × (15 + 40) = 1280: fine.
    expect(run(budget(CAD(40))).violations.filter((v) => v.rule === "monthly_budget")).toEqual([]);
  });
});

describe("automatic shift limit", () => {
  it("a move within the limit is automatic; beyond it a person must approve; prior moves this week count", () => {
    expect(run(budget(CAD(36))).needsApproval).toBe(false); // +20%
    const r = run(budget(CAD(37))); // +23%
    expect(r.allowed).toBe(true);
    expect(r.needsApproval).toBe(true);
    expect(r.violations[0]).toMatchObject({ rule: "auto_shift_limit", effect: "approve" });
    const already = ledger({ recentAutoShifts: [{ extObjectId: C1, pct: 15, at: new Date(NOW.getTime() - 2 * 24 * 3600_000) }] });
    expect(run(budget(CAD(33)), "autopilot", already).needsApproval).toBe(true); // 10% + 15% > 20%
    const stale = ledger({ recentAutoShifts: [{ extObjectId: C1, pct: 15, at: new Date(NOW.getTime() - 9 * 24 * 3600_000) }] });
    expect(run(budget(CAD(33)), "autopilot", stale).needsApproval).toBe(false);
  });
  it("in approve mode the answer is always a person, and a block still wins", () => {
    expect(run(budget(CAD(36)), "approve").needsApproval).toBe(true);
    const r = run(budget(CAD(200)), "approve");
    expect(r.allowed).toBe(false);
    expect(r.needsApproval).toBe(false);
  });
});

describe("activation and first budgets", () => {
  it("activating a paused campaign puts its budget back under the daily cap and monthly projection", () => {
    const paused = ledger({ objects: { ...ledger().objects, [C1]: { channel: "meta", status: "PAUSED", dailyBudgetMicros: CAD(500), externalId: "c1" } } });
    const activate: ProposalPayload = { type: "ACTIVATE", kind: "campaign", externalId: "c1", channelAccountId: ACCT, extObjectId: C1, assumptions: {} };
    const r = evaluatePolicy({ payload: activate, level: "autopilot", rules: { ...rules, actionModes: { ...rules.actionModes, ACTIVATE: "auto" } }, ledger: paused });
    expect(r.allowed).toBe(false);
    expect(rulesHit(r)).toEqual(expect.arrayContaining(["daily_cap", "monthly_budget"]));
  });
  it("setting a budget where there was none is never automatic", () => {
    const none = ledger({ objects: { ...ledger().objects, [C1]: { channel: "meta", status: "ACTIVE", dailyBudgetMicros: null, externalId: "c1" } } });
    const r = evaluatePolicy({ payload: budget(CAD(20)), level: "autopilot", rules, ledger: none });
    expect(r.allowed).toBe(true);
    expect(r.needsApproval).toBe(true);
    expect(rulesHit(r)).toEqual(["auto_shift_limit"]);
  });
});

describe("reallocation", () => {
  it("moves between two objects are judged together", () => {
    const move: ProposalPayload = { type: "REALLOCATE_BUDGET", channelAccountId: ACCT, kind: "campaign", from: { extObjectId: C1, externalId: "c1", dailyBudgetMicros: CAD(25), assumptions: {} }, to: { extObjectId: C2, externalId: "c2", dailyBudgetMicros: CAD(20), assumptions: {} } };
    const r = run(move);
    expect(r.allowed).toBe(true);
    expect(r.needsApproval).toBe(true); // c2 moves +33%
    expect(rulesHit(r)).toEqual(["auto_shift_limit"]);
  });
});

describe("determinism", () => {
  it("the same input always gives the same answer", () => {
    const a = run(budget(CAD(37)));
    const b = run(budget(CAD(37)));
    expect(a).toEqual(b);
  });
});
