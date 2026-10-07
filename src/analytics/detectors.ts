import type { MetricPack, PackEntry } from "./metricPack.js";

// Deterministic detectors. Each reads only the metric pack and returns
// findings that cite pack ids. No model, no network. Thresholds are
// relative where they can be (this week vs. its own trailing 28 days)
// so they age better than fixed dollar amounts. A detector never proposes
// more than it can see: `suggested` is a draft for the Action Engine
// (Phase 11) to turn into a proposal under the brand's policy.

export type Severity = "info" | "warning" | "serious";

export interface Finding {
  detector: string;
  severity: Severity;
  subject: PackEntry["scope"];
  text: string;
  evidence: string[]; // pack entry ids
  suggested?: { type: string; payload: Record<string, unknown>; reason: string };
}

type Detector = (pack: MetricPack, byId: Map<string, PackEntry>) => Finding[];

import { moneyText } from "./format.js";

const money = (pack: MetricPack, micros: number | null) => moneyText(pack.currency, micros);

function daysInMonth(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/** Month-to-date spend against the policy's monthly budget, pro rata. */
export const pacing: Detector = (pack, byId) => {
  const budget = pack.context.monthlyBudgetMicros;
  const mtd = byId.get("brand.spend.mtd");
  if (!budget || !mtd || mtd.value === null) return [];
  const today = pack.windows.monthToDate.to;
  const dayOfMonth = Number(today.slice(8, 10));
  const expected = (budget * dayOfMonth) / daysInMonth(today);
  if (expected <= 0) return [];
  const ratio = mtd.value / expected;
  if (ratio > 1.25) {
    return [{ detector: "pacing", severity: "warning", subject: { level: "brand" }, text: `Month-to-date spend ${money(pack, mtd.value)} is ${Math.round((ratio - 1) * 100)}% above the pro-rata share of the monthly budget (${money(pack, Math.round(expected))} by day ${dayOfMonth}).`, evidence: ["brand.spend.mtd"] }];
  }
  if (ratio < 0.5 && dayOfMonth >= 7) {
    return [{ detector: "pacing", severity: "info", subject: { level: "brand" }, text: `Month-to-date spend ${money(pack, mtd.value)} is under half the pro-rata share of the monthly budget (${money(pack, Math.round(expected))} by day ${dayOfMonth}).`, evidence: ["brand.spend.mtd"] }];
  }
  return [];
};

/** The daily budget actually live (campaign budgets, or their active ad sets' budgets) against the policy's daily cap. */
export const dailyCap: Detector = (pack, byId) => {
  const cap = pack.context.maxDailySpendMicros;
  const live = byId.get("brand.daily_budget.live");
  if (!cap || !live || live.value === null || live.value <= cap) return [];
  const campaigns = pack.entries.filter((e) => e.scope.level === "campaign" && e.id.endsWith(".daily_budget") && e.note === "ACTIVE").map((e) => e.id);
  return [{ detector: "daily_cap", severity: "serious", subject: { level: "brand" }, text: `Daily budgets live right now add up to ${money(pack, live.value)}, above the policy's daily cap of ${money(pack, cap)}.`, evidence: [live.id, ...campaigns] }];
};

/** Spend with nothing to show for it: an ad that spent a whole customer's worth (the target CAC, or 50 when none is set) this week with zero registrations. */
export const zeroConversionSpend: Detector = (pack, byId) => {
  const threshold = pack.context.targetCacMicros !== null ? pack.context.targetCacMicros : 50_000_000;
  const out: Finding[] = [];
  for (const e of pack.entries) {
    if (e.scope.level !== "ad" || !e.id.endsWith(".spend.7d") || e.value === null || e.value < threshold) continue;
    const reg = byId.get(e.id.replace(".spend.7d", ".registered.7d"));
    if (!reg || reg.value !== 0) continue;
    out.push({
      detector: "zero_conversion_spend",
      severity: "warning",
      subject: e.scope,
      text: `${e.scope.name} spent ${money(pack, e.value)} in the last 7 days with no registrations.`,
      evidence: [e.id, reg.id],
      suggested: { type: "PAUSE_AD", payload: { kind: "ad", extObjectId: e.scope.extObjectId }, reason: `No registrations after ${money(pack, e.value)} in 7 days` },
    });
  }
  return out;
};

/** A campaign's CPA this week against its own prior 28 days; both sides must have enough data. */
export const cpaDrift: Detector = (pack, byId) => {
  const out: Finding[] = [];
  for (const e of pack.entries) {
    if (e.scope.level !== "campaign" || !e.id.endsWith(".cpa.7d") || e.value === null || e.insufficient) continue;
    const base = byId.get(e.id.replace(".cpa.7d", ".cpa.28d"));
    if (!base || base.value === null || base.value <= 0 || base.insufficient) continue;
    const ratio = e.value / base.value;
    if (ratio >= 1.5) {
      out.push({ detector: "cpa_drift", severity: "warning", subject: e.scope, text: `${e.scope.name} CPA is ${money(pack, e.value)} this week against ${money(pack, base.value)} over its prior 28 days (${Math.round((ratio - 1) * 100)}% higher).`, evidence: [e.id, base.id] });
    } else if (ratio <= 0.6) {
      out.push({ detector: "cpa_drift", severity: "info", subject: e.scope, text: `${e.scope.name} CPA is ${money(pack, e.value)} this week against ${money(pack, base.value)} over its prior 28 days (${Math.round((1 - ratio) * 100)}% lower).`, evidence: [e.id, base.id] });
    }
  }
  return out;
};

/** Frequency climbing while CTR falls: the classic fatigue signature. Stated as a signal, not a cause. */
export const fatigue: Detector = (pack, byId) => {
  const out: Finding[] = [];
  for (const e of pack.entries) {
    if (e.scope.level !== "ad" || !e.id.endsWith(".frequency.7d") || e.value === null || e.value < 3) continue;
    const ctr = byId.get(e.id.replace(".frequency.7d", ".ctr.7d"));
    const ctrBefore = byId.get(e.id.replace(".frequency.7d", ".ctr.prev7d"));
    if (!ctr || !ctrBefore || ctr.value === null || ctrBefore.value === null || ctrBefore.value === 0) continue;
    const drop = 1 - ctr.value / ctrBefore.value;
    if (drop < 0.3) continue;
    out.push({ detector: "fatigue", severity: "warning", subject: e.scope, text: `${e.scope.name}: frequency ${e.value} this week and CTR ${ctr.value}% against ${ctrBefore.value}% the week before (${Math.round(drop * 100)}% lower). Consistent with fatigue; not proof of it.`, evidence: [e.id, ctr.id, ctrBefore.id] });
  }
  return out;
};

/** Ads the platform has stopped or is reviewing. */
export const platformStatus: Detector = (pack) => {
  const out: Finding[] = [];
  for (const e of pack.entries) {
    if (e.scope.level !== "ad" || !e.id.endsWith(".spend.7d")) continue;
    if (e.note === "DISAPPROVED" || e.note === "PENDING_REVIEW") {
      out.push({ detector: "platform_status", severity: e.note === "DISAPPROVED" ? "serious" : "info", subject: e.scope, text: `${e.scope.name} is ${e.note.toLowerCase().replace("_", " ")} on ${e.scope.channel}.`, evidence: [e.id] });
    }
  }
  return out;
};

export const DETECTORS: Detector[] = [pacing, dailyCap, zeroConversionSpend, cpaDrift, fatigue, platformStatus];

export function runDetectors(pack: MetricPack, byId: Map<string, PackEntry>): Finding[] {
  const out: Finding[] = [];
  for (const d of DETECTORS) out.push(...d(pack, byId));
  const rank: Record<Severity, number> = { serious: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
