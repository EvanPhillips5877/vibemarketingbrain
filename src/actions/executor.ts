import { and, desc, eq, sql } from "drizzle-orm";
import type { AccountRef, ChannelAdapter, ExecResult } from "../channels/adapter.js";
import { redact } from "../channels/adapter.js";
import type { AdapterRegistry } from "../channels/registry.js";
import type { Db } from "../db/client.js";
import { actionExecutions, actionProposals, auditEvents, channelAccounts, extObjects, type ActionProposal } from "../db/schema.js";
import type { AdapterCommand } from "../domain/actions.js";
import { type Assumptions, type ProposalPayload } from "../domain/proposals.js";
import { accountRef } from "../ingest/structure.js";
import { propose, type ProposeResult } from "./proposals.js";

// The only code that calls an advertising API with intent to change
// something. It takes approved proposals one at a time under a row lock,
// records the attempt before the call, checks the platform still looks the
// way the proposal assumed, and never retries blindly: a call whose
// outcome is unknown stays unknown until the reconciler reads the platform.

export class StaleStateError extends Error {}

function isTransportError(err: unknown): boolean {
  const m = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket hang up|fetch failed/i.test(m);
}

/** Compare what the proposal assumed with what the platform says now. */
export function assumptionsHold(assumed: Assumptions, live: { status: string; dailyBudgetMicros: number | null }): string | null {
  if (assumed.status !== undefined && assumed.status !== live.status) return `status is ${live.status}, proposal assumed ${assumed.status}`;
  if (assumed.dailyBudgetMicros !== undefined && assumed.dailyBudgetMicros !== live.dailyBudgetMicros) return `daily budget is ${live.dailyBudgetMicros}, proposal assumed ${assumed.dailyBudgetMicros}`;
  return null;
}

/** The adapter commands a proposal expands to, in order. */
export function toCommands(p: ProposalPayload, tag: string): { command: AdapterCommand; assumptions?: Assumptions; extObjectId?: string }[] {
  switch (p.type) {
    case "PAUSE_AD":
    case "ACTIVATE":
      return [{ command: { type: p.type, kind: p.kind, externalId: p.externalId }, assumptions: p.assumptions, extObjectId: p.extObjectId }];
    case "CHANGE_BUDGET":
      return [{ command: { type: "CHANGE_BUDGET", kind: p.kind, externalId: p.externalId, dailyBudgetMicros: p.dailyBudgetMicros }, assumptions: p.assumptions, extObjectId: p.extObjectId }];
    case "CREATE_CAMPAIGN":
      return [{ command: { type: "CREATE_CAMPAIGN", name: `${p.name} [mb:${tag}]`, objective: p.objective, dailyBudgetMicros: p.dailyBudgetMicros, geos: p.geos, idempotencyKey: p.idempotencyKey } }];
    case "CREATE_AD_GROUP":
      return [{ command: { type: "CREATE_AD_GROUP", campaignExternalId: p.campaignExternalId, name: `${p.name} [mb:${tag}]`, audience: p.audience, idempotencyKey: p.idempotencyKey } }];
    case "CREATE_AD":
      return [{ command: { type: "CREATE_AD", adGroupExternalId: p.adGroupExternalId, name: `${p.name} [mb:${tag}]`, creativeVariantId: p.creativeVariantId, landingUrl: p.landingUrl, payload: p.payload, idempotencyKey: p.idempotencyKey } }];
    case "ADD_NEGATIVE_KEYWORD":
      return [{ command: { type: "ADD_NEGATIVE_KEYWORD", campaignExternalId: p.campaignExternalId, keyword: p.keyword, matchType: p.matchType } }];
    case "ROTATE_AD":
      return [
        { command: { type: "PAUSE_AD", kind: "ad", externalId: p.pause.externalId }, assumptions: p.pause.assumptions, extObjectId: p.pause.extObjectId },
        { command: { type: "ACTIVATE", kind: "ad", externalId: p.activate.externalId }, assumptions: p.activate.assumptions, extObjectId: p.activate.extObjectId },
      ];
    case "REALLOCATE_BUDGET":
      return [
        { command: { type: "CHANGE_BUDGET", kind: p.kind, externalId: p.from.externalId, dailyBudgetMicros: p.from.dailyBudgetMicros }, assumptions: p.from.assumptions, extObjectId: p.from.extObjectId },
        { command: { type: "CHANGE_BUDGET", kind: p.kind, externalId: p.to.externalId, dailyBudgetMicros: p.to.dailyBudgetMicros }, assumptions: p.to.assumptions, extObjectId: p.to.extObjectId },
      ];
  }
}

async function accountFor(db: Db, p: ProposalPayload): Promise<AccountRef> {
  const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, p.channelAccountId));
  if (!row) throw new Error("channel account not found");
  return accountRef(row);
}

/** Refresh the mirror for an object the executor just changed, so the next proposal sees the truth. */
async function mirror(db: Db, account: AccountRef, adapter: ChannelAdapter, kind: "campaign" | "ad_group" | "ad", externalId: string): Promise<void> {
  const live = await adapter.fetchObject(account, kind, externalId);
  if (!live) return;
  await db
    .update(extObjects)
    .set({ status: live.status, dailyBudgetMicros: live.dailyBudgetMicros, settings: live.settings, raw: live.raw, syncedAt: sql`now()` })
    .where(and(eq(extObjects.channelAccountId, account.id), eq(extObjects.kind, kind), eq(extObjects.externalId, externalId)));
}

export interface ExecutionReport {
  proposalId: string;
  outcome: "executed" | "failed" | "unknown" | "expired";
  detail?: string;
}

/** Execute exactly one approved proposal, if any is waiting. Returns null when the queue is empty. */
export async function executeNext(db: Db, registry: AdapterRegistry, brandId?: string): Promise<ExecutionReport | null> {
  // Claim one row. SKIP LOCKED keeps two workers from taking the same one;
  // the status change makes a crash leave it visibly "executing", never
  // silently re-runnable.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      select id from ${actionProposals}
      where status = 'approved' ${brandId ? sql`and brand_id = ${brandId}` : sql``}
      order by approved_at asc nulls last, created_at asc
      limit 1 for update skip locked`);
    const id = (rows.rows[0] as { id: string } | undefined)?.id;
    if (!id) return null;
    const [p] = await tx.update(actionProposals).set({ status: "executing", updatedAt: sql`now()` }).where(eq(actionProposals.id, id)).returning();
    return p ?? null;
  });
  if (!claimed) return null;
  return executeClaimed(db, registry, claimed);
}

async function executeClaimed(db: Db, registry: AdapterRegistry, p: ActionProposal): Promise<ExecutionReport> {
  const finish = async (outcome: ExecutionReport["outcome"], detail?: string) => {
    await db.update(actionProposals).set({ status: outcome, updatedAt: sql`now()` }).where(eq(actionProposals.id, p.id));
    await db.insert(auditEvents).values({ actor: "system:executor", verb: `proposal_${outcome}`, subject: `proposal:${p.id}`, data: { brandId: p.brandId, type: p.type, detail: detail ?? null } });
    return { proposalId: p.id, outcome, detail } as ExecutionReport;
  };
  try {
    return await executeSteps(db, registry, p, finish);
  } catch (err) {
    // Anything that breaks before or around the adapter call must still
    // settle the row: a proposal is never left "executing" by an exception.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[executor] proposal ${p.id}: ${message}`);
    return finish(isTransportError(err) ? "unknown" : "failed", message);
  }
}

async function executeSteps(db: Db, registry: AdapterRegistry, p: ActionProposal, finish: (outcome: ExecutionReport["outcome"], detail?: string) => Promise<ExecutionReport>): Promise<ExecutionReport> {
  const payload = p.payload as ProposalPayload;

  const adapter = registry.get((await db.select().from(channelAccounts).where(eq(channelAccounts.id, payload.channelAccountId)))[0]?.channel ?? "mock");
  if (!adapter) return finish("failed", "no adapter for this channel");
  const account = await accountFor(db, payload);
  const [prior] = await db.select({ n: sql<number>`count(*)::int` }).from(actionExecutions).where(eq(actionExecutions.proposalId, p.id));
  const attempt = Number(prior?.n ?? 0) + 1;
  const steps = toCommands(payload, p.id.slice(0, 8));

  // Freshness: every touched object must still look like the proposal assumed.
  for (const s of steps) {
    if (!s.assumptions || !("externalId" in s.command)) continue;
    const kind = (s.command as { kind: "campaign" | "ad_group" | "ad" }).kind;
    const live = await adapter.fetchObject(account, kind, (s.command as { externalId: string }).externalId);
    if (!live) return finish("expired", `${kind} ${(s.command as { externalId: string }).externalId} no longer exists`);
    const why = assumptionsHold(s.assumptions, live);
    if (why) return finish("expired", why);
  }
  for (const s of steps) {
    const v = await adapter.validate(account, s.command);
    if (!v.ok) return finish("failed", `rejected before execution: ${v.errors.join("; ")}`);
  }

  // The attempt is on record before anything is sent.
  const [exec] = await db
    .insert(actionExecutions)
    .values({ proposalId: p.id, attempt, adapter: adapter.channel, request: { steps: steps.map((s) => s.command) } as unknown as Record<string, unknown> })
    .returning();

  const results: ExecResult[] = [];
  try {
    for (const s of steps) results.push(await adapter.execute(account, s.command));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = isTransportError(err) ? "unknown" : "failed";
    // Steps that did land keep their inverses, so a half-done composite can still be undone.
    const partial = results.map((r) => r.rollback).reverse().filter(Boolean);
    await db
      .update(actionExecutions)
      .set({ outcome, response: redact({ error: message, completedSteps: results.length }), rollback: partial.length ? (partial as unknown as Record<string, unknown>) : null, finishedAt: sql`now()` })
      .where(eq(actionExecutions.id, exec!.id));
    for (const s of steps.slice(0, results.length)) {
      if ("externalId" in s.command && "kind" in s.command) await mirror(db, account, adapter, (s.command as { kind: "campaign" | "ad_group" | "ad" }).kind, (s.command as { externalId: string }).externalId);
    }
    return finish(outcome, message);
  }

  const externalIds = Object.assign({}, ...results.map((r) => r.externalIds)) as Record<string, string>;
  // A composite's rollback is the inverse of each step in reverse order.
  const rollback = results.length === 1 ? results[0]!.rollback : results.map((r) => r.rollback).reverse().filter(Boolean);
  await db
    .update(actionExecutions)
    .set({ outcome: "executed", response: redact({ steps: results.map((r) => r.response) }), externalIds, rollback: (rollback ?? null) as Record<string, unknown> | null, finishedAt: sql`now()` })
    .where(eq(actionExecutions.id, exec!.id));
  for (const s of steps) {
    if ("externalId" in s.command && "kind" in s.command) await mirror(db, account, adapter, (s.command as { kind: "campaign" | "ad_group" | "ad" }).kind, (s.command as { externalId: string }).externalId);
  }
  return finish("executed");
}

/** Drain the approved queue. */
export async function executeApproved(db: Db, registry: AdapterRegistry, brandId?: string, max = 50): Promise<ExecutionReport[]> {
  const out: ExecutionReport[] = [];
  for (let i = 0; i < max; i++) {
    const r = await executeNext(db, registry, brandId);
    if (!r) break;
    out.push(r);
  }
  return out;
}

/**
 * For every proposal whose last execution ended `unknown`: ask the platform
 * whether it landed. Creates are found by idempotency key; changes by
 * comparing the object's live state with what was requested.
 */
export async function reconcileUnknown(db: Db, registry: AdapterRegistry, brandId?: string): Promise<ExecutionReport[]> {
  const pending = await db
    .select()
    .from(actionProposals)
    .where(and(eq(actionProposals.status, "unknown"), ...(brandId ? [eq(actionProposals.brandId, brandId)] : [])));
  const out: ExecutionReport[] = [];
  for (const p of pending) {
    const payload = p.payload as ProposalPayload;
    const [acct] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, payload.channelAccountId));
    const adapter = acct ? registry.get(acct.channel) : null;
    if (!acct || !adapter) continue;
    const account = accountRef(acct);
    const [exec] = await db.select().from(actionExecutions).where(eq(actionExecutions.proposalId, p.id)).orderBy(desc(actionExecutions.attempt)).limit(1);
    const steps = toCommands(payload, p.id.slice(0, 8));
    let landed = true;
    const externalIds: Record<string, string> = {};
    for (const s of steps) {
      const c = s.command;
      if (c.type === "CREATE_CAMPAIGN" || c.type === "CREATE_AD_GROUP" || c.type === "CREATE_AD") {
        const kind = c.type === "CREATE_CAMPAIGN" ? "campaign" : c.type === "CREATE_AD_GROUP" ? "ad_group" : "ad";
        const found = await adapter.findByIdempotencyKey(account, kind, c.idempotencyKey);
        if (!found) landed = false;
        else externalIds[kind] = found.externalId;
      } else if ("externalId" in c) {
        const live = await adapter.fetchObject(account, c.kind as "campaign" | "ad_group" | "ad", c.externalId);
        const want = c.type === "PAUSE_AD" ? live?.status === "PAUSED" : c.type === "ACTIVATE" ? live?.status === "ACTIVE" : c.type === "CHANGE_BUDGET" ? live?.dailyBudgetMicros === c.dailyBudgetMicros : true;
        if (!want) landed = false;
      }
    }
    const outcome = landed ? "executed" : "failed";
    if (exec) await db.update(actionExecutions).set({ outcome, externalIds: landed ? externalIds : null, finishedAt: sql`now()` }).where(eq(actionExecutions.id, exec.id));
    await db.update(actionProposals).set({ status: outcome, updatedAt: sql`now()` }).where(eq(actionProposals.id, p.id));
    await db.insert(auditEvents).values({ actor: "system:reconciler", verb: `proposal_${outcome}`, subject: `proposal:${p.id}`, data: { brandId: p.brandId, type: p.type, reconciled: true } });
    out.push({ proposalId: p.id, outcome, detail: landed ? "found on the platform" : "not found on the platform; may be retried as a new proposal" });
  }
  return out;
}

/** Undo: a new proposal built from the stored inverse, through the policy like any other. */
export async function proposeRollback(db: Db, registry: AdapterRegistry, brandId: string, proposalId: string, actor: string): Promise<ProposeResult> {
  void registry;
  const [p] = await db.select().from(actionProposals).where(and(eq(actionProposals.id, proposalId), eq(actionProposals.brandId, brandId)));
  if (!p) throw new Error("proposal not found");
  if (p.status !== "executed" && p.status !== "failed") throw new Error(`only an executed (or partly executed) proposal can be rolled back (this one is ${p.status})`);
  const [exec] = await db.select().from(actionExecutions).where(eq(actionExecutions.proposalId, p.id)).orderBy(desc(actionExecutions.attempt)).limit(1);
  const inverse = exec?.rollback as AdapterCommand | AdapterCommand[] | null | undefined;
  if (!inverse || (Array.isArray(inverse) && inverse.length === 0)) throw new Error("no rollback is known for this action");
  const payload = p.payload as ProposalPayload;
  const one = Array.isArray(inverse) ? inverse : [inverse];
  // V1 rolls back single-step changes; a composite's inverse is proposed step by step.
  let last: ProposeResult | null = null;
  for (const cmd of one) {
    if (!("externalId" in cmd)) throw new Error(`cannot roll back ${cmd.type}`);
    const [obj] = await db.select({ id: extObjects.id }).from(extObjects).where(and(eq(extObjects.channelAccountId, payload.channelAccountId), eq(extObjects.externalId, cmd.externalId)));
    if (!obj) throw new Error("object to roll back is not mirrored");
    last = await propose(db, { brandId, payload: { ...cmd, channelAccountId: payload.channelAccountId, extObjectId: obj.id, assumptions: {} }, reason: `Rollback of proposal ${p.id.slice(0, 8)}`, source: actor, evidence: { rollbackOf: p.id }, rollback: true });
  }
  return last!;
}
