import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AiClient } from "../ai/client.js";
import { propose, type ProposeResult } from "../actions/proposals.js";
import { renderBrief } from "../brands/brief.js";
import { listFacts } from "../brands/facts.js";
import { currentPolicy } from "../brands/queries.js";
import type { Db } from "../db/client.js";
import { actionProposals, auditEvents, channelAccounts, experiments, hypotheses, learnings, missions, type ActionProposal, type Brand, type Experiment, type Mission } from "../db/schema.js";
import { missionDraftSchema, parseMission, type MissionDraft } from "./parse.js";
import { planMission, planSchema, type Plan } from "./plan.js";

// Mission lifecycle: draft (parsed, a person edits/confirms) → planned (the
// strategist's plan is on the row) → active (experiments exist; the first
// ones are running and have asked for campaigns) → done.

export class MissionNotFound extends Error {}
export class MissionStateError extends Error {}

export async function draftMission(db: Db, ai: AiClient, brand: Brand, text: string, actor: string): Promise<{ mission: Mission; isMock: boolean; assumptions: string[] }> {
  const policy = await currentPolicy(db, brand.id);
  const { draft, isMock } = await parseMission(ai, brand, text, { markets: brand.defaults.geos, budgetMicros: policy?.rules.monthlyBudgetMicros ?? 1_000_000_000 });
  const [row] = await db
    .insert(missions)
    .values({
      brandId: brand.id,
      objectiveText: draft.objectiveText,
      goal: draft.goal,
      targetCacMicros: draft.targetCacMicros,
      budgetMicros: draft.budgetMicros,
      markets: draft.markets,
      channels: draft.channels,
      status: "draft",
      plan: { durationDays: draft.durationDays, assumptions: draft.assumptions },
    })
    .returning();
  await db.insert(auditEvents).values({ actor, verb: "mission_drafted", subject: `mission:${row!.id}`, data: { brandId: brand.id, isMock, assumptions: draft.assumptions } });
  return { mission: row!, isMock, assumptions: draft.assumptions };
}

async function owned(db: Db, brandId: string, id: string): Promise<Mission> {
  const [m] = await db.select().from(missions).where(and(eq(missions.id, id), eq(missions.brandId, brandId)));
  if (!m) throw new MissionNotFound("mission not found");
  return m;
}

const editSchema = missionDraftSchema.pick({ objectiveText: true, goal: true, targetCacMicros: true, budgetMicros: true, markets: true, channels: true, durationDays: true }).partial();

/**
 * A person corrects the parsed fields. Only while draft or planned. A plan
 * was made for the old fields, so editing a planned mission drops it and
 * returns the mission to draft: plan again before activating.
 */
export async function editMission(db: Db, brandId: string, id: string, actor: string, input: unknown): Promise<Mission> {
  const m = await owned(db, brandId, id);
  if (m.status !== "draft" && m.status !== "planned") throw new MissionStateError(`mission is ${m.status}`);
  const e = editSchema.parse(input);
  const { strategist: _dropped, plannedAt: _at, isMock: _mock, ...kept } = (m.plan ?? {}) as Record<string, unknown>;
  const plan = { ...kept, ...(e.durationDays ? { durationDays: e.durationDays } : {}) };
  const [row] = await db
    .update(missions)
    .set({
      ...(e.objectiveText ? { objectiveText: e.objectiveText } : {}),
      ...(e.goal ? { goal: e.goal } : {}),
      ...(e.targetCacMicros !== undefined ? { targetCacMicros: e.targetCacMicros } : {}),
      ...(e.budgetMicros ? { budgetMicros: e.budgetMicros } : {}),
      ...(e.markets ? { markets: e.markets } : {}),
      ...(e.channels ? { channels: e.channels } : {}),
      plan,
      status: "draft",
      updatedAt: sql`now()`,
    })
    .where(eq(missions.id, id))
    .returning();
  await db.insert(auditEvents).values({ actor, verb: "mission_edited", subject: `mission:${id}`, data: { brandId, fields: Object.keys(e), planDropped: m.status === "planned" } });
  return row!;
}

export async function planForMission(db: Db, ai: AiClient, brand: Brand, id: string, actor: string): Promise<{ mission: Mission; plan: Plan; isMock: boolean }> {
  const m = await owned(db, brand.id, id);
  if (m.status !== "draft" && m.status !== "planned") throw new MissionStateError(`mission is ${m.status}`);
  const facts = await listFacts(db, brand.id);
  const brief = renderBrief(brand.name, brand.website, facts);
  const learned = await db.select().from(learnings).where(and(eq(learnings.status, "active"), sql`(${learnings.brandId} = ${brand.id} or ${learnings.brandId} is null)`)).orderBy(desc(learnings.createdAt)).limit(30);
  const { plan, isMock } = await planMission(ai, brand, brief, m, learned, facts);
  const [row] = await db.update(missions).set({ plan: { ...(m.plan ?? {}), strategist: plan, plannedAt: new Date().toISOString(), isMock }, status: "planned", updatedAt: sql`now()` }).where(eq(missions.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "mission_planned", subject: `mission:${id}`, data: { brandId: brand.id, hypotheses: plan.hypotheses.length, isMock } });
  return { mission: row!, plan, isMock };
}

/** Proposal statuses that mean the campaign ask is pending or done; anything else can be asked again (one row per day). */
export const LIVE_PROPOSAL: ActionProposal["status"][] = ["proposed", "awaiting_approval", "approved", "executing", "executed", "unknown"];

export async function latestProposals(db: Db, experimentIds: string[]): Promise<Map<string, ActionProposal>> {
  const out = new Map<string, ActionProposal>();
  if (experimentIds.length === 0) return out;
  const rows = await db
    .select()
    .from(actionProposals)
    .where(and(inArray(actionProposals.experimentId, experimentIds), eq(actionProposals.type, "CREATE_CAMPAIGN")))
    .orderBy(desc(actionProposals.createdAt));
  for (const r of rows) if (r.experimentId && !out.has(r.experimentId)) out.set(r.experimentId, r);
  return out;
}

/**
 * Ask the Action Engine for the experiment's paused campaign. Idempotent on
 * the platform (key experiment-<id>) and one proposal per local day; a
 * blocked or rejected ask is asked again by the next daily pass, so the
 * person sees it on Today until it is executed or the experiment ends.
 */
export async function askForCampaign(db: Db, brand: Brand, mission: Mission, exp: Experiment, actor: string): Promise<ProposeResult | null> {
  const accounts = await db.select().from(channelAccounts).where(and(eq(channelAccounts.brandId, brand.id), eq(channelAccounts.status, "active")));
  const account = accounts.find((a) => a.channel === exp.channel) ?? accounts.find((a) => a.channel === "mock") ?? null;
  if (!account) return null;
  const [hyp] = await db.select().from(hypotheses).where(eq(hypotheses.id, exp.hypothesisId));
  const rules = (exp.result ?? {}) as { killRule?: string; scaleRule?: string };
  const durationDays = Math.max(1, exp.startsAt && exp.endsAt ? Math.round((exp.endsAt.getTime() - exp.startsAt.getTime()) / 86400_000) : Number((mission.plan as { durationDays?: number } | null)?.durationDays ?? 60));
  // Daily budget over the experiment's life, within the brand's floor and ceiling.
  const daily = Math.min(brand.defaults.dailyBudgetCeilingMicros, Math.max(brand.defaults.dailyBudgetFloorMicros, Math.round(exp.budgetMicros / durationDays)));
  return propose(db, {
    brandId: brand.id,
    payload: { type: "CREATE_CAMPAIGN", channelAccountId: account.id, name: `${brand.name} · ${exp.name}`, objective: brand.defaults.objective, dailyBudgetMicros: daily, geos: mission.markets, idempotencyKey: `experiment-${exp.id}` },
    reason: `Experiment "${exp.name}": ${hyp?.statement ?? ""}. Kill: ${rules.killRule ?? "—"}. Scale: ${rules.scaleRule ?? "—"}.`,
    source: actor,
    evidence: { experimentId: exp.id, hypothesisId: exp.hypothesisId, budgetMicros: exp.budgetMicros, durationDays },
    expectedOutcome: `A paused ${exp.channel} campaign at ${daily} micros/day for the experiment; creatives and activation follow as their own proposals.`,
    missionId: mission.id,
    experimentId: exp.id,
  });
}

export interface ActivateResult {
  mission: Mission;
  experiments: Experiment[];
  proposals: ProposeResult[];
}

/**
 * Planned → active: experiments from the plan, the first N running, each
 * asking for a paused campaign. The row is locked while the experiments are
 * created, so two activations of the same mission yield one set: the second
 * sees "active" and is refused. The asks happen after the commit; a failed
 * ask is retried by the daily pass, never by creating experiments twice.
 */
export async function activateMission(db: Db, brand: Brand, id: string, actor: string, now = new Date()): Promise<ActivateResult> {
  const policy = await currentPolicy(db, brand.id);
  const maxRunning = policy?.rules.maxRunningExperiments ?? 3;

  const { mission: row, created } = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from ${missions} where id = ${id} and brand_id = ${brand.id} for update`);
    if (!locked.rows[0]) throw new MissionNotFound("mission not found");
    const [m] = await tx.select().from(missions).where(eq(missions.id, id));
    if (!m || m.status !== "planned") throw new MissionStateError(`mission is ${m?.status ?? "missing"}; plan it first`);
    const plan = planSchema.parse((m.plan as { strategist?: unknown } | null)?.strategist);
    const durationDays = Number((m.plan as { durationDays?: number } | null)?.durationDays ?? 60);
    const endsAt = new Date(now.getTime() + durationDays * 86400_000);

    const created: Experiment[] = [];
    const ordered = [...plan.hypotheses].sort((a, b) => a.priority - b.priority);
    for (const [i, h] of ordered.entries()) {
      const running = i < maxRunning;
      const [hyp] = await tx.insert(hypotheses).values({ brandId: brand.id, missionId: m.id, statement: h.statement, dimensions: h.dimensions, status: running ? "testing" : "untested" }).returning();
      const [exp] = await tx
        .insert(experiments)
        .values({
          brandId: brand.id,
          missionId: m.id,
          hypothesisId: hyp!.id,
          channel: h.channel,
          name: `${h.dimensions["sport"] ?? "test"} · ${h.dimensions["angle"] ?? h.channel} (${h.channel})`,
          primaryMetric: h.primaryMetric,
          targetValue: h.targetValue,
          budgetMicros: Math.round(m.budgetMicros * h.budgetShare),
          startsAt: running ? now : null,
          endsAt: running ? endsAt : null,
          status: running ? "running" : "planned",
          result: { killRule: h.killRule, scaleRule: h.scaleRule },
        })
        .returning();
      created.push(exp!);
    }
    const [mission] = await tx.update(missions).set({ status: "active", startsAt: now, endsAt, updatedAt: sql`now()` }).where(eq(missions.id, id)).returning();
    return { mission: mission!, created };
  });

  const proposals: ProposeResult[] = [];
  for (const exp of created.filter((e) => e.status === "running")) {
    const asked = await askForCampaign(db, brand, row, exp, actor);
    if (asked) proposals.push(asked);
  }
  await db.insert(auditEvents).values({ actor, verb: "mission_activated", subject: `mission:${id}`, data: { brandId: brand.id, experiments: created.length, running: created.filter((e) => e.status === "running").length, proposals: proposals.length } });
  return { mission: row, experiments: created, proposals };
}

export async function listMissions(db: Db, brandId: string): Promise<Mission[]> {
  return db.select().from(missions).where(eq(missions.brandId, brandId)).orderBy(desc(missions.createdAt));
}

export async function getMission(db: Db, brandId: string, id: string): Promise<{ mission: Mission; experiments: Experiment[] }> {
  const mission = await owned(db, brandId, id);
  const exps = await db.select().from(experiments).where(eq(experiments.missionId, id)).orderBy(experiments.createdAt);
  return { mission, experiments: exps };
}

export async function pauseMission(db: Db, brandId: string, id: string, actor: string): Promise<Mission> {
  const m = await owned(db, brandId, id);
  if (m.status !== "active") throw new MissionStateError(`mission is ${m.status}`);
  const [row] = await db.update(missions).set({ status: "paused", updatedAt: sql`now()` }).where(eq(missions.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "mission_paused", subject: `mission:${id}`, data: { brandId } });
  return row!;
}

export { planSchema, type Plan, type MissionDraft };
