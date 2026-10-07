import { desc, eq } from "drizzle-orm";
import type { AiClient } from "../ai/client.js";
import { runAnalyst, type AnalystResult } from "../ai/analyst.js";
import type { Db } from "../db/client.js";
import { analysisReports, auditEvents, brands, type AnalysisReport } from "../db/schema.js";
import { proposeFromFindings } from "../actions/fromFindings.js";
import { runDetectors } from "./detectors.js";
import { buildMetricPack, entryIndex } from "./metricPack.js";

// The morning routine for one brand: pack → detectors → analyst → report.
// Always leaves a report behind, even "nothing to say", so silence is
// never ambiguous.

export async function analyzeBrand(db: Db, ai: AiClient, brandId: string, opts: { actor?: string; kind?: string; today?: Date } = {}): Promise<AnalystResult> {
  const pack = await buildMetricPack(db, brandId, opts.today);
  const findings = runDetectors(pack, entryIndex(pack));
  const result = await runAnalyst(db, ai, brandId, pack, findings, { kind: opts.kind ?? "morning", actor: opts.actor ?? "system:analysis-morning" });
  // What the detectors suggested becomes proposals, each citing the pack
  // entries it rests on; the policy decides whether a person must approve.
  const byId = entryIndex(pack);
  const proposals = await proposeFromFindings(db, brandId, findings, (f) => ({ reportId: result.report.id, detector: f.detector, entries: f.evidence.map((id) => ({ id, value: byId.get(id)?.value ?? null, unit: byId.get(id)?.unit ?? "count", label: byId.get(id)?.label ?? id })) }));
  await db.insert(auditEvents).values({
    actor: opts.actor ?? "system:analysis-morning",
    verb: "brand_analyzed",
    subject: `brand:${brandId}`,
    data: { reportId: result.report.id, findings: findings.length, claims: (result.report.analysis as { claims: unknown[] }).claims.length, dropped: result.dropped.length, isMock: result.isMock, proposals: proposals.filter((p) => !p.duplicate).length },
  });
  return result;
}

export type BrandAnalysisOutcome = { brand: string; reportId: string; findings: number; dropped: number } | { brand: string; error: string };

/** Every brand gets its turn; one brand's failure (a spent AI budget, say) is recorded, not propagated. */
export async function analyzeAllBrands(db: Db, ai: AiClient, opts: { actor?: string } = {}): Promise<BrandAnalysisOutcome[]> {
  const all = await db.select().from(brands).where(eq(brands.status, "active"));
  const out: BrandAnalysisOutcome[] = [];
  for (const b of all) {
    try {
      const r = await analyzeBrand(db, ai, b.id, opts);
      out.push({ brand: b.slug, reportId: r.report.id, findings: (r.report.findings as unknown[]).length, dropped: r.dropped.length });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[analysis] ${b.slug}: ${error}`);
      out.push({ brand: b.slug, error });
    }
  }
  return out;
}

export async function latestReport(db: Db, brandId: string): Promise<AnalysisReport | null> {
  const [row] = await db.select().from(analysisReports).where(eq(analysisReports.brandId, brandId)).orderBy(desc(analysisReports.createdAt)).limit(1);
  return row ?? null;
}
