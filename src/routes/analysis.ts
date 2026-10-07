import { Router } from "express";
import { z } from "zod";
import type { AiClient } from "../ai/client.js";
import { AiBudgetExceeded } from "../ai/client.js";
import { analyzeBrand, latestReport } from "../analytics/morning.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { brandOr404 } from "./brandParam.js";


export function analysisRouter(db: Db, ai: AiClient): Router {
  const router = Router();

  router.get("/api/brands/:slug/report", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const report = await latestReport(db, d.brand.id);
      // The pack is large; the screen needs the entries only to show evidence.
      res.json({ report: report ? { ...report, pack: { entries: (report.pack as { entries: unknown[] }).entries, currency: (report.pack as { currency: string }).currency } } : null });
    } catch (err) {
      next(err);
    }
  });

  // Analyze now: the morning routine on demand. Reads only.
  router.post("/api/brands/:slug/analyze", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const r = await analyzeBrand(db, ai, d.brand.id, { actor: `manual:${currentUser(res)!.user.email}`, kind: "manual" });
      res.json({ reportId: r.report.id, isMock: r.isMock, dropped: r.dropped.length });
    } catch (err) {
      if (err instanceof AiBudgetExceeded) {
        res.status(429).json({ error: "monthly AI budget spent", spentMicros: err.spentMicros, budgetMicros: err.budgetMicros });
        return;
      }
      next(err);
    }
  });

  return router;
}
