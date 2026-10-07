import type { BrandStatus, Channel } from "../db/schema.js";
import { effectiveMode, type ActionMode, type AutonomyLevel, type AutonomyRules } from "../domain/policy.js";
import type { ProposalPayload } from "../domain/proposals.js";

// The policy evaluator. Pure: everything it needs is in its arguments, it
// never reads the database or the network, and the same input always gives
// the same answer. A violation either blocks the proposal outright or
// demands a person's approval even when the brand is on autopilot.

export interface LedgerSnapshot {
  now: Date;
  brandStatus: BrandStatus;
  /** Spend so far this calendar month, in micros. */
  monthSpendMicros: number;
  /** Days left in the month after today. */
  daysLeftInMonth: number;
  /** Sum of daily budgets live right now (campaigns or their active ad sets). */
  liveDailyBudgetMicros: number;
  /** Current state of objects the proposal touches, by ext_objects id. */
  objects: Record<string, { channel: Channel; status: string | null; dailyBudgetMicros: number | null; externalId: string }>;
  /** Budget changes MarketingBrain itself made in the last 7 days, by object. */
  recentAutoShifts: { extObjectId: string; pct: number; at: Date }[];
  /** Any change MarketingBrain made to an object, newest first. */
  recentChanges: { extObjectId: string; at: Date }[];
}

export interface Violation {
  rule: string;
  detail: string;
  effect: "block" | "approve";
}

export interface PolicyResult {
  allowed: boolean; // false = blocked
  needsApproval: boolean;
  mode: ActionMode;
  violations: Violation[];
}

export interface PolicyInput {
  payload: ProposalPayload;
  level: AutonomyLevel;
  rules: AutonomyRules;
  ledger: LedgerSnapshot;
  /** An undo of something MarketingBrain just did: the cooldown is waived, every other rule applies. */
  rollback?: boolean;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Google may spend up to twice a daily budget on a given day; the monthly
// projection must assume it will.
const overspendFactor = (channel: Channel | undefined) => (channel === "google" ? 2 : 1);

/** Daily-budget deltas the proposal implies, per touched object. */
function budgetDeltas(p: ProposalPayload, ledger: LedgerSnapshot): { extObjectId: string | null; channel: Channel | undefined; from: number; to: number }[] {
  switch (p.type) {
    case "CHANGE_BUDGET": {
      const o = ledger.objects[p.extObjectId];
      return [{ extObjectId: p.extObjectId, channel: o?.channel, from: o?.dailyBudgetMicros ?? 0, to: p.dailyBudgetMicros }];
    }
    case "CREATE_CAMPAIGN":
      return [{ extObjectId: null, channel: undefined, from: 0, to: p.dailyBudgetMicros }];
    case "ACTIVATE": {
      // Turning something on puts its budget back into play.
      const o = ledger.objects[p.extObjectId];
      const budget = o?.dailyBudgetMicros ?? 0;
      return budget > 0 && o?.status !== "ACTIVE" ? [{ extObjectId: null, channel: o?.channel, from: 0, to: budget }] : [];
    }
    case "REALLOCATE_BUDGET": {
      const a = ledger.objects[p.from.extObjectId];
      const b = ledger.objects[p.to.extObjectId];
      return [
        { extObjectId: p.from.extObjectId, channel: a?.channel, from: a?.dailyBudgetMicros ?? 0, to: p.from.dailyBudgetMicros },
        { extObjectId: p.to.extObjectId, channel: b?.channel, from: b?.dailyBudgetMicros ?? 0, to: p.to.dailyBudgetMicros },
      ];
    }
    default:
      return [];
  }
}

function touchedObjects(p: ProposalPayload): string[] {
  switch (p.type) {
    case "PAUSE_AD":
    case "ACTIVATE":
    case "CHANGE_BUDGET":
      return [p.extObjectId];
    case "ROTATE_AD":
      return [p.pause.extObjectId, p.activate.extObjectId];
    case "REALLOCATE_BUDGET":
      return [p.from.extObjectId, p.to.extObjectId];
    default:
      return [];
  }
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { payload, level, rules, ledger } = input;
  const violations: Violation[] = [];
  const mode = effectiveMode(level, rules, payload.type);

  if (ledger.brandStatus !== "active") violations.push({ rule: "brand_halted", detail: `brand is ${ledger.brandStatus}; nothing executes`, effect: "block" });
  if (mode === "never") violations.push({ rule: "action_mode", detail: `${payload.type} is not allowed under level "${level}"`, effect: "block" });

  // Geography: a new campaign may only target allowed countries/regions.
  if (payload.type === "CREATE_CAMPAIGN") {
    const bad = payload.geos.filter((g) => !rules.allowedGeos.some((a) => g === a || g.startsWith(`${a}-`)));
    if (bad.length) violations.push({ rule: "geo_allowlist", detail: `geos not allowed: ${bad.join(", ")}`, effect: "block" });
  }

  // Cooldown: no second change to the same object inside the window.
  const windowMs = input.rollback ? 0 : rules.minHoursBetweenChanges * HOUR;
  for (const id of touchedObjects(payload)) {
    const last = ledger.recentChanges.find((c) => c.extObjectId === id);
    if (last && ledger.now.getTime() - last.at.getTime() < windowMs) {
      const hoursAgo = Math.round((ledger.now.getTime() - last.at.getTime()) / HOUR);
      violations.push({ rule: "cooldown", detail: `${id} was changed ${hoursAgo}h ago; the policy requires ${rules.minHoursBetweenChanges}h between changes`, effect: "block" });
    }
  }

  // Budgets: daily cap and monthly projection, on the state after the change.
  const deltas = budgetDeltas(payload, ledger);
  if (deltas.length) {
    const liveAfter = ledger.liveDailyBudgetMicros + deltas.reduce((a, d) => a + (d.to - d.from), 0);
    if (liveAfter > rules.maxDailySpendMicros) {
      violations.push({ rule: "daily_cap", detail: `daily budgets would total ${liveAfter} micros, above the cap of ${rules.maxDailySpendMicros}`, effect: "block" });
    }
    const projectedRest = deltas.reduce((a, d) => a + d.to * overspendFactor(d.channel), 0) * ledger.daysLeftInMonth;
    const otherLive = Math.max(0, ledger.liveDailyBudgetMicros - deltas.reduce((a, d) => a + d.from, 0)) * ledger.daysLeftInMonth;
    const projected = ledger.monthSpendMicros + otherLive + projectedRest;
    if (projected > rules.monthlyBudgetMicros) {
      violations.push({ rule: "monthly_budget", detail: `projected month spend ${projected} micros would exceed the monthly budget of ${rules.monthlyBudgetMicros}`, effect: "block" });
    }
    // Size of the move, as a share of the current budget, plus what was
    // already moved this week. Beyond the limit a person must say yes.
    for (const d of deltas) {
      if (!d.extObjectId) continue;
      if (d.from <= 0) {
        // No current budget to measure against: the move is unbounded, so a person decides.
        if (d.to > 0) violations.push({ rule: "auto_shift_limit", detail: "setting a budget where there was none is not an automatic move", effect: "approve" });
        continue;
      }
      const pct = (Math.abs(d.to - d.from) / d.from) * 100;
      const already = ledger.recentAutoShifts.filter((s) => s.extObjectId === d.extObjectId && ledger.now.getTime() - s.at.getTime() < 7 * DAY).reduce((a, s) => a + s.pct, 0);
      if (pct + already > rules.maxAutoShiftPct) {
        violations.push({ rule: "auto_shift_limit", detail: `${Math.round(pct)}% move (+${Math.round(already)}% already this week) exceeds the ${rules.maxAutoShiftPct}% automatic limit`, effect: "approve" });
      }
    }
  }

  const blocked = violations.some((v) => v.effect === "block");
  const needsApproval = !blocked && (mode === "approve" || violations.some((v) => v.effect === "approve"));
  return { allowed: !blocked, needsApproval, mode, violations };
}
