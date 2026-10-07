import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { AiClient } from "../ai/client.js";
import { AiBudgetExceeded } from "../ai/client.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import { renderBrief } from "../brands/brief.js";
import { checkCopy } from "../brands/compliance.js";
import { crawlBrandSite } from "../brands/crawler.js";
import { extractFacts } from "../brands/extract.js";
import { acceptFact, createFact, editFact, FactNotFound, listFacts, rejectFact } from "../brands/facts.js";
import { getBrand } from "../brands/queries.js";
import type { Db } from "../db/client.js";
import { brandPages } from "../db/schema.js";

const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);
const idSchema = z.string().uuid();

export function factsRouter(db: Db, ai: AiClient): Router {
  const router = Router();

  const brandOr404 = async (slugRaw: unknown, res: import("express").Response) => {
    const slug = slugSchema.safeParse(slugRaw);
    const detail = slug.success ? await getBrand(db, slug.data) : null;
    if (!detail) res.status(404).json({ error: "not found" });
    return detail;
  };
  const actor = (res: import("express").Response) => `manual:${currentUser(res)!.user.email}`;

  router.get("/api/brands/:slug/facts", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      const pages = await db.select({ url: brandPages.url, title: brandPages.title, httpStatus: brandPages.httpStatus, fetchedAt: brandPages.fetchedAt }).from(brandPages).where(eq(brandPages.brandId, d.brand.id)).orderBy(brandPages.url);
      res.json({ facts: await listFacts(db, d.brand.id), pages, aiIsMock: ai.isMock });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/brands/:slug/facts", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      res.status(201).json({ fact: await createFact(db, d.brand.id, actor(res), req.body) });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "invalid fact", issues: err.issues });
        return;
      }
      next(err);
    }
  });

  const factAction = z.object({
    action: z.enum(["accept", "reject", "edit"]),
    value: z.unknown().optional(),
    reason: z.string().max(500).optional(),
  });

  router.patch("/api/brands/:slug/facts/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = factAction.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: "invalid request" });
        return;
      }
      const who = actor(res);
      const fact =
        body.data.action === "accept"
          ? await acceptFact(db, d.brand.id, id.data, who)
          : body.data.action === "reject"
            ? await rejectFact(db, d.brand.id, id.data, who, body.data.reason)
            : await editFact(db, d.brand.id, id.data, who, body.data.value);
      res.json({ fact });
    } catch (err) {
      if (err instanceof FactNotFound) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "invalid value", issues: err.issues });
        return;
      }
      next(err);
    }
  });

  // Crawl the site and propose facts. Read-only on the world; writes only
  // `proposed` rows here.
  router.post("/api/brands/:slug/crawl", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      const crawled = await crawlBrandSite(db, d.brand);
      // Extract from what this crawl fetched, nothing older.
      const urls = crawled.map((p) => p.url);
      const pages = urls.length ? await db.select().from(brandPages).where(and(eq(brandPages.brandId, d.brand.id), inArray(brandPages.url, urls))) : [];
      const extracted = await extractFacts(db, ai, d.brand, pages);
      res.json({ pages: crawled.map((p) => ({ url: p.url, status: p.status, title: p.title })), ...extracted });
    } catch (err) {
      if (err instanceof AiBudgetExceeded) {
        res.status(429).json({ error: "monthly AI budget spent", spentMicros: err.spentMicros, budgetMicros: err.budgetMicros });
        return;
      }
      next(err);
    }
  });

  router.get("/api/brands/:slug/brief", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      res.type("text/markdown").send(renderBrief(d.brand.name, d.brand.website, await listFacts(db, d.brand.id)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/brands/:slug/compliance", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(req.params["slug"], res);
      if (!d) return;
      const body = z.object({ text: z.string().min(1).max(10_000) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "text required" });
        return;
      }
      res.json(checkCopy(body.data.text, await listFacts(db, d.brand.id)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
