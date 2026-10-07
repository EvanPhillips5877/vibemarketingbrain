import { and, eq, sql } from "drizzle-orm";
import { brandDefaultsSchema, brandFactInputSchema, CAD, type BrandFactInput } from "../domain/brand.js";
import { ACTION_TYPES, autonomyRulesSchema, type ActionMode, type AutonomyRules } from "../domain/policy.js";
import type { Db } from "../db/client.js";
import { auditEvents, autonomyPolicies, brandFacts, brands, channelAccounts, type ChannelAccount } from "../db/schema.js";

// The first brand, seeded from what the TryoutBrain repo and site say today.
// Idempotent: run it twice and nothing doubles. Facts that nobody has
// verified against the live site stay `proposed`; the review screen (Phase 9)
// is where they become `active`. Pricing is deliberately unverified here.

const SITE = "https://tryoutbrain.com";

export const TRYOUTBRAIN_DEFAULTS = brandDefaultsSchema.parse({
  geos: ["CA", "US"],
  objective: "registrations",
  dailyBudgetFloorMicros: CAD(5),
  dailyBudgetCeilingMicros: CAD(75),
  utmTemplate: "utm_source={channel}&utm_medium=paid&utm_campaign={mission}&utm_content={ad_id}&utm_term={keyword}",
  language: "en",
});

const approveAll = Object.fromEntries(ACTION_TYPES.map((t) => [t, "approve" as ActionMode])) as Record<
  (typeof ACTION_TYPES)[number],
  ActionMode
>;

// Level 2 from the brief: MarketingBrain prepares, Evan approves, it ships.
// Creating creatives (drafts in our own tables) is the one automatic act;
// publishing them is not.
export const TRYOUTBRAIN_POLICY_V1: { level: "approve"; rules: AutonomyRules } = {
  level: "approve",
  rules: autonomyRulesSchema.parse({
    currency: "CAD",
    monthlyBudgetMicros: CAD(1500),
    maxDailySpendMicros: CAD(75),
    maxAutoShiftPct: 20,
    minHoursBetweenChanges: 24,
    maxRunningExperiments: 3,
    allowedGeos: ["CA", "US"],
    actionModes: { ...approveAll, CREATE_CREATIVE: "auto" },
    monthlyAiBudgetMicros: CAD(100),
  }),
};

const active = (f: Omit<BrandFactInput, "status" | "source"> & { sourceUrl?: string }): BrandFactInput =>
  brandFactInputSchema.parse({ ...f, source: "manual", status: "active" });
const proposed = (f: Omit<BrandFactInput, "status" | "source"> & { sourceUrl?: string }): BrandFactInput =>
  brandFactInputSchema.parse({ ...f, source: "manual", status: "proposed" });

export const TRYOUTBRAIN_FACTS: BrandFactInput[] = [
  active({
    category: "product",
    key: "what_it_is",
    value: {
      text: "Tryouts, run by voice, for youth and amateur sports clubs in Canada and the US. Coaches score and talk; the app turns it into a ranked roster with receipts (the Room), and the club sends decisions to families in one pass. Clinics and camps reuse the same machinery with a progress report instead of a decision.",
    },
    sourceUrl: SITE,
  }),
  active({ category: "product", key: "website", value: { text: SITE }, sourceUrl: SITE }),
  active({
    category: "audience",
    key: "buyer",
    value: {
      text: "Club owners, head coaches, technical directors and tryout coordinators at youth and amateur sports clubs and leagues.",
      roles: ["club_owner", "head_coach", "technical_director", "tryout_coordinator"],
    },
  }),
  active({
    category: "sport",
    key: "sports_served",
    value: { text: "Hockey, ultimate, basketball, volleyball, soccer, baseball.", sports: ["hockey", "ultimate", "basketball", "volleyball", "soccer", "baseball"] },
    sourceUrl: SITE,
  }),
  active({ category: "geo", key: "markets", value: { text: "Canada and the United States.", countries: ["CA", "US"] } }),
  active({
    category: "problem",
    key: "spreadsheets_and_fairness",
    value: {
      text: "Tryouts are run on paper and spreadsheets; scores get lost, decisions look arbitrary to families, and coaches spend evenings reconciling notes instead of coaching.",
    },
  }),
  active({
    category: "differentiator",
    key: "voice_first",
    value: { text: "Coaches evaluate by talking; voice notes are attributed to the right athlete and become part of the record." },
  }),
  active({
    category: "differentiator",
    key: "the_room",
    value: { text: "The Room: a ranked roster where every placement has receipts, so a decision can be explained to a family." },
  }),
  active({
    category: "differentiator",
    key: "family_decisions",
    value: { text: "Decisions go to families in one pass, with nobody silently cut." },
  }),
  active({
    category: "prohibited_claim",
    key: "no_selection_guarantees",
    value: { text: "Never promise that TryoutBrain picks the best athletes or guarantees fair outcomes; it makes the process transparent. The AI never chooses players." },
  }),
  active({
    category: "prohibited_claim",
    key: "no_minor_targeting",
    value: { text: "Never target or depict athletes under 18 as the buyer; the buyer is the adult who runs the tryout. No claims about children's data beyond what the privacy policy states." },
  }),
  active({
    category: "prohibited_claim",
    key: "no_competitor_disparagement",
    value: { text: "Do not name competitors or claim superiority over named products." },
  }),
  active({
    category: "seasonality",
    key: "tryout_windows",
    value: { text: "Tryouts cluster in spring (soccer, baseball, ultimate) and late summer/early fall (hockey, volleyball, basketball); demand and CPA swing with the calendar." },
  }),
  proposed({
    category: "pricing",
    key: "plans",
    value: { text: "Three plans: Free, Club and League; Club and League count coach and evaluator seats. Prices to confirm from the live pricing page." },
    sourceUrl: `${SITE}/pricing`,
  }),
  proposed({
    category: "landing_page",
    key: "per_sport_pages",
    value: { text: "Per-sport landing pages exist for each sport served; confirm URLs before using them in ads." },
    sourceUrl: SITE,
  }),
  proposed({
    category: "voice",
    key: "tone",
    value: { text: "Plain, direct, coach-to-coach. No hype, no jargon. Fairness and time saved over features." },
  }),
];

export interface SeedResult {
  brandId: string;
  factsInserted: number;
  policyVersion: number;
  policyInserted: boolean;
}

export async function seedTryoutBrain(db: Db, actor = "system:seed"): Promise<SeedResult> {
  const [brand] = await db
    .insert(brands)
    .values({
      slug: "tryoutbrain",
      name: "TryoutBrain",
      website: SITE,
      defaultCurrency: "CAD",
      timezone: "America/Toronto",
      defaults: TRYOUTBRAIN_DEFAULTS,
    })
    .onConflictDoUpdate({ target: brands.slug, set: { name: "TryoutBrain", website: SITE, updatedAt: sql`now()` } })
    .returning();
  if (!brand) throw new Error("brand upsert returned no row");

  let factsInserted = 0;
  for (const f of TRYOUTBRAIN_FACTS) {
    // Atomic "insert unless a live fact with this key exists", via the
    // partial unique index: a person's edits are never overwritten, and two
    // overlapping seed runs cannot both insert.
    const inserted = await db
      .insert(brandFacts)
      .values({
        brandId: brand.id,
        category: f.category,
        key: f.key,
        value: f.value,
        source: f.source,
        sourceUrl: f.sourceUrl ?? null,
        confidence: f.confidence ?? null,
        status: f.status,
        verifiedAt: f.status === "active" ? sql`now()` : null,
      })
      .onConflictDoNothing({
        target: [brandFacts.brandId, brandFacts.category, brandFacts.key],
        where: sql`status <> 'retired'`,
      })
      .returning({ id: brandFacts.id });
    factsInserted += inserted.length;
  }

  // Version 1 is only ever written once; later versions come from a person
  // through the Action Engine's policy routes. Same atomic pattern as facts.
  const policyRows = await db
    .insert(autonomyPolicies)
    .values({
      brandId: brand.id,
      version: 1,
      level: TRYOUTBRAIN_POLICY_V1.level,
      rules: TRYOUTBRAIN_POLICY_V1.rules,
      createdBy: actor,
    })
    .onConflictDoNothing({ target: [autonomyPolicies.brandId, autonomyPolicies.version] })
    .returning({ version: autonomyPolicies.version });
  const policyInserted = policyRows.length > 0;
  const [latest] = await db
    .select({ version: autonomyPolicies.version })
    .from(autonomyPolicies)
    .where(eq(autonomyPolicies.brandId, brand.id))
    .orderBy(sql`version desc`)
    .limit(1);
  const policyVersion = latest?.version ?? 1;

  if (factsInserted > 0 || policyInserted) {
    await db.insert(auditEvents).values({
      actor,
      verb: "brand_seeded",
      subject: `brand:${brand.id}`,
      data: { slug: "tryoutbrain", factsInserted, policyInserted, policyVersion },
    });
  }
  return { brandId: brand.id, factsInserted, policyVersion, policyInserted };
}

/** A pretend ad account on the mock channel, so the loop runs end to end with no credentials. Idempotent. */
export async function seedMockChannelAccount(db: Db, brandId: string): Promise<ChannelAccount> {
  const externalAccountId = "mock-tryoutbrain";
  await db
    .insert(channelAccounts)
    .values({ brandId, channel: "mock", externalAccountId, currency: "CAD", timezone: "America/Toronto", secretRef: null })
    .onConflictDoNothing({ target: [channelAccounts.brandId, channelAccounts.channel, channelAccounts.externalAccountId] });
  const [row] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.brandId, brandId), eq(channelAccounts.channel, "mock"), eq(channelAccounts.externalAccountId, externalAccountId)))
    .limit(1);
  if (!row) throw new Error("mock channel account missing after insert");
  return row;
}
