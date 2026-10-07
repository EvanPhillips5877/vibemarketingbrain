import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTryoutBrain, TRYOUTBRAIN_FACTS, TRYOUTBRAIN_POLICY_V1 } from "../src/brands/seed-tryoutbrain.js";
import { currentPolicy, getBrand, listBrands } from "../src/brands/queries.js";
import { autonomyPolicies, brandFacts, brands } from "../src/db/schema.js";
import { autonomyRulesSchema } from "../src/domain/policy.js";
import { makeContext } from "./helpers.js";

describe("TryoutBrain seed", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  // Test files share one database and run in no fixed order: start clean.
  beforeAll(async () => {
    await db.delete(brands);
  });
  afterAll(() => ctx.handle.close());

  it("creates the brand, its facts and policy v1 at level approve", async () => {
    const r = await seedTryoutBrain(db);
    expect(r.factsInserted).toBe(TRYOUTBRAIN_FACTS.length);
    expect(r.policyVersion).toBe(1);
    expect(r.policyInserted).toBe(true);
    const policy = await currentPolicy(db, r.brandId);
    expect(policy?.level).toBe("approve");
    expect(autonomyRulesSchema.parse(policy?.rules)).toEqual(TRYOUTBRAIN_POLICY_V1.rules);
  });

  it("is idempotent: a second run adds nothing, even when runs overlap", async () => {
    const r = await seedTryoutBrain(db);
    expect(r.factsInserted).toBe(0);
    expect(r.policyInserted).toBe(false);
    const [a, b] = await Promise.all([seedTryoutBrain(db), seedTryoutBrain(db)]);
    expect(a.factsInserted + b.factsInserted).toBe(0);
    expect([a.policyInserted, b.policyInserted]).toEqual([false, false]);
  });

  it("survives two overlapping first runs on an empty brand", async () => {
    await db.delete(brands);
    const [a, b] = await Promise.all([seedTryoutBrain(db), seedTryoutBrain(db)]);
    expect(a.factsInserted + b.factsInserted).toBe(TRYOUTBRAIN_FACTS.length);
    expect([a.policyInserted, b.policyInserted].filter(Boolean)).toHaveLength(1);
    expect(a.policyVersion).toBe(1);
    expect(b.policyVersion).toBe(1);
    expect(await db.select().from(autonomyPolicies)).toHaveLength(1);
    expect(await db.select().from(brands)).toHaveLength(1);
    expect(await db.select().from(autonomyPolicies)).toHaveLength(1);
    expect(await db.select().from(brandFacts)).toHaveLength(TRYOUTBRAIN_FACTS.length);
  });

  it("never overwrites a fact a person has edited", async () => {
    const detail = await getBrand(db, "tryoutbrain");
    const fact = detail!.facts.find((f) => f.key === "tone")!;
    await db.update(brandFacts).set({ value: { text: "edited by hand" }, status: "active" }).where(eq(brandFacts.id, fact.id));
    await seedTryoutBrain(db);
    const after = await getBrand(db, "tryoutbrain");
    expect(after!.facts.find((f) => f.key === "tone")?.value).toEqual({ text: "edited by hand" });
  });

  it("keeps unverified facts proposed and verified ones active with a timestamp", async () => {
    const detail = await getBrand(db, "tryoutbrain");
    const pricing = detail!.facts.find((f) => f.category === "pricing")!;
    expect(pricing.status).toBe("proposed");
    expect(pricing.verifiedAt).toBeNull();
    const product = detail!.facts.find((f) => f.key === "what_it_is")!;
    expect(product.status).toBe("active");
    expect(product.verifiedAt).not.toBeNull();
  });

  it("refuses a second live fact with the same key, active or proposed", async () => {
    const detail = await getBrand(db, "tryoutbrain");
    const attempt = db.insert(brandFacts).values({
      brandId: detail!.brand.id,
      category: "product",
      key: "what_it_is",
      value: { text: "duplicate" },
      source: "manual",
      status: "active",
    });
    // Drizzle wraps the driver error; the constraint name is on the cause.
    const err = (await attempt.then(() => null, (e: unknown) => e)) as (Error & { cause?: Error }) | null;
    expect(err).not.toBeNull();
    expect(`${err?.message} ${err?.cause?.message ?? ""}`).toMatch(/uq_brand_facts_live_key/);
    const proposedDup = db.insert(brandFacts).values({
      brandId: detail!.brand.id,
      category: "pricing",
      key: "plans",
      value: { text: "duplicate proposal" },
      source: "crawl",
      status: "proposed",
    });
    const err2 = (await proposedDup.then(() => null, (e: unknown) => e)) as (Error & { cause?: Error }) | null;
    expect(`${err2?.message} ${err2?.cause?.message ?? ""}`).toMatch(/uq_brand_facts_live_key/);
  });

  it("summarizes brands with fact counts and the policy in force", async () => {
    const list = await listBrands(db);
    expect(list).toHaveLength(1);
    const first = list[0]!;
    expect(first.policy).toMatchObject({ version: 1, level: "approve" });
    expect(first.factCounts.active + first.factCounts.proposed).toBe(TRYOUTBRAIN_FACTS.length);
  });
});
