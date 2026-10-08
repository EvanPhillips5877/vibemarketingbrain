import { and, eq, inArray, sql } from "drizzle-orm";
import { adsTable, type AdRow } from "../analytics/ledger.js";
import { moneyText } from "../analytics/format.js";
import { SAMPLE_MIN_CONVERSIONS } from "../analytics/metricPack.js";
import type { Db } from "../db/client.js";
import { auditEvents, brands, channelAccounts, creativeVariants, extObjects, learnings, type Learning } from "../db/schema.js";
import { isoDay } from "../ingest/metrics.js";

// The weekly distillation. Deterministic and thresholded: ads are grouped
// by the creative element they carry (hook type, visual style, template,
// the hypothesis dimensions on their variant), each group must clear the
// minimum sample, and only a clear gap becomes an `observation`. Nothing
// here can write `validated` or `refuted`; that is the experiment's job.

export const JOB_ACTOR = "job:learn-weekly";
export const WINDOW_DAYS = 28;
export const MIN_GAP_PCT = 20;
/** Dimensions worth comparing, in the order they are reported. */
export const DIMENSIONS = ["hook_type", "visual_style", "template", "hyp_sport", "hyp_angle", "hyp_audience"] as const;

export interface Group {
  value: string;
  ads: number;
  spendMicros: number;
  registered: number;
  cpaMicros: number | null;
}

export interface Comparison {
  dimension: string;
  best: Group;
  worst: Group;
  gapPct: number;
  groups: Group[];
}

/** Pure. Groups ads by one dimension and returns a comparison only when two groups clear the sample and the gap is wide enough. */
export function compareByDimension(ads: { spendMicros: number; registered: number; dims: Record<string, string> }[], dimension: string, minConversions = SAMPLE_MIN_CONVERSIONS, minGapPct = MIN_GAP_PCT): Comparison | null {
  const byValue = new Map<string, Group>();
  for (const a of ads) {
    const v = a.dims[dimension];
    if (!v) continue;
    const g = byValue.get(v) ?? { value: v, ads: 0, spendMicros: 0, registered: 0, cpaMicros: null };
    g.ads++;
    g.spendMicros += a.spendMicros;
    g.registered += a.registered;
    byValue.set(v, g);
  }
  const groups = [...byValue.values()].map((g) => ({ ...g, cpaMicros: g.registered > 0 ? Math.round(g.spendMicros / g.registered) : null }));
  // A group with registrations but no spend has no cost to compare (free traffic, or a reporting gap).
  const eligible = groups.filter((g) => g.registered >= minConversions && g.cpaMicros !== null && g.cpaMicros > 0).sort((a, b) => a.cpaMicros! - b.cpaMicros!);
  if (eligible.length < 2) return null;
  const best = eligible[0]!;
  const worst = eligible[eligible.length - 1]!;
  const gapPct = Math.round(((worst.cpaMicros! - best.cpaMicros!) / worst.cpaMicros!) * 100);
  if (gapPct < minGapPct) return null;
  return { dimension, best, worst, gapPct, groups: eligible };
}

export function statementFor(c: Comparison, currency: string, windowDays: number): string {
  const g = (x: Group) => `${moneyText(currency, x.cpaMicros)} CPA over ${x.registered} registrations and ${moneyText(currency, x.spendMicros)} across ${x.ads} ad${x.ads === 1 ? "" : "s"}`;
  return `Over the last ${windowDays} days, ads with ${c.dimension.replace(/^hyp_/, "")} "${c.best.value}" ran at ${g(c.best)}, against "${c.worst.value}" at ${g(c.worst)}: a ${c.gapPct}% lower cost per registration.`;
}

/** Each ad's creative dimensions: its shipped variant's tags, or the platform's own hook tag for ads we did not create. */
async function dimensionsFor(db: Db, brandId: string, ads: AdRow[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (ads.length === 0) return out;
  const rows = await db
    .select({ id: extObjects.id, settings: extObjects.settings, tags: creativeVariants.tags })
    .from(extObjects)
    .innerJoin(channelAccounts, eq(channelAccounts.id, extObjects.channelAccountId))
    .leftJoin(creativeVariants, sql`${creativeVariants.id} = coalesce(${extObjects.creativeVariantId}, nullif(${extObjects.settings}->>'creativeVariantId', '')::uuid)`)
    .where(and(eq(channelAccounts.brandId, brandId), eq(extObjects.kind, "ad"), inArray(extObjects.id, ads.map((a) => a.extObjectId))));
  for (const r of rows) {
    const hook = (r.settings as { hook?: unknown }).hook;
    const dims: Record<string, string> = { ...(typeof hook === "string" ? { hook_type: hook } : {}), ...(r.tags ?? {}) };
    out.set(r.id, dims);
  }
  return out;
}

export interface DistillReport {
  brandId: string;
  window: { from: string; to: string };
  written: { id: string; dimension: string; statement: string }[];
  retired: number;
  skipped: string[];
}

export async function distillBrand(db: Db, brandId: string, today = new Date()): Promise<DistillReport> {
  // Two runs at once (the Monday job and a click on "Distill now") must not
  // both supersede the same prior row: the whole pass holds a per-brand lock.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`distill:${brandId}`}))`);
    return distillLocked(tx as unknown as Db, brandId, today);
  });
}

async function distillLocked(db: Db, brandId: string, today: Date): Promise<DistillReport> {
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  if (!brand) throw new Error("brand not found");
  const window = { from: isoDay(WINDOW_DAYS - 1, today), to: isoDay(0, today), timezone: brand.timezone };
  const ads = await adsTable(db, brandId, window);
  const dims = await dimensionsFor(db, brandId, ads);
  const rows = ads.map((a) => ({ spendMicros: a.spendMicros, registered: a.registered, dims: dims.get(a.extObjectId) ?? {} }));
  const written: DistillReport["written"] = [];
  const skipped: string[] = [];
  let retired = 0;

  for (const dimension of DIMENSIONS) {
    const c = compareByDimension(rows, dimension);
    if (!c) {
      skipped.push(dimension);
      continue;
    }
    const statement = statementFor(c, brand.defaultCurrency, WINDOW_DAYS);
    // Last week's observation on the same dimension is superseded, not duplicated.
    const prior = await db.select().from(learnings).where(and(eq(learnings.brandId, brandId), eq(learnings.status, "active"), eq(learnings.createdBy, JOB_ACTOR), sql`${learnings.evidence}->>'dimension' = ${dimension}`));
    const [row] = await db
      .insert(learnings)
      .values({
        brandId,
        statement,
        kind: "observation",
        scope: "creative",
        dimensions: { [dimension]: c.best.value },
        evidence: { dimension, window, groups: c.groups, gapPct: c.gapPct, minConversions: SAMPLE_MIN_CONVERSIONS },
        confidence: Math.min(0.6, 0.3 + c.gapPct / 200),
        supersedesId: prior[0]?.id ?? null,
        createdBy: JOB_ACTOR,
      })
      .returning();
    for (const p of prior) {
      await db.update(learnings).set({ status: "retired" }).where(eq(learnings.id, p.id));
      retired++;
    }
    written.push({ id: row!.id, dimension, statement });
  }
  await db.insert(auditEvents).values({ actor: JOB_ACTOR, verb: "learnings_distilled", subject: `brand:${brandId}`, data: { window, written: written.length, retired, skipped } });
  return { brandId, window: { from: window.from, to: window.to }, written, retired, skipped };
}

export async function distillAllBrands(db: Db): Promise<(DistillReport | { brandId: string; error: string })[]> {
  const all = await db.select().from(brands).where(eq(brands.status, "active"));
  const out: (DistillReport | { brandId: string; error: string })[] = [];
  for (const b of all) {
    try {
      out.push(await distillBrand(db, b.id));
    } catch (err) {
      out.push({ brandId: b.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/* ── What the generators read ───────────────────────────────────────── */

/** Active learnings that touch the hypothesis: shared dimensions first, then the brand's creative learnings, a handful at most. */
export async function relevantLearnings(db: Db, brandId: string, dims: Record<string, string>, limit = 8): Promise<Learning[]> {
  const all = await db.select().from(learnings).where(and(eq(learnings.status, "active"), sql`(${learnings.brandId} = ${brandId} or ${learnings.brandId} is null)`));
  const score = (l: Learning) => {
    let s = l.kind === "validated" || l.kind === "refuted" ? 2 : 0;
    for (const [k, v] of Object.entries(l.dimensions)) {
      const key = k.replace(/^hyp_/, "");
      if (dims[key] === v || dims[`hyp_${key}`] === v) s += 3;
      else if (dims[key] !== undefined || dims[`hyp_${key}`] !== undefined) s -= 4; // the same dimension, a different value: about something else
    }
    if (l.scope === "creative") s += 1;
    return s;
  };
  return all
    .map((l) => ({ l, s: score(l) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.l.createdAt.getTime() - a.l.createdAt.getTime())
    .slice(0, limit)
    .map((x) => x.l);
}

export function renderLearnings(list: Learning[]): string {
  if (list.length === 0) return "(none yet)";
  return list.map((l) => `- [${l.kind}] ${l.statement}`).join("\n");
}
