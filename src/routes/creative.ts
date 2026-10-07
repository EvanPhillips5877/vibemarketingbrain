import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { AiClient } from "../ai/client.js";
import { AiBudgetExceeded } from "../ai/client.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import { approveVariant, createHypothesis, creativeTree, editVariant, generateForHypothesis, rejectVariant, shipVariants, VariantNotFound, VariantStateError } from "../creative/factory.js";
import { FORMATS } from "../creative/formats.js";
import { readAsset } from "../creative/render.js";
import type { Db } from "../db/client.js";
import { brandAssets, brands } from "../db/schema.js";
import { brandOr404 } from "./brandParam.js";

const idSchema = z.string().uuid();

export function creativeRouter(db: Db, ai: AiClient): Router {
  const router = Router();
  const actor = (res: import("express").Response) => `manual:${currentUser(res)!.user.email}`;
  const onError = (err: unknown, res: import("express").Response, next: import("express").NextFunction) => {
    if (err instanceof VariantNotFound) return res.status(404).json({ error: "not found" });
    if (err instanceof VariantStateError) return res.status(409).json({ error: err.message });
    if (err instanceof z.ZodError || (err instanceof Error && err.name === "ZodError")) return res.status(400).json({ error: "invalid", detail: err.message });
    if (err instanceof AiBudgetExceeded) return res.status(429).json({ error: "monthly AI budget spent" });
    return next(err);
  };

  router.get("/api/brands/:slug/creative", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      res.json({ ...(await creativeTree(db, d.brand.id)), aiIsMock: ai.isMock, formats: FORMATS });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/brands/:slug/creative/hypotheses", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const body = z.object({ statement: z.string().min(5).max(500), dimensions: z.record(z.string().max(40), z.string().max(80)).default({}) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "statement required", issues: body.error.issues });
      res.status(201).json({ hypothesis: await createHypothesis(db, d.brand.id, actor(res), body.data) });
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.post("/api/brands/:slug/creative/hypotheses/:id/generate", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = z.object({ formats: z.array(z.enum(FORMATS)).min(1).default([...FORMATS]), variantsPerHook: z.number().int().min(1).max(4).default(2) }).safeParse(req.body ?? {});
      if (!id.success || !body.success) return res.status(400).json({ error: "invalid request" });
      res.json(await generateForHypothesis(db, ai, d.brand, id.data, { ...body.data, actor: actor(res) }));
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.patch("/api/brands/:slug/creative/variants/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = z.object({ action: z.enum(["approve", "reject", "edit"]), payload: z.unknown().optional(), reason: z.string().max(500).optional() }).safeParse(req.body);
      if (!id.success || !body.success) return res.status(400).json({ error: "invalid request" });
      const who = actor(res);
      const variant = body.data.action === "approve" ? await approveVariant(db, d.brand.id, id.data, who) : body.data.action === "reject" ? await rejectVariant(db, d.brand.id, id.data, who, body.data.reason) : await editVariant(db, ai, d.brand.id, id.data, who, body.data.payload);
      res.json({ variant });
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.post("/api/brands/:slug/creative/ship", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const body = z.object({ variantIds: z.array(idSchema).min(1).max(50), channelAccountId: idSchema, adGroupExternalId: z.string().min(1).max(128), landingUrl: z.string().url().max(500) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "invalid request", issues: body.error.issues });
      res.status(201).json({ proposals: await shipVariants(db, d.brand.id, actor(res), body.data) });
    } catch (err) {
      onError(err, res, next);
    }
  });

  // Rendered images and screenshots, by asset id. Session required; the
  // file lives under data/assets and the key never comes from the request.
  router.get("/api/assets/:id", requireUser, async (req, res, next) => {
    try {
      const id = idSchema.safeParse(req.params["id"]);
      if (!id.success) return res.status(404).end();
      const [asset] = await db.select({ a: brandAssets }).from(brandAssets).innerJoin(brands, eq(brands.id, brandAssets.brandId)).where(and(eq(brandAssets.id, id.data)));
      const bytes = asset ? readAsset(asset.a.storageKey) : null;
      if (!asset || !bytes) return res.status(404).end();
      res.type("image/png").setHeader("Cache-Control", "private, max-age=3600").send(bytes);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
