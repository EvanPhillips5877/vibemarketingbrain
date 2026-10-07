import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth/middleware.js";
import { getBrand, listBrands } from "../brands/queries.js";
import type { Db } from "../db/client.js";

// Read-only in Phase 2. Fact editing and policy versioning get their own
// routes with the review screen (Phase 9) and the Action Engine (Phase 11).
export function brandsRouter(db: Db): Router {
  const router = Router();

  router.get("/api/brands", requireUser, async (_req, res, next) => {
    try {
      res.json({ brands: await listBrands(db) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/brands/:slug", requireUser, async (req, res, next) => {
    try {
      const slug = z.string().regex(/^[a-z0-9-]{1,64}$/).safeParse(req.params["slug"]);
      if (!slug.success) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const detail = await getBrand(db, slug.data);
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
