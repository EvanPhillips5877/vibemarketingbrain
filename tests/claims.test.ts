import { describe, expect, it } from "vitest";
import { admissibleClaims, numbersIn, renderings, validateClaims, type Analysis } from "../src/ai/claims.js";
import type { MetricPack, PackEntry } from "../src/analytics/metricPack.js";

const entry = (id: string, value: number | null, unit: PackEntry["unit"], extra: Partial<PackEntry> = {}): PackEntry => ({ id, label: id, value, unit, window: "7d", scope: { level: "brand" }, ...extra });

const pack: MetricPack = {
  brandId: "b",
  currency: "CAD",
  generatedAt: "2026-10-07T00:00:00Z",
  windows: { current: { from: "2026-09-30", to: "2026-10-06", timezone: "UTC" }, previous: { from: "2026-09-23", to: "2026-09-29", timezone: "UTC" }, trailing: { from: "2026-09-02", to: "2026-09-29", timezone: "UTC" }, monthToDate: { from: "2026-10-01", to: "2026-10-07", timezone: "UTC" } },
  context: { targetCacMicros: null, monthlyBudgetMicros: null, maxDailySpendMicros: null, minConversions: 10 },
  entries: [entry("brand.spend.7d", 2_412_130_000, "micros"), entry("brand.registered.7d", 68, "count"), entry("brand.cpa.7d", 35_472_000, "micros"), entry("brand.cpa.delta_pct", 31.4, "pct"), entry("ad:a9.cpa.7d", 90_000_000, "micros", { insufficient: true })],
};

const analysis = (claims: Analysis["claims"]): Analysis => ({ headline: "h", claims, nextTests: [] });

describe("numbersIn and renderings", () => {
  it("finds metric numbers and ignores window lengths and dates", () => {
    expect(numbersIn("Spend was CA$2,412 over 7 days, up 31.4% vs the previous 7-day window on 2026-10-06, a 2x change, 1.5x the week before")).toEqual([2412, 31.4]);
  });
  it("renders money at several roundings", () => {
    expect(renderings(entry("x", 35_472_000, "micros"))).toEqual([35.472, 35.47, 35.5, 35]);
  });
});

describe("validateClaims", () => {
  it("accepts a fact whose numbers and ids check out", () => {
    expect(validateClaims(analysis([{ kind: "FACT", text: "Spend over the last 7 days was CA$2,412.13 for 68 registrations.", evidence: ["brand.spend.7d", "brand.registered.7d"] }]), pack)).toEqual([]);
  });
  it("rejects a fact with a number that is not in its evidence", () => {
    const issues = validateClaims(analysis([{ kind: "FACT", text: "Spend was CA$2,500.", evidence: ["brand.spend.7d"] }]), pack);
    expect(issues.map((i) => i.problem)).toEqual(["the number 2500 does not match any cited evidence"]);
  });
  it("rejects facts without evidence or with unknown ids", () => {
    const issues = validateClaims(analysis([{ kind: "FACT", text: "CPA is fine.", evidence: [] }, { kind: "OBSERVATION", text: "CPA rose.", evidence: ["brand.cpa.nope"] }]), pack);
    expect(issues.map((i) => i.problem)).toEqual(["FACT has no evidence", "cites evidence that is not in the pack: brand.cpa.nope", "OBSERVATION has no evidence"]);
  });
  it("requires evidence on recommendations and actions too", () => {
    const issues = validateClaims(analysis([{ kind: "RECOMMENDATION", text: "Double the Google budget.", evidence: [] }, { kind: "ACTION", text: "Pause everything.", evidence: [] }, { kind: "HYPOTHESIS", text: "It may be seasonal.", evidence: [] }]), pack);
    expect(issues.map((i) => i.problem)).toEqual(["RECOMMENDATION has no evidence", "ACTION has no evidence"]);
  });

  it("allows causal language only in a hypothesis", () => {
    const bad = validateClaims(analysis([{ kind: "FACT", text: "CPA rose 31.4% because the creative is tired.", evidence: ["brand.cpa.delta_pct"] }]), pack);
    expect(bad[0]?.problem).toMatch(/causal language \("because"\)/);
    const good = validateClaims(analysis([{ kind: "HYPOTHESIS", text: "CPA may have risen because the creative is tired; a fresh variant would test it.", evidence: ["brand.cpa.delta_pct"] }]), pack);
    expect(good).toEqual([]);
  });
  it("downgrades anything resting on insufficient data", () => {
    const bad = validateClaims(analysis([{ kind: "FACT", text: "Ad a9's CPA is CA$90.00.", evidence: ["ad:a9.cpa.7d"] }, { kind: "RECOMMENDATION", text: "Pause ad a9.", evidence: ["ad:a9.cpa.7d"] }]), pack);
    expect(bad.map((i) => i.problem)).toEqual(["FACT rests on an INSUFFICIENT_DATA entry; state it as a HYPOTHESIS", "RECOMMENDATION rests only on INSUFFICIENT_DATA entries"]);
    expect(validateClaims(analysis([{ kind: "HYPOTHESIS", text: "Ad a9 may be expensive (CA$90.00 on too little data).", evidence: ["ad:a9.cpa.7d"] }]), pack)).toEqual([]);
  });
  it("admissibleClaims keeps the good and drops the bad with reasons", () => {
    const { kept, dropped } = admissibleClaims(analysis([{ kind: "FACT", text: "68 registrations.", evidence: ["brand.registered.7d"] }, { kind: "FACT", text: "70 registrations.", evidence: ["brand.registered.7d"] }]), pack);
    expect(kept).toHaveLength(1);
    expect(dropped[0]?.problems[0]).toMatch(/70 does not match/);
  });
});
