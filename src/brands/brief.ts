import type { BrandFact } from "../db/schema.js";
import { FACT_CATEGORIES, type FactCategory } from "../domain/brand.js";

// The Brand Brief: what every prompt about this brand starts with. Rendered
// deterministically from ACTIVE facts only, in a fixed category order, so
// the same facts always produce the same bytes (prompt caching likes that)
// and nothing proposed or retired leaks into a model's view of the brand.

const HEADINGS: Record<FactCategory, string> = {
  product: "What it is",
  audience: "Who buys it",
  sport: "Sports served",
  geo: "Markets",
  problem: "Problems it solves",
  differentiator: "What sets it apart",
  pricing: "Pricing",
  offer: "Offers",
  testimonial: "What customers say",
  competitor: "Competitors",
  landing_page: "Landing pages",
  voice: "Voice",
  visual: "Visual identity",
  seasonality: "Seasonality",
  messaging_won: "Messaging that worked",
  messaging_lost: "Messaging that did not work",
  prohibited_claim: "Never say",
};

export interface BriefOptions {
  /** Cap on characters, to keep a prompt bounded. Facts beyond it are dropped from the least important categories first. */
  maxChars?: number;
}

export function renderBrief(brandName: string, website: string, facts: BrandFact[], opts: BriefOptions = {}): string {
  const maxChars = opts.maxChars ?? 12_000;
  const active = facts.filter((f) => f.status === "active");
  const lines: string[] = [`# ${brandName}`, `Website: ${website}`, ""];
  for (const category of FACT_CATEGORIES) {
    const mine = active.filter((f) => f.category === category).sort((a, b) => a.key.localeCompare(b.key));
    if (mine.length === 0) continue;
    lines.push(`## ${HEADINGS[category]}`);
    for (const f of mine) {
      const extra = Object.entries(f.value)
        .filter(([k]) => k !== "text" && k !== "quote" && k !== "patterns")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
      lines.push(`- ${f.value.text}${extra ? ` (${extra})` : ""}`);
    }
    lines.push("");
  }
  let out = lines.join("\n").trimEnd();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}
