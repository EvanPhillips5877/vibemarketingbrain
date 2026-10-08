import { Router } from "express";
import { z } from "zod";
import { runCommand } from "../ai/command.js";
import type { AiClient } from "../ai/client.js";
import { AiBudgetExceeded } from "../ai/client.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { brandOr404 } from "./brandParam.js";

export function commandRouter(db: Db, ai: AiClient): Router {
  const router = Router();

  // One command in, one answer out. Reads run first; any proposal it makes
  // goes through the Action Engine like every other, so this route can
  // never reach a platform.
  router.post("/api/brands/:slug/command", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const body = z.object({ text: z.string().trim().min(2).max(1000) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "text required (2–1000 chars)" });
      res.json(await runCommand(db, ai, d.brand, body.data.text, `manual:${currentUser(res)!.user.email}`));
    } catch (err) {
      if (err instanceof AiBudgetExceeded) return res.status(429).json({ error: "monthly AI budget spent" });
      next(err);
    }
  });

  return router;
}
