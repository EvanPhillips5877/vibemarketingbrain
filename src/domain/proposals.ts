import { z } from "zod";
import { activateCommand, addNegativeKeywordCommand, changeBudgetCommand, createAdCommand, createAdGroupCommand, createCampaignCommand, pauseAdCommand } from "./actions.js";

// What a proposal asks for. Every payload names the channel account it
// acts on and, where it touches an existing object, the state it assumed
// at proposal time: the executor refuses to act if the platform no longer
// looks like that (a stale proposal is expired, never executed blind).

const account = { channelAccountId: z.string().uuid() };
const target = { ...account, extObjectId: z.string().uuid() };

export const assumptionsSchema = z
  .object({
    status: z.string().optional(),
    dailyBudgetMicros: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type Assumptions = z.infer<typeof assumptionsSchema>;

export const pauseAdProposal = pauseAdCommand.extend({ ...target, assumptions: assumptionsSchema.default({}) });
export const activateProposal = activateCommand.extend({ ...target, assumptions: assumptionsSchema.default({}) });
export const changeBudgetProposal = changeBudgetCommand.extend({ ...target, assumptions: assumptionsSchema.default({}) });
export const createCampaignProposal = createCampaignCommand.extend({ ...account });
export const createAdGroupProposal = createAdGroupCommand.extend({ ...account });
export const createAdProposal = createAdCommand.extend({ ...account });
export const addNegativeKeywordProposal = addNegativeKeywordCommand.extend({ ...account });

// Composite: pause one ad and activate a waiting one, as one decision.
export const rotateAdProposal = z.object({
  type: z.literal("ROTATE_AD"),
  ...account,
  pause: z.object({ extObjectId: z.string().uuid(), externalId: z.string().min(1), assumptions: assumptionsSchema.default({}) }),
  activate: z.object({ extObjectId: z.string().uuid(), externalId: z.string().min(1), assumptions: assumptionsSchema.default({}) }),
});

// Composite: move daily budget from one campaign to another.
export const reallocateBudgetProposal = z.object({
  type: z.literal("REALLOCATE_BUDGET"),
  ...account,
  kind: z.enum(["campaign", "ad_group"]),
  from: z.object({ extObjectId: z.string().uuid(), externalId: z.string().min(1), dailyBudgetMicros: z.number().int().nonnegative(), assumptions: assumptionsSchema.default({}) }),
  to: z.object({ extObjectId: z.string().uuid(), externalId: z.string().min(1), dailyBudgetMicros: z.number().int().nonnegative(), assumptions: assumptionsSchema.default({}) }),
});

export const proposalPayloadSchema = z.discriminatedUnion("type", [
  pauseAdProposal,
  activateProposal,
  changeBudgetProposal,
  createCampaignProposal,
  createAdGroupProposal,
  createAdProposal,
  addNegativeKeywordProposal,
  rotateAdProposal,
  reallocateBudgetProposal,
]);
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type ProposalType = ProposalPayload["type"];

export const proposalSourceSchema = z.string().regex(/^(detector|ai|command|manual):[^\s]{1,120}$/);

/** Stable key: the same ask on the same day is the same proposal. */
export function canonicalPayload(p: ProposalPayload): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (k === "assumptions" || k === "idempotencyKey") continue;
        out[k] = strip((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(p));
}
