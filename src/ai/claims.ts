import { z } from "zod/v4";
import type { MetricPack, PackEntry } from "../analytics/metricPack.js";

// The discipline the Analyst lives under. A claim says what kind of
// statement it is; the validator holds it to that. FACTs and OBSERVATIONs
// must point at pack entries and quote numbers that are actually there;
// causal language belongs only in a HYPOTHESIS; anything resting on an
// entry marked insufficient cannot be stated as fact.

export const CLAIM_KINDS = ["FACT", "OBSERVATION", "HYPOTHESIS", "RECOMMENDATION", "ACTION"] as const;

export const claimSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  text: z.string().min(1).max(600),
  evidence: z.array(z.string().min(1).max(120)).max(12),
  confidence: z.number().min(0).max(1).optional(),
});
export type Claim = z.infer<typeof claimSchema>;

export const analysisSchema = z.object({
  headline: z.string().min(1).max(200),
  // Generous caps here; the analyst trims to its display limits after validation.
  claims: z.array(claimSchema).max(100),
  nextTests: z.array(z.string().min(1).max(300)).max(20),
});
export type Analysis = z.infer<typeof analysisSchema>;

export interface ClaimIssue {
  index: number;
  problem: string;
}

const CAUSAL = /\b(because|due to|caused by|causes?|led to|leads to|as a result of|driven by|thanks to|owing to|resulted in|results in)\b/i;
// Numbers in a sentence that are not metrics: dates (checked first, so a
// year inside a date does not leave its month and day behind), years, and
// window lengths such as "7 days" or "2x".
const NOT_A_METRIC = /\b\d{4}-\d{2}(?:-\d{2})?\b|\b20\d\d\b|\b\d+(?:\.\d+)?(?=\s*-?\s*(?:day|days|d|week|weeks|h|hours|x)\b)/gi;

export function numbersIn(text: string): number[] {
  const scrubbed = text.replace(NOT_A_METRIC, " ");
  const out: number[] = [];
  for (const m of scrubbed.matchAll(/(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(Math.abs(n));
  }
  return out;
}

/** The ways a pack entry may legitimately appear in prose. */
export function renderings(e: PackEntry): number[] {
  if (e.value === null) return [];
  const v = e.value;
  if (e.unit === "micros") {
    const major = v / 1_000_000;
    return [major, Math.round(major * 100) / 100, Math.round(major * 10) / 10, Math.round(major)];
  }
  if (e.unit === "pct" || e.unit === "ratio") return [v, Math.round(v * 10) / 10, Math.round(v), Math.abs(v)];
  return [v];
}

function closeEnough(n: number, candidates: number[]): boolean {
  return candidates.some((c) => Math.abs(c - n) <= Math.max(0.011, Math.abs(c) * 0.006));
}

/** Pure. Returns the problems; an empty list means the analysis is admissible. */
export function validateClaims(analysis: Analysis, pack: MetricPack): ClaimIssue[] {
  const byId = new Map(pack.entries.map((e) => [e.id, e]));
  const issues: ClaimIssue[] = [];
  analysis.claims.forEach((c, index) => {
    const refs = c.evidence.map((id) => byId.get(id));
    const unknown = c.evidence.filter((id) => !byId.has(id));
    if (unknown.length) issues.push({ index, problem: `cites evidence that is not in the pack: ${unknown.join(", ")}` });
    const known = refs.filter((r): r is PackEntry => r !== undefined);

    // Every kind but a hypothesis must point at something in the pack.
    if (c.kind !== "HYPOTHESIS" && known.length === 0) issues.push({ index, problem: `${c.kind} has no evidence` });
    if (c.kind !== "HYPOTHESIS" && CAUSAL.test(c.text)) issues.push({ index, problem: `causal language ("${CAUSAL.exec(c.text)![0]}") is only allowed in a HYPOTHESIS` });
    if ((c.kind === "FACT" || c.kind === "OBSERVATION") && known.some((r) => r.insufficient)) issues.push({ index, problem: `${c.kind} rests on an INSUFFICIENT_DATA entry; state it as a HYPOTHESIS` });
    if (c.kind === "RECOMMENDATION" && known.length > 0 && known.every((r) => r.insufficient)) issues.push({ index, problem: "RECOMMENDATION rests only on INSUFFICIENT_DATA entries" });

    if (c.kind === "FACT" || c.kind === "OBSERVATION") {
      const allowed = known.flatMap(renderings);
      for (const n of numbersIn(c.text)) {
        if (!closeEnough(n, allowed)) issues.push({ index, problem: `the number ${n} does not match any cited evidence` });
      }
    }
  });
  return issues;
}

/** Keep the admissible claims, drop the rest. Used after a failed retry so a report is never empty-handed. */
export function admissibleClaims(analysis: Analysis, pack: MetricPack): { kept: Claim[]; dropped: { claim: Claim; problems: string[] }[] } {
  const issues = validateClaims(analysis, pack);
  const bad = new Map<number, string[]>();
  for (const i of issues) bad.set(i.index, [...(bad.get(i.index) ?? []), i.problem]);
  const kept: Claim[] = [];
  const dropped: { claim: Claim; problems: string[] }[] = [];
  analysis.claims.forEach((c, i) => (bad.has(i) ? dropped.push({ claim: c, problems: bad.get(i)! }) : kept.push(c)));
  return { kept, dropped };
}
