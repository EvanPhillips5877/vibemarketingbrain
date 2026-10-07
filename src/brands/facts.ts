import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, brandFacts, type BrandFact } from "../db/schema.js";
import { brandFactInputSchema, factValueSchema, type FactCategory } from "../domain/brand.js";

// The person's side of the Brand Brain: accept, reject, edit, add. Every
// change is audited with who did it. Accepting a proposal that supersedes
// an active fact retires the old one in the same transaction, so there is
// never a moment with two active facts for one key.

export async function listFacts(db: Db, brandId: string): Promise<BrandFact[]> {
  return db
    .select()
    .from(brandFacts)
    .where(and(eq(brandFacts.brandId, brandId), ne(brandFacts.status, "retired")))
    .orderBy(brandFacts.category, brandFacts.key, brandFacts.status);
}

async function audit(db: Db, actor: string, verb: string, fact: { id: string; brandId: string }, data: Record<string, unknown> = {}) {
  await db.insert(auditEvents).values({ actor, verb, subject: `brand_fact:${fact.id}`, data: { brandId: fact.brandId, ...data } });
}

export async function createFact(db: Db, brandId: string, actor: string, input: unknown): Promise<BrandFact> {
  const f = brandFactInputSchema.parse(input);
  const [row] = await db
    .insert(brandFacts)
    .values({
      brandId,
      category: f.category,
      key: f.key,
      value: f.value,
      source: "manual",
      sourceUrl: f.sourceUrl ?? null,
      confidence: f.confidence ?? null,
      status: f.status,
      verifiedAt: f.status === "active" ? sql`now()` : null,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  await audit(db, actor, "fact_created", row, { category: f.category, key: f.key, status: f.status });
  return row;
}

export class FactNotFound extends Error {}

async function getOwned(db: Db, brandId: string, factId: string): Promise<BrandFact> {
  const [row] = await db.select().from(brandFacts).where(and(eq(brandFacts.id, factId), eq(brandFacts.brandId, brandId))).limit(1);
  if (!row) throw new FactNotFound("fact not found");
  return row;
}

/** Change the wording (and optional structured fields). Status is untouched; a person editing a proposal usually accepts it next. */
export async function editFact(db: Db, brandId: string, factId: string, actor: string, value: unknown): Promise<BrandFact> {
  const v = factValueSchema.parse(value);
  const before = await getOwned(db, brandId, factId);
  if (before.status === "retired") throw new Error("a retired fact cannot be edited");
  const [row] = await db.update(brandFacts).set({ value: v, source: "manual", updatedAt: sql`now()` }).where(eq(brandFacts.id, factId)).returning();
  await audit(db, actor, "fact_edited", before, { from: before.value, to: v });
  return row!;
}

/** Proposed → active. If it supersedes an active fact, that one is retired in the same transaction. */
export async function acceptFact(db: Db, brandId: string, factId: string, actor: string): Promise<BrandFact> {
  const fact = await getOwned(db, brandId, factId);
  if (fact.status === "active") return fact;
  if (fact.status === "retired") throw new Error("a retired fact cannot be accepted");
  return db.transaction(async (tx) => {
    // Whatever is active under this key now gives way (the supersedes link
    // is informative; the key is what must be unique).
    const retired = await tx
      .update(brandFacts)
      .set({ status: "retired", updatedAt: sql`now()` })
      .where(and(eq(brandFacts.brandId, brandId), eq(brandFacts.category, fact.category as FactCategory), eq(brandFacts.key, fact.key), eq(brandFacts.status, "active")))
      .returning({ id: brandFacts.id });
    const [row] = await tx
      .update(brandFacts)
      .set({ status: "active", verifiedAt: sql`now()`, updatedAt: sql`now()`, supersedesId: retired[0]?.id ?? fact.supersedesId })
      .where(eq(brandFacts.id, factId))
      .returning();
    await tx.insert(auditEvents).values({ actor, verb: "fact_accepted", subject: `brand_fact:${factId}`, data: { brandId, retired: retired.map((r) => r.id) } });
    return row!;
  });
}

/** Proposed or active → retired. */
export async function rejectFact(db: Db, brandId: string, factId: string, actor: string, reason?: string): Promise<BrandFact> {
  const fact = await getOwned(db, brandId, factId);
  if (fact.status === "retired") return fact;
  const [row] = await db.update(brandFacts).set({ status: "retired", updatedAt: sql`now()` }).where(eq(brandFacts.id, factId)).returning();
  await audit(db, actor, fact.status === "active" ? "fact_retired" : "fact_rejected", fact, { reason: reason ?? null });
  return row!;
}
