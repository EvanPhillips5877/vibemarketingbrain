import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { autonomyPolicies, brandFacts, brands, type AutonomyPolicy, type Brand, type BrandFact } from "../db/schema.js";

export interface BrandSummary {
  brand: Brand;
  policy: Pick<AutonomyPolicy, "version" | "level" | "createdAt"> | null;
  factCounts: { active: number; proposed: number };
}

/** The newest policy row is the one in force. */
export async function currentPolicy(db: Db, brandId: string): Promise<AutonomyPolicy | null> {
  const rows = await db
    .select()
    .from(autonomyPolicies)
    .where(eq(autonomyPolicies.brandId, brandId))
    .orderBy(desc(autonomyPolicies.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listBrands(db: Db): Promise<BrandSummary[]> {
  const all = await db.select().from(brands).orderBy(brands.name);
  if (all.length === 0) return [];
  const ids = all.map((b) => b.id);
  const facts = await db
    .select({ brandId: brandFacts.brandId, status: brandFacts.status })
    .from(brandFacts)
    .where(and(inArray(brandFacts.brandId, ids), inArray(brandFacts.status, ["active", "proposed"])));
  const out: BrandSummary[] = [];
  for (const brand of all) {
    const policy = await currentPolicy(db, brand.id);
    const mine = facts.filter((f) => f.brandId === brand.id);
    out.push({
      brand,
      policy: policy ? { version: policy.version, level: policy.level, createdAt: policy.createdAt } : null,
      factCounts: {
        active: mine.filter((f) => f.status === "active").length,
        proposed: mine.filter((f) => f.status === "proposed").length,
      },
    });
  }
  return out;
}

export interface BrandDetail {
  brand: Brand;
  policy: AutonomyPolicy | null;
  facts: BrandFact[];
}

export async function getBrand(db: Db, slug: string): Promise<BrandDetail | null> {
  const [brand] = await db.select().from(brands).where(eq(brands.slug, slug)).limit(1);
  if (!brand) return null;
  const [policy, facts] = await Promise.all([
    currentPolicy(db, brand.id),
    db
      .select()
      .from(brandFacts)
      .where(and(eq(brandFacts.brandId, brand.id), inArray(brandFacts.status, ["active", "proposed"])))
      .orderBy(brandFacts.category, brandFacts.key),
  ]);
  return { brand, policy, facts };
}
