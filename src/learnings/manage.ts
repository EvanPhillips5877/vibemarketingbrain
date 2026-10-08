import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { auditEvents, learnings, type Learning } from "../db/schema.js";

// A person's hand on the learnings: add an observation or hypothesis, fix
// a statement, retire one that no longer holds. `validated` and `refuted`
// can only be written by a closed experiment, so manual kinds stop short.

export class LearningNotFound extends Error {}

const dimensions = z.record(z.string().min(1).max(40), z.string().min(1).max(80)).default({});

export const createLearningSchema = z.object({
  statement: z.string().trim().min(5).max(600),
  kind: z.enum(["observation", "hypothesis"]),
  scope: z.enum(["audience", "creative", "channel", "geo", "funnel"]),
  dimensions,
  confidence: z.number().min(0).max(1).nullable().default(null),
});

export const editLearningSchema = z
  .object({
    statement: z.string().trim().min(5).max(600).optional(),
    dimensions: dimensions.optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict();

export async function listLearnings(db: Db, brandId: string, opts: { includeRetired?: boolean } = {}): Promise<Learning[]> {
  const scope = sql`(${learnings.brandId} = ${brandId} or ${learnings.brandId} is null)`;
  return db
    .select()
    .from(learnings)
    .where(opts.includeRetired ? scope : and(scope, eq(learnings.status, "active")))
    .orderBy(desc(learnings.createdAt));
}

export async function createLearning(db: Db, brandId: string, actor: string, input: unknown): Promise<Learning> {
  const v = createLearningSchema.parse(input);
  const [row] = await db.insert(learnings).values({ brandId, statement: v.statement, kind: v.kind, scope: v.scope, dimensions: v.dimensions, evidence: { source: "manual" }, confidence: v.confidence, createdBy: actor }).returning();
  await db.insert(auditEvents).values({ actor, verb: "learning_created", subject: `learning:${row!.id}`, data: { brandId, kind: v.kind, scope: v.scope } });
  return row!;
}

async function owned(db: Db, brandId: string, id: string): Promise<Learning> {
  const [l] = await db.select().from(learnings).where(and(eq(learnings.id, id), eq(learnings.brandId, brandId)));
  if (!l) throw new LearningNotFound("learning not found");
  return l;
}

/** The statement or dimensions change; the evidence does not, and the edit is recorded on the row. */
export async function editLearning(db: Db, brandId: string, id: string, actor: string, input: unknown): Promise<Learning> {
  const l = await owned(db, brandId, id);
  const e = editLearningSchema.parse(input);
  const edits = ((l.evidence as { edits?: unknown[] }).edits ?? []) as unknown[];
  const [row] = await db
    .update(learnings)
    .set({
      ...(e.statement !== undefined ? { statement: e.statement } : {}),
      ...(e.dimensions !== undefined ? { dimensions: e.dimensions } : {}),
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
      evidence: { ...l.evidence, edits: [...edits, { by: actor, at: new Date().toISOString(), fields: Object.keys(e), was: { statement: l.statement, dimensions: l.dimensions, confidence: l.confidence } }] },
    })
    .where(eq(learnings.id, id))
    .returning();
  await db.insert(auditEvents).values({ actor, verb: "learning_edited", subject: `learning:${id}`, data: { brandId, fields: Object.keys(e) } });
  return row!;
}

export async function retireLearning(db: Db, brandId: string, id: string, actor: string, reason?: string): Promise<Learning> {
  await owned(db, brandId, id);
  const [row] = await db.update(learnings).set({ status: "retired" }).where(eq(learnings.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "learning_retired", subject: `learning:${id}`, data: { brandId, reason: reason ?? null } });
  return row!;
}

export async function restoreLearning(db: Db, brandId: string, id: string, actor: string): Promise<Learning> {
  await owned(db, brandId, id);
  const [row] = await db.update(learnings).set({ status: "active" }).where(eq(learnings.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "learning_restored", subject: `learning:${id}`, data: { brandId } });
  return row!;
}
