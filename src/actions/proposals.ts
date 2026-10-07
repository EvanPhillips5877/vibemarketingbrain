import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { localDay } from "../analytics/format.js";
import { currentPolicy } from "../brands/queries.js";
import type { Db } from "../db/client.js";
import { actionProposals, auditEvents, brands, type ActionProposal, type ProposalStatus } from "../db/schema.js";
import { canonicalPayload, proposalPayloadSchema, proposalSourceSchema, type ProposalPayload } from "../domain/proposals.js";
import { ledgerSnapshot } from "./ledger.js";
import { evaluatePolicy } from "./policy.js";

// A proposal is the only thing a detector, the model, the command bar or a
// person can create. It is evaluated against the brand's policy the moment
// it is made, and the same ask twice on the same day is one row.

export const APPROVAL_TTL_MS = 72 * 3600_000;
/** Terminal states that do not count as "already asked". */
const RETRYABLE: ProposalStatus[] = ["expired", "failed", "rejected"];

export interface ProposeInput {
  brandId: string;
  payload: unknown;
  reason: string;
  source: string; // detector:<name> | ai:<run_id> | command:<id> | manual:<email>
  evidence?: Record<string, unknown>;
  expectedOutcome?: string;
  confidence?: number;
  missionId?: string | null;
  experimentId?: string | null;
  groupId?: string | null;
  /** An undo of an executed action: exempt from the cooldown, nothing else. */
  rollback?: boolean;
}

export interface ProposeResult {
  proposal: ActionProposal;
  duplicate: boolean;
}

export function idempotencyKey(brandId: string, payload: ProposalPayload, day: string): string {
  return createHash("sha256").update(`${brandId}|${payload.type}|${canonicalPayload(payload)}|${day}`).digest("hex").slice(0, 48);
}

export async function propose(db: Db, input: ProposeInput, now = new Date()): Promise<ProposeResult> {
  const payload = proposalPayloadSchema.parse(input.payload);
  const source = proposalSourceSchema.parse(input.source);
  const [brand] = await db.select().from(brands).where(eq(brands.id, input.brandId));
  if (!brand) throw new Error("brand not found");
  // The same ask on the same day is one row while that row is open or done.
  // A proposal that expired, failed or was rejected does not stand in the
  // way of asking again: the new one gets the next sequence number.
  const base = idempotencyKey(input.brandId, payload, localDay(now, brand.timezone));
  const prior = await db.select({ id: actionProposals.id, status: actionProposals.status, key: actionProposals.idempotencyKey }).from(actionProposals).where(sql`${actionProposals.idempotencyKey} like ${`${base}%`}`);
  const live = prior.find((p) => !RETRYABLE.includes(p.status));
  if (live) {
    const [existing] = await db.select().from(actionProposals).where(eq(actionProposals.id, live.id));
    return { proposal: existing!, duplicate: true };
  }
  const key = prior.length === 0 ? base : `${base}#${prior.length}`;

  const policy = await currentPolicy(db, input.brandId);
  const ledger = await ledgerSnapshot(db, input.brandId, payload, now);
  // No policy means nothing may execute: everything is blocked until one exists.
  const result = policy
    ? evaluatePolicy({ payload, level: policy.level, rules: policy.rules, ledger, ...(input.rollback ? { rollback: true } : {}) })
    : { allowed: false, needsApproval: false, mode: "never" as const, violations: [{ rule: "no_policy", detail: "the brand has no autonomy policy", effect: "block" as const }] };
  const status: ProposalStatus = !result.allowed ? "blocked" : result.needsApproval ? "awaiting_approval" : "approved";

  const inserted = await db
    .insert(actionProposals)
    .values({
      brandId: input.brandId,
      missionId: input.missionId ?? null,
      experimentId: input.experimentId ?? null,
      groupId: input.groupId ?? null,
      type: payload.type,
      payload,
      reason: input.reason,
      evidence: input.evidence ?? {},
      expectedOutcome: input.expectedOutcome ?? null,
      confidence: input.confidence ?? null,
      source,
      policyVersion: policy?.version ?? null,
      policyResult: result as unknown as Record<string, unknown>,
      status,
      idempotencyKey: key,
      approvedBy: status === "approved" ? "system:autopilot" : null,
      approvedAt: status === "approved" ? now : null,
      expiresAt: status === "awaiting_approval" ? new Date(now.getTime() + APPROVAL_TTL_MS) : null,
    })
    .onConflictDoNothing({ target: actionProposals.idempotencyKey })
    .returning();

  if (inserted[0]) {
    await db.insert(auditEvents).values({ actor: source, verb: "proposal_created", subject: `proposal:${inserted[0].id}`, data: { brandId: input.brandId, type: payload.type, status, violations: result.violations } });
    return { proposal: inserted[0], duplicate: false };
  }
  const [existing] = await db.select().from(actionProposals).where(eq(actionProposals.idempotencyKey, key));
  return { proposal: existing!, duplicate: true };
}

export class ProposalNotFound extends Error {}
export class ProposalStateError extends Error {}

async function owned(db: Db, brandId: string, id: string): Promise<ActionProposal> {
  const [row] = await db.select().from(actionProposals).where(and(eq(actionProposals.id, id), eq(actionProposals.brandId, brandId))).limit(1);
  if (!row) throw new ProposalNotFound("proposal not found");
  return row;
}

/** A person says yes. Only from awaiting_approval, and only before it expires. */
export async function approve(db: Db, brandId: string, id: string, actor: string, now = new Date()): Promise<ActionProposal> {
  const p = await owned(db, brandId, id);
  if (p.status !== "awaiting_approval") throw new ProposalStateError(`cannot approve a proposal that is ${p.status}`);
  if (p.expiresAt && p.expiresAt.getTime() < now.getTime()) {
    await db.update(actionProposals).set({ status: "expired", updatedAt: sql`now()` }).where(eq(actionProposals.id, id));
    throw new ProposalStateError("this proposal expired; ask for a fresh one");
  }
  const [row] = await db.update(actionProposals).set({ status: "approved", approvedBy: actor, approvedAt: now, updatedAt: sql`now()` }).where(and(eq(actionProposals.id, id), eq(actionProposals.status, "awaiting_approval"))).returning();
  if (!row) throw new ProposalStateError("proposal changed underneath you");
  await db.insert(auditEvents).values({ actor, verb: "proposal_approved", subject: `proposal:${id}`, data: { brandId, type: p.type } });
  return row;
}

export async function reject(db: Db, brandId: string, id: string, actor: string, reason?: string): Promise<ActionProposal> {
  const p = await owned(db, brandId, id);
  if (!["awaiting_approval", "approved", "blocked", "proposed"].includes(p.status)) throw new ProposalStateError(`cannot reject a proposal that is ${p.status}`);
  const [row] = await db.update(actionProposals).set({ status: "rejected", updatedAt: sql`now()` }).where(eq(actionProposals.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "proposal_rejected", subject: `proposal:${id}`, data: { brandId, type: p.type, reason: reason ?? null } });
  return row!;
}

/** Sweep awaiting proposals past their TTL. */
export async function expireStale(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(actionProposals)
    .set({ status: "expired", updatedAt: sql`now()` })
    .where(and(eq(actionProposals.status, "awaiting_approval"), sql`${actionProposals.expiresAt} < ${now}`))
    .returning({ id: actionProposals.id });
  return rows.length;
}

export async function listProposals(db: Db, brandId: string, statuses: ProposalStatus[], limit = 100): Promise<ActionProposal[]> {
  return db
    .select()
    .from(actionProposals)
    .where(and(eq(actionProposals.brandId, brandId), inArray(actionProposals.status, statuses)))
    .orderBy(desc(actionProposals.createdAt))
    .limit(limit);
}
