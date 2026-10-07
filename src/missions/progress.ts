import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, brands, experiments, hypotheses, learnings, missions, type Experiment, type ExperimentConclusion } from "../db/schema.js";
import { experimentLedger, linkCreatedObjects, missionProgress, type Ledger } from "./ledger.js";
import { askForCampaign, latestProposals, LIVE_PROPOSAL } from "./missions.js";

// The daily progress pass. Plain thresholds, as the plan says for V1:
// an experiment ends when its budget is spent or its date passes; the
// conclusion compares the primary metric with the target behind a minimum
// sample; the learning it writes is the only way a `validated`/`refuted`
// learning comes into being.

export const MIN_CONVERSIONS = 10;

export interface Verdict {
  conclusion: ExperimentConclusion;
  metricValue: number | null;
  reason: string;
}

/** Pure. */
export function judge(e: Pick<Experiment, "primaryMetric" | "targetValue">, l: Ledger): Verdict {
  const conversions = e.primaryMetric === "paid_cac" ? l.paid : l.registered;
  const value = e.primaryMetric === "cpa" ? l.cpaMicros : e.primaryMetric === "paid_cac" ? l.cacMicros : e.primaryMetric === "ctr" ? (l.impressions > 0 ? l.clicks / l.impressions : null) : l.clicks > 0 ? l.registered / l.clicks : null;
  if (conversions < MIN_CONVERSIONS) return { conclusion: "inconclusive", metricValue: value, reason: `${conversions} conversions, below the minimum of ${MIN_CONVERSIONS}` };
  if (e.targetValue === null || value === null) return { conclusion: "inconclusive", metricValue: value, reason: "no target to judge against" };
  // Lower is better for costs; higher is better for rates.
  const better = e.primaryMetric === "cpa" || e.primaryMetric === "paid_cac" ? value <= e.targetValue : value >= e.targetValue;
  return { conclusion: better ? "supported" : "refuted", metricValue: value, reason: `${e.primaryMetric} ${value} vs target ${e.targetValue} on ${conversions} conversions` };
}

/** End one experiment: judge it, write the learning, update the hypothesis. */
async function closeExperiment(db: Db, brandId: string, e: Experiment, now: Date, why: string): Promise<{ experimentId: string; conclusion: ExperimentConclusion; reason: string }> {
  const ledger = await experimentLedger(db, e);
  const v = judge(e, ledger);
  const reason = why ? `${v.reason}; ${why}` : v.reason;
  const [learning] = await db
    .insert(learnings)
    .values({
      brandId,
      statement: v.conclusion === "inconclusive" ? `Inconclusive: ${e.name} (${reason}).` : `${v.conclusion === "supported" ? "Supported" : "Refuted"}: ${e.name}. ${reason}.`,
      kind: v.conclusion === "supported" ? "validated" : v.conclusion === "refuted" ? "refuted" : "observation",
      scope: "creative",
      dimensions: (await db.select({ d: hypotheses.dimensions }).from(hypotheses).where(eq(hypotheses.id, e.hypothesisId)))[0]?.d ?? {},
      evidence: { experimentId: e.id, ledger, metric: e.primaryMetric, target: e.targetValue, value: v.metricValue },
      confidence: v.conclusion === "inconclusive" ? 0.2 : 0.7,
      createdBy: "job:mission-progress",
    })
    .returning();
  await db.update(experiments).set({ status: "ended", result: { ...(e.result ?? {}), ledger, verdict: { ...v, reason } }, conclusion: v.conclusion, concludedAt: now, learningId: learning!.id }).where(eq(experiments.id, e.id));
  await db.update(hypotheses).set({ status: v.conclusion }).where(eq(hypotheses.id, e.hypothesisId));
  return { experimentId: e.id, conclusion: v.conclusion, reason };
}

export interface ProgressReport {
  brandId: string;
  linked: number;
  closed: { experimentId: string; conclusion: ExperimentConclusion; reason: string }[];
  started: string[];
  asked: string[];
  missionsDone: string[];
}

export async function progressBrand(db: Db, brandId: string, now = new Date()): Promise<ProgressReport> {
  const linked = await linkCreatedObjects(db, brandId);
  const closed: ProgressReport["closed"] = [];
  const started: string[] = [];
  const asked: string[] = [];
  const missionsDone: string[] = [];
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  if (!brand) throw new Error("brand not found");

  const active = await db.select().from(missions).where(and(eq(missions.brandId, brandId), eq(missions.status, "active")));
  for (const m of active) {
    const exps = await db.select().from(experiments).where(eq(experiments.missionId, m.id)).orderBy(experiments.createdAt);
    const [policyMax] = await db.execute(sql`select (rules->>'maxRunningExperiments')::int as n from autonomy_policies where brand_id = ${brandId} order by version desc limit 1`).then((r) => r.rows as { n: number }[]);
    const maxRunning = policyMax?.n ?? 3;

    for (const e of exps.filter((x) => x.status === "running")) {
      const ledger = await experimentLedger(db, e);
      const over = ledger.spendMicros >= e.budgetMicros;
      const late = e.endsAt !== null && e.endsAt.getTime() <= now.getTime();
      if (!over && !late) continue;
      closed.push(await closeExperiment(db, brandId, e, now, over ? "budget spent" : "end date passed"));
    }

    // Fill the running slots from the planned queue.
    const fresh = await db.select().from(experiments).where(eq(experiments.missionId, m.id)).orderBy(experiments.createdAt);
    let running = fresh.filter((x) => x.status === "running").length;
    for (const e of fresh.filter((x) => x.status === "planned")) {
      if (running >= maxRunning) break;
      const endsAt = m.endsAt ?? new Date(now.getTime() + 30 * 86400_000);
      await db.update(experiments).set({ status: "running", startsAt: now, endsAt }).where(eq(experiments.id, e.id));
      await db.update(hypotheses).set({ status: "testing" }).where(eq(hypotheses.id, e.hypothesisId));
      started.push(e.id);
      running++;
    }

    // Every running experiment has a live campaign ask (pending or executed), or gets a fresh one.
    const nowRunning = await db.select().from(experiments).where(and(eq(experiments.missionId, m.id), eq(experiments.status, "running")));
    const latest = await latestProposals(db, nowRunning.map((e) => e.id));
    for (const e of nowRunning) {
      const p = latest.get(e.id);
      if (p && LIVE_PROPOSAL.includes(p.status)) continue;
      const r = await askForCampaign(db, brand, m, e, "system:mission-progress");
      if (r && !r.duplicate) asked.push(e.id);
    }

    const progress = await missionProgress(db, m, now);
    const allEnded = fresh.every((x) => x.status === "ended") || (running === 0 && fresh.length > 0);
    const done = progress.goalReached >= m.goal.target || progress.ledger.spendMicros >= m.budgetMicros || (m.endsAt !== null && m.endsAt.getTime() <= now.getTime()) || (allEnded && closed.length > 0);
    if (done) {
      // Nothing stays running under a closed mission: running ones get their
      // verdict now; queued ones end without a learning (they never ran).
      const why = progress.goalReached >= m.goal.target ? "mission goal reached" : progress.ledger.spendMicros >= m.budgetMicros ? "mission budget spent" : "mission ended";
      for (const e of nowRunning) closed.push(await closeExperiment(db, brandId, e, now, why));
      await db.update(experiments).set({ status: "ended", conclusion: "inconclusive", concludedAt: now, result: sql`coalesce(result, '{}'::jsonb) || ${JSON.stringify({ verdict: { conclusion: "inconclusive", metricValue: null, reason: `never ran; ${why}` } })}::jsonb` }).where(and(eq(experiments.missionId, m.id), eq(experiments.status, "planned")));
      await db.update(hypotheses).set({ status: "untested" }).where(and(eq(hypotheses.missionId, m.id), eq(hypotheses.status, "testing")));
      await db.update(missions).set({ status: "done", updatedAt: sql`now()` }).where(eq(missions.id, m.id));
      missionsDone.push(m.id);
    }
  }
  await db.insert(auditEvents).values({ actor: "system:mission-progress", verb: "missions_progressed", subject: `brand:${brandId}`, data: { linked, closed: closed.length, started: started.length, asked: asked.length, missionsDone } });
  return { brandId, linked, closed, started, asked, missionsDone };
}
