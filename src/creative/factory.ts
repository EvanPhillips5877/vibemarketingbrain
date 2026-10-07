import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AiClient } from "../ai/client.js";
import { propose, type ProposeResult } from "../actions/proposals.js";
import { renderBrief } from "../brands/brief.js";
import { checkCopy, type ComplianceResult } from "../brands/compliance.js";
import { listFacts } from "../brands/facts.js";
import type { Db } from "../db/client.js";
import { auditEvents, brandAssets, brands, channelAccounts, creatives, creativeVariants, extObjects, hooks, hypotheses, type Brand, type CreativeVariant, type Hypothesis } from "../db/schema.js";
import { channelOf, copyOf, FORMATS, parsePayload, type Format, type MetaImagePayload } from "./formats.js";
import { generateHooks, generateVariant } from "./generate.js";
import { readAsset, renderAll, storeAsset } from "./render.js";

// The factory, end to end:
//   hypothesis → hooks → creatives (one per hook) → variants (per format,
//   N per creative) → compliance → render → tags → a person approves →
//   CREATE_AD proposals through the Action Engine.
// Nothing here talks to a platform; shipping is a proposal like any other.

export interface GenerateOptions {
  formats?: Format[];
  variantsPerHook?: number; // per format
  actor?: string;
}

export interface GenerateResult {
  hypothesisId: string;
  hooks: number;
  creatives: number;
  variants: number;
  nonCompliant: number;
  rendered: number;
  isMock: boolean;
}

export async function createHypothesis(db: Db, brandId: string, actor: string, input: { statement: string; dimensions?: Record<string, string>; missionId?: string | null }): Promise<Hypothesis> {
  const [row] = await db.insert(hypotheses).values({ brandId, statement: input.statement, dimensions: input.dimensions ?? {}, missionId: input.missionId ?? null }).returning();
  await db.insert(auditEvents).values({ actor, verb: "hypothesis_created", subject: `hypothesis:${row!.id}`, data: { brandId } });
  return row!;
}

/** The brand's approved screenshot, if any, as bytes. */
async function pickScreenshot(db: Db, brandId: string): Promise<{ id: string; bytes: Buffer } | null> {
  const [shot] = await db.select().from(brandAssets).where(and(eq(brandAssets.brandId, brandId), eq(brandAssets.kind, "screenshot"), eq(brandAssets.approved, true))).orderBy(desc(brandAssets.createdAt)).limit(1);
  if (!shot) return null;
  const bytes = readAsset(shot.storageKey);
  return bytes ? { id: shot.id, bytes } : null;
}

export async function generateForHypothesis(db: Db, ai: AiClient, brand: Brand, hypothesisId: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const formats = opts.formats ?? [...FORMATS];
  const perHook = opts.variantsPerHook ?? 2;
  const [h] = await db.select().from(hypotheses).where(and(eq(hypotheses.id, hypothesisId), eq(hypotheses.brandId, brand.id)));
  if (!h) throw new Error("hypothesis not found");
  const facts = await listFacts(db, brand.id);
  const brief = renderBrief(brand.name, brand.website, facts);
  const screenshot = await pickScreenshot(db, brand.id);

  const generated = await generateHooks(ai, brand, brief, h);
  let isMock = generated.isMock;
  let creativeCount = 0;
  let variantCount = 0;
  let nonCompliant = 0;
  let rendered = 0;

  for (const hk of generated.hooks.hooks) {
    const [hookRow] = await db.insert(hooks).values({ brandId: brand.id, text: hk.text, hookType: hk.hookType }).returning();
    const [creative] = await db.insert(creatives).values({ brandId: brand.id, hypothesisId: h.id, hookId: hookRow!.id, concept: `${hk.hookType}: ${hk.text}` }).returning();
    creativeCount++;
    for (const format of formats) {
      for (let seed = 0; seed < perHook; seed++) {
        const v = await generateVariant(ai, brand, brief, hk, h, format, seed);
        isMock = isMock || v.isMock;
        const payload = parsePayload(format, v.payload);
        const compliance = checkCopy(copyOf(format, payload).join("\n"), facts);
        if (!compliance.ok) nonCompliant++;
        const tags: Record<string, string> = {
          hook_type: hk.hookType,
          format,
          ...(format === "meta_image" ? { template: (payload as MetaImagePayload).template, visual_style: (payload as MetaImagePayload).template === "screenshot_headline" && screenshot ? "screenshot" : "typographic" } : {}),
          ...Object.fromEntries(Object.entries(h.dimensions).map(([k, val]) => [`hyp_${k}`, val])),
        };
        const [variant] = await db
          .insert(creativeVariants)
          .values({ creativeId: creative!.id, channel: channelOf[format], format, payload: { ...payload, compliance } as Record<string, unknown>, tags, status: "draft" })
          .returning();
        variantCount++;
        if (format === "meta_image") {
          const images = await renderAll({ payload: payload as MetaImagePayload, brandName: brand.name, screenshot: screenshot?.bytes ?? null });
          const ids: string[] = [];
          for (const img of images) {
            const [asset] = await db.insert(brandAssets).values({ brandId: brand.id, kind: "rendered", storageKey: "pending", tags: [img.ratio, `variant:${variant!.id}`], width: img.width, height: img.height, approved: false }).returning();
            const key = storeAsset(asset!.id, img.png);
            await db.update(brandAssets).set({ storageKey: key }).where(eq(brandAssets.id, asset!.id));
            ids.push(asset!.id);
            rendered++;
          }
          await db.update(creativeVariants).set({ renderedAssetIds: ids }).where(eq(creativeVariants.id, variant!.id));
        }
      }
    }
  }
  await db.update(hypotheses).set({ status: "testing" }).where(and(eq(hypotheses.id, h.id), eq(hypotheses.status, "untested")));
  await db.insert(auditEvents).values({ actor: opts.actor ?? "system:factory", verb: "creatives_generated", subject: `hypothesis:${h.id}`, data: { brandId: brand.id, hooks: generated.hooks.hooks.length, creatives: creativeCount, variants: variantCount, nonCompliant, isMock } });
  return { hypothesisId: h.id, hooks: generated.hooks.hooks.length, creatives: creativeCount, variants: variantCount, nonCompliant, rendered, isMock };
}

export class VariantNotFound extends Error {}
export class VariantStateError extends Error {}

async function ownedVariant(db: Db, brandId: string, id: string): Promise<CreativeVariant> {
  const [row] = await db
    .select({ v: creativeVariants })
    .from(creativeVariants)
    .innerJoin(creatives, eq(creatives.id, creativeVariants.creativeId))
    .where(and(eq(creativeVariants.id, id), eq(creatives.brandId, brandId)));
  if (!row) throw new VariantNotFound("variant not found");
  return row.v;
}

export function complianceOf(v: CreativeVariant): ComplianceResult | null {
  return ((v.payload as { compliance?: ComplianceResult }).compliance as ComplianceResult | undefined) ?? null;
}

/** A person approves copy. Copy that fails the brand's prohibited-claim patterns cannot be approved; edit it first. */
export async function approveVariant(db: Db, brandId: string, id: string, actor: string): Promise<CreativeVariant> {
  const v = await ownedVariant(db, brandId, id);
  if (v.status !== "draft") throw new VariantStateError(`variant is ${v.status}`);
  const c = complianceOf(v);
  if (c && !c.ok) throw new VariantStateError(`copy breaks a brand rule: ${c.violations.map((x) => x.rule).join("; ")}`);
  const [row] = await db.update(creativeVariants).set({ status: "approved" }).where(eq(creativeVariants.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "variant_approved", subject: `variant:${id}`, data: { brandId } });
  return row!;
}

export async function rejectVariant(db: Db, brandId: string, id: string, actor: string, reason?: string): Promise<CreativeVariant> {
  const v = await ownedVariant(db, brandId, id);
  if (v.status === "live") throw new VariantStateError("a live variant is retired through a PAUSE_AD proposal, not here");
  const [row] = await db.update(creativeVariants).set({ status: "retired" }).where(eq(creativeVariants.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "variant_rejected", subject: `variant:${id}`, data: { brandId, reason: reason ?? null } });
  return row!;
}

/** Edit copy by hand: re-validated against the format, re-checked for compliance, re-rendered. */
export async function editVariant(db: Db, ai: AiClient, brandId: string, id: string, actor: string, payload: unknown): Promise<CreativeVariant> {
  void ai;
  const v = await ownedVariant(db, brandId, id);
  if (v.status !== "draft") throw new VariantStateError(`variant is ${v.status}; only drafts are edited`);
  const parsed = parsePayload(v.format as Format, payload);
  const facts = await listFacts(db, brandId);
  const compliance = checkCopy(copyOf(v.format as Format, parsed).join("\n"), facts);
  let renderedAssetIds = v.renderedAssetIds;
  if (v.format === "meta_image") {
    const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
    const screenshot = await pickScreenshot(db, brandId);
    const images = await renderAll({ payload: parsed as MetaImagePayload, brandName: brand!.name, screenshot: screenshot?.bytes ?? null });
    renderedAssetIds = [];
    for (const img of images) {
      const [asset] = await db.insert(brandAssets).values({ brandId, kind: "rendered", storageKey: "pending", tags: [img.ratio, `variant:${id}`], width: img.width, height: img.height, approved: false }).returning();
      await db.update(brandAssets).set({ storageKey: storeAsset(asset!.id, img.png) }).where(eq(brandAssets.id, asset!.id));
      renderedAssetIds.push(asset!.id);
    }
  }
  const [row] = await db.update(creativeVariants).set({ payload: { ...parsed, compliance } as Record<string, unknown>, renderedAssetIds }).where(eq(creativeVariants.id, id)).returning();
  await db.insert(auditEvents).values({ actor, verb: "variant_edited", subject: `variant:${id}`, data: { brandId, compliant: compliance.ok } });
  return row!;
}

export interface ShipInput {
  variantIds: string[];
  channelAccountId: string;
  adGroupExternalId: string;
  landingUrl: string;
  missionId?: string | null;
  experimentId?: string | null;
}

/** Approved variants → one CREATE_AD proposal each, sharing a group so one approval can cover them all. */
export async function shipVariants(db: Db, brandId: string, actor: string, input: ShipInput): Promise<ProposeResult[]> {
  const [acct] = await db.select().from(channelAccounts).where(and(eq(channelAccounts.id, input.channelAccountId), eq(channelAccounts.brandId, brandId)));
  if (!acct) throw new Error("channel account not found for this brand");
  const [group] = await db.select().from(extObjects).where(and(eq(extObjects.channelAccountId, acct.id), eq(extObjects.kind, "ad_group"), eq(extObjects.externalId, input.adGroupExternalId)));
  if (!group) throw new Error("ad group is not mirrored for this account; sync first");
  const rows = await db
    .select({ v: creativeVariants, c: creatives })
    .from(creativeVariants)
    .innerJoin(creatives, eq(creatives.id, creativeVariants.creativeId))
    .where(and(inArray(creativeVariants.id, input.variantIds), eq(creatives.brandId, brandId)));
  if (rows.length !== input.variantIds.length) throw new Error("one or more variants do not belong to this brand");
  const groupId = crypto.randomUUID();
  const out: ProposeResult[] = [];
  for (const { v, c } of rows) {
    if (v.status !== "approved") throw new VariantStateError(`variant ${v.id} is ${v.status}, not approved`);
    if (v.channel !== acct.channel && acct.channel !== "mock") throw new VariantStateError(`variant ${v.id} is for ${v.channel}, account is ${acct.channel}`);
    const { compliance: _c, ...payload } = v.payload as Record<string, unknown>;
    const r = await propose(db, {
      brandId,
      payload: {
        type: "CREATE_AD",
        channelAccountId: acct.id,
        adGroupExternalId: input.adGroupExternalId,
        name: `${c.concept.slice(0, 60)} / ${v.format} / ${v.id.slice(0, 8)}`,
        creativeVariantId: v.id,
        landingUrl: input.landingUrl,
        payload: { ...payload, renderedAssetIds: v.renderedAssetIds },
        idempotencyKey: `variant-${v.id}-${input.adGroupExternalId}`.slice(0, 128),
      },
      reason: `Ship approved creative "${c.concept.slice(0, 80)}" (${v.format}) as a paused ad in ad group ${input.adGroupExternalId}.`,
      source: actor,
      evidence: { variantId: v.id, hypothesisId: c.hypothesisId, tags: v.tags },
      expectedOutcome: "A new paused ad, to be activated by a separate proposal.",
      groupId,
      missionId: input.missionId ?? null,
      experimentId: input.experimentId ?? null,
    });
    out.push(r);
  }
  return out;
}

export interface CreativeTree {
  hypotheses: Hypothesis[];
  creatives: (typeof creatives.$inferSelect)[];
  hooks: (typeof hooks.$inferSelect)[];
  variants: CreativeVariant[];
}

export async function creativeTree(db: Db, brandId: string): Promise<CreativeTree> {
  const [hyps, crs, hks] = await Promise.all([
    db.select().from(hypotheses).where(eq(hypotheses.brandId, brandId)).orderBy(desc(hypotheses.createdAt)),
    db.select().from(creatives).where(eq(creatives.brandId, brandId)).orderBy(desc(creatives.createdAt)),
    db.select().from(hooks).where(eq(hooks.brandId, brandId)),
  ]);
  const ids = crs.map((c) => c.id);
  const variants = ids.length ? await db.select().from(creativeVariants).where(and(inArray(creativeVariants.creativeId, ids), sql`${creativeVariants.status} <> 'retired'`)).orderBy(desc(creativeVariants.createdAt)) : [];
  return { hypotheses: hyps, creatives: crs, hooks: hks, variants };
}
