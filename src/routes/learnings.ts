import { Router } from "express";
import { z } from "zod";
import { currentUser, requireUser } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { distillBrand } from "../learnings/distill.js";
import { createLearning, editLearning, LearningNotFound, listLearnings, restoreLearning, retireLearning } from "../learnings/manage.js";
import { brandOr404 } from "./brandParam.js";

const idSchema = z.string().uuid();

export function learningsRouter(db: Db): Router {
  const router = Router();
  const actor = (res: import("express").Response) => `manual:${currentUser(res)!.user.email}`;
  const onError = (err: unknown, res: import("express").Response, next: import("express").NextFunction) => {
    if (err instanceof LearningNotFound) return res.status(404).json({ error: "not found" });
    if (err instanceof Error && err.name === "ZodError") return res.status(400).json({ error: "invalid", detail: err.message });
    return next(err);
  };

  router.get("/api/brands/:slug/learnings", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      res.json({ learnings: await listLearnings(db, d.brand.id, { includeRetired: req.query["all"] === "1" }) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/brands/:slug/learnings", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      res.status(201).json({ learning: await createLearning(db, d.brand.id, actor(res), req.body) });
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.patch("/api/brands/:slug/learnings/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = z.object({ action: z.enum(["edit", "retire", "restore"]), fields: z.unknown().optional(), reason: z.string().max(300).optional() }).safeParse(req.body);
      if (!id.success || !body.success) return res.status(400).json({ error: "invalid request" });
      const who = actor(res);
      const learning = body.data.action === "edit" ? await editLearning(db, d.brand.id, id.data, who, body.data.fields ?? {}) : body.data.action === "retire" ? await retireLearning(db, d.brand.id, id.data, who, body.data.reason) : await restoreLearning(db, d.brand.id, id.data, who);
      res.json({ learning });
    } catch (err) {
      onError(err, res, next);
    }
  });

  // The weekly pass, on demand. Reads metrics, writes observations only.
  router.post("/api/brands/:slug/learnings/distill", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      res.json(await distillBrand(db, d.brand.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
