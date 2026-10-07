import type { BrandFact } from "../db/schema.js";

// Deterministic check of copy against the brand's prohibited claims. Each
// active `prohibited_claim` fact may carry `patterns` (regular expressions,
// case-insensitive) in its value; copy that matches one is flagged with the
// rule it broke. This runs before any model-based read and is the one that
// can block.

export interface Violation {
  factId: string;
  key: string;
  rule: string;
  pattern: string;
  match: string;
}

export interface ComplianceResult {
  ok: boolean;
  violations: Violation[];
  /** Rules that had no patterns and so could not be checked mechanically. */
  uncheckedRules: { factId: string; key: string; rule: string }[];
}

export function compilePatterns(fact: BrandFact): RegExp[] {
  const raw = (fact.value as { patterns?: unknown }).patterns;
  if (!Array.isArray(raw)) return [];
  const out: RegExp[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || p.length === 0 || p.length > 200) continue;
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // a bad pattern is skipped, not fatal; the rule shows up as unchecked
    }
  }
  return out;
}

export function checkCopy(text: string, facts: BrandFact[]): ComplianceResult {
  const violations: Violation[] = [];
  const uncheckedRules: ComplianceResult["uncheckedRules"] = [];
  for (const f of facts) {
    if (f.category !== "prohibited_claim" || f.status !== "active") continue;
    const patterns = compilePatterns(f);
    if (patterns.length === 0) {
      uncheckedRules.push({ factId: f.id, key: f.key, rule: String(f.value.text) });
      continue;
    }
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) violations.push({ factId: f.id, key: f.key, rule: String(f.value.text), pattern: re.source, match: m[0].slice(0, 120) });
    }
  }
  return { ok: violations.length === 0, violations, uncheckedRules };
}
