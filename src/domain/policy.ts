import { z } from "zod";

// The vocabulary of the Action Engine. Payload schemas per type arrive with
// the engine itself (Phase 11); the list exists now so policies can name them.
export const ACTION_TYPES = [
  "PAUSE_AD",
  "ACTIVATE",
  "CREATE_CAMPAIGN",
  "CREATE_AD_GROUP",
  "CREATE_AD",
  "UPLOAD_CREATIVE",
  "CHANGE_BUDGET",
  "REALLOCATE_BUDGET",
  "ROTATE_AD",
  "ADD_NEGATIVE_KEYWORD",
  "CREATE_CREATIVE",
  "START_EXPERIMENT",
] as const;
export const actionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof actionTypeSchema>;

export const autonomyLevelSchema = z.enum(["suggest", "approve", "autopilot"]);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

// never: the type is not allowed at all; approve: needs a person;
// auto: may execute without one, but only when the brand level is autopilot.
export const actionModeSchema = z.enum(["never", "approve", "auto"]);
export type ActionMode = z.infer<typeof actionModeSchema>;

const nonNegativeMicros = z.number().int().nonnegative();

export const autonomyRulesSchema = z
  .object({
    currency: z.string().length(3),
    monthlyBudgetMicros: nonNegativeMicros,
    maxDailySpendMicros: nonNegativeMicros,
    // Largest budget move the engine may make on its own, as % of the
    // object's current budget, per rolling 7 days.
    maxAutoShiftPct: z.number().min(0).max(100),
    // No second MarketingBrain change to the same object inside this window.
    minHoursBetweenChanges: z.number().min(0).max(24 * 30),
    maxRunningExperiments: z.number().int().min(1).max(10),
    allowedGeos: z.array(z.string().min(2)).min(1),
    actionModes: z.record(actionTypeSchema, actionModeSchema),
    monthlyAiBudgetMicros: nonNegativeMicros,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.maxDailySpendMicros * 28 > r.monthlyBudgetMicros * 1.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxDailySpendMicros × 28 days must not exceed 1.5× the monthly budget",
        path: ["maxDailySpendMicros"],
      });
    }
    for (const t of ACTION_TYPES) {
      if (r.actionModes[t] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `actionModes.${t} is required`, path: ["actionModes", t] });
      }
    }
  });
export type AutonomyRules = z.infer<typeof autonomyRulesSchema>;

export interface PolicyInput {
  level: AutonomyLevel;
  rules: AutonomyRules;
}

/** Effective mode for one action type under a brand's level. Pure. */
export function effectiveMode(level: AutonomyLevel, rules: AutonomyRules, type: ActionType): ActionMode {
  const configured = rules.actionModes[type] ?? "never";
  if (configured === "never") return "never";
  if (level === "suggest") return "never"; // suggest: nothing executes, ever
  if (level === "approve") return "approve";
  return configured; // autopilot honours the per-type setting
}
