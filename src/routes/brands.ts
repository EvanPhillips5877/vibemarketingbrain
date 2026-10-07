import { and, desc, eq } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import { auditEvents } from "../db/schema.js";
import { brandSummary, campaignsTable } from "../analytics/ledger.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import { getBrand, listBrands } from "../brands/queries.js";
import type { AdapterRegistry } from "../channels/registry.js";
import type { Db } from "../db/client.js";
import { isoDay } from "../ingest/metrics.js";
import { syncBrand } from "../ingest/sync.js";
import { slugSchema } from "./brandParam.js";

const windowSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

export function brandsRouter(db: Db, registry: AdapterRegistry): Router {
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
      const slug = slugSchema.safeParse(req.params["slug"]);
      const detail = slug.success ? await getBrand(db, slug.data) : null;
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  // Today: what was spent and what came back, over a window ending today.
  router.get("/api/brands/:slug/today", requireUser, async (req, res, next) => {
    try {
      const slug = slugSchema.safeParse(req.params["slug"]);
      const q = windowSchema.safeParse(req.query);
      const detail = slug.success && q.success ? await getBrand(db, slug.data) : null;
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const window = { from: isoDay(q.data!.days - 1), to: isoDay(0), timezone: detail.brand.timezone };
      const [last] = await db
        .select({ at: auditEvents.at })
        .from(auditEvents)
        .where(and(eq(auditEvents.verb, "brand_synced"), eq(auditEvents.subject, `brand:${detail.brand.id}`)))
        .orderBy(desc(auditEvents.at))
        .limit(1);
      res.json({
        brand: {
          slug: detail.brand.slug,
          name: detail.brand.name,
          currency: detail.brand.defaultCurrency,
          lastSyncAt: last?.at ?? null,
          eventsPulledAt: detail.brand.eventsPulledAt,
          eventsSourceIsMock: !detail.brand.eventsExportUrl,
        },
        summary: await brandSummary(db, detail.brand.id, window),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/brands/:slug/campaigns", requireUser, async (req, res, next) => {
    try {
      const slug = slugSchema.safeParse(req.params["slug"]);
      const q = windowSchema.safeParse(req.query);
      const detail = slug.success && q.success ? await getBrand(db, slug.data) : null;
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const window = { from: isoDay(q.data!.days - 1), to: isoDay(0), timezone: detail.brand.timezone };
      res.json({ window, currency: detail.brand.defaultCurrency, campaigns: await campaignsTable(db, detail.brand.id, window) });
    } catch (err) {
      next(err);
    }
  });

  // Sync now: the same read-only work the scheduler does, on demand.
  router.post("/api/brands/:slug/sync", requireUser, async (req, res, next) => {
    try {
      const slug = slugSchema.safeParse(req.params["slug"]);
      const detail = slug.success ? await getBrand(db, slug.data) : null;
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const actor = `manual:${currentUser(res)!.user.email}`;
      res.json(await syncBrand(db, registry, detail.brand, { metricDays: 7, actor }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
