import { z } from "zod";

// What an adapter is asked to do. These are the *executable* shapes; the
// Action Engine (Phase 11) wraps them in proposals with reason, evidence,
// policy result and approval. Money is micros in the account's currency.
// Every create carries `name`, which adapters tag with the proposal id so a
// timed-out create can be found again (never a blind retry).

const micros = z.number().int().nonnegative();
const externalId = z.string().min(1).max(128);
const name = z.string().min(1).max(200);

export const pauseAdCommand = z.object({
  type: z.literal("PAUSE_AD"),
  kind: z.enum(["campaign", "ad_group", "ad"]),
  externalId,
});

export const activateCommand = z.object({
  type: z.literal("ACTIVATE"),
  kind: z.enum(["campaign", "ad_group", "ad"]),
  externalId,
});

export const changeBudgetCommand = z.object({
  type: z.literal("CHANGE_BUDGET"),
  kind: z.enum(["campaign", "ad_group"]),
  externalId,
  dailyBudgetMicros: micros,
});

export const createCampaignCommand = z.object({
  type: z.literal("CREATE_CAMPAIGN"),
  name,
  objective: z.enum(["registrations", "paid_customers", "leads", "traffic"]),
  dailyBudgetMicros: micros,
  geos: z.array(z.string().min(2)).min(1),
  idempotencyKey: z.string().min(8).max(128),
});

export const createAdGroupCommand = z.object({
  type: z.literal("CREATE_AD_GROUP"),
  campaignExternalId: externalId,
  name,
  audience: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(8).max(128),
});

export const createAdCommand = z.object({
  type: z.literal("CREATE_AD"),
  adGroupExternalId: externalId,
  name,
  creativeVariantId: z.string().uuid(),
  landingUrl: z.string().url(),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(128),
});

export const addNegativeKeywordCommand = z.object({
  type: z.literal("ADD_NEGATIVE_KEYWORD"),
  campaignExternalId: externalId,
  keyword: z.string().min(1).max(80),
  matchType: z.enum(["exact", "phrase", "broad"]),
});

export const adapterCommandSchema = z.discriminatedUnion("type", [
  pauseAdCommand,
  activateCommand,
  changeBudgetCommand,
  createCampaignCommand,
  createAdGroupCommand,
  createAdCommand,
  addNegativeKeywordCommand,
]);
export type AdapterCommand = z.infer<typeof adapterCommandSchema>;
export type AdapterCommandType = AdapterCommand["type"];

export const CREATE_COMMAND_TYPES: ReadonlySet<AdapterCommandType> = new Set(["CREATE_CAMPAIGN", "CREATE_AD_GROUP", "CREATE_AD"]);
