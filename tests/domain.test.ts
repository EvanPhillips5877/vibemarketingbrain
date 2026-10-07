import { describe, expect, it } from "vitest";
import { brandDefaultsSchema, brandFactInputSchema, CAD } from "../src/domain/brand.js";
import { ACTION_TYPES, autonomyRulesSchema, effectiveMode, type AutonomyRules } from "../src/domain/policy.js";

const modes = Object.fromEntries(ACTION_TYPES.map((t) => [t, "approve"])) as AutonomyRules["actionModes"];
const good = {
  currency: "CAD",
  monthlyBudgetMicros: CAD(1500),
  maxDailySpendMicros: CAD(75),
  maxAutoShiftPct: 20,
  minHoursBetweenChanges: 24,
  maxRunningExperiments: 3,
  allowedGeos: ["CA", "US"],
  actionModes: modes,
  monthlyAiBudgetMicros: CAD(100),
};

describe("autonomy rules", () => {
  it("accepts the TryoutBrain shape", () => {
    expect(autonomyRulesSchema.parse(good)).toEqual(good);
  });

  it("rejects a daily cap that could blow through the month", () => {
    expect(() => autonomyRulesSchema.parse({ ...good, maxDailySpendMicros: CAD(200) })).toThrow(/monthly budget/);
  });

  it("rejects negative money, bad percentages, zero geos and unknown keys", () => {
    expect(() => autonomyRulesSchema.parse({ ...good, monthlyBudgetMicros: -1 })).toThrow();
    expect(() => autonomyRulesSchema.parse({ ...good, maxAutoShiftPct: 101 })).toThrow();
    expect(() => autonomyRulesSchema.parse({ ...good, allowedGeos: [] })).toThrow();
    expect(() => autonomyRulesSchema.parse({ ...good, surprise: true })).toThrow();
  });

  it("requires a mode for every action type", () => {
    const { PAUSE_AD: _drop, ...rest } = modes;
    expect(() => autonomyRulesSchema.parse({ ...good, actionModes: rest })).toThrow(/actionModes\.PAUSE_AD/);
  });

  it("derives the effective mode from level and per-type setting", () => {
    const rules = { ...good, actionModes: { ...modes, PAUSE_AD: "auto", CREATE_CAMPAIGN: "never" } } as AutonomyRules;
    expect(effectiveMode("suggest", rules, "PAUSE_AD")).toBe("never");
    expect(effectiveMode("approve", rules, "PAUSE_AD")).toBe("approve");
    expect(effectiveMode("autopilot", rules, "PAUSE_AD")).toBe("auto");
    expect(effectiveMode("autopilot", rules, "CHANGE_BUDGET")).toBe("approve");
    expect(effectiveMode("autopilot", rules, "CREATE_CAMPAIGN")).toBe("never");
  });
});

describe("brand domain", () => {
  it("validates defaults and the floor/ceiling relationship", () => {
    const d = { geos: ["CA"], objective: "registrations", dailyBudgetFloorMicros: CAD(5), dailyBudgetCeilingMicros: CAD(50), utmTemplate: "utm_source=x" };
    expect(brandDefaultsSchema.parse(d).language).toBe("en");
    expect(() => brandDefaultsSchema.parse({ ...d, dailyBudgetCeilingMicros: CAD(1) })).toThrow(/Ceiling/);
  });

  it("requires readable text on every fact and slug-shaped keys", () => {
    expect(() => brandFactInputSchema.parse({ category: "product", key: "Bad Key", value: { text: "x" }, source: "manual" })).toThrow(/slug/);
    expect(() => brandFactInputSchema.parse({ category: "product", key: "ok", value: { nope: 1 }, source: "manual" })).toThrow();
    expect(brandFactInputSchema.parse({ category: "product", key: "ok", value: { text: "x" }, source: "crawl" }).status).toBe("proposed");
  });
});
