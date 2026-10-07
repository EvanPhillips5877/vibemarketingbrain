import { z } from "zod";

export const FACT_CATEGORIES = [
  "product",
  "pricing",
  "audience",
  "problem",
  "differentiator",
  "voice",
  "visual",
  "offer",
  "testimonial",
  "competitor",
  "geo",
  "landing_page",
  "prohibited_claim",
  "sport",
  "seasonality",
  "messaging_won",
  "messaging_lost",
] as const;
export const factCategorySchema = z.enum(FACT_CATEGORIES);
export type FactCategory = z.infer<typeof factCategorySchema>;

export const factSourceSchema = z.enum(["crawl", "manual", "ai_inferred", "learning"]);
export type FactSource = z.infer<typeof factSourceSchema>;

export const factStatusSchema = z.enum(["proposed", "active", "retired"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

// Every fact value carries a human-readable `text`; categories may add
// structured fields beside it. Keeping `text` mandatory means the Brand
// Brief can always be rendered without per-category code.
export const factValueSchema = z
  .object({ text: z.string().min(1).max(2000) })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export type FactValue = z.infer<typeof factValueSchema>;

export const brandFactInputSchema = z.object({
  category: factCategorySchema,
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_.-]+$/, "key must be lower-case slug characters"),
  value: factValueSchema,
  source: factSourceSchema,
  sourceUrl: z.string().url().optional(),
  confidence: z.number().min(0).max(1).optional(),
  status: factStatusSchema.default("proposed"),
});
export type BrandFactInput = z.infer<typeof brandFactInputSchema>;

export const brandDefaultsSchema = z
  .object({
    geos: z.array(z.string().min(2)).min(1), // ISO country codes, optionally "CA-ON"
    objective: z.enum(["registrations", "paid_customers", "leads", "traffic"]),
    dailyBudgetFloorMicros: z.number().int().nonnegative(),
    dailyBudgetCeilingMicros: z.number().int().nonnegative(),
    // Appended to every landing URL an adapter writes; platform macros fill
    // the braces ({{ad.id}} on Meta, {creative}/{keyword} on Google).
    utmTemplate: z.string().min(1),
    language: z.string().min(2).default("en"),
  })
  .strict()
  .refine((d) => d.dailyBudgetCeilingMicros >= d.dailyBudgetFloorMicros, {
    message: "dailyBudgetCeilingMicros must be ≥ dailyBudgetFloorMicros",
    path: ["dailyBudgetCeilingMicros"],
  });
export type BrandDefaults = z.infer<typeof brandDefaultsSchema>;

export const CAD = (dollars: number): number => Math.round(dollars * 1_000_000);
