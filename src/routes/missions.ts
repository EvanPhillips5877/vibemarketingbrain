import { Router } from "express";
import { z } from "zod";
import type { AiClient } from "../ai/client.js";
import { AiBudgetExceeded } from "../ai/client.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import type { Db } from "../db/client.js";
import { experimentLedger, missionProgress } from "../missions/ledger.js";
import { activateMission, draftMission, editMission, getMission, latestProposals, listMissions, MissionNotFound, MissionStateError, pauseMission, planForMission } from "../missions/missions.js";
import { progressBrand } from "../missions/progress.js";
import { brandOr404 } from "./brandParam.js";

const idSchema = z.string().uuid();

export function missionsRouter(db: Db, ai: AiClient): Router {
  const router = Router();
  const actor = (res: import("express").Response) => `manual:${currentUser(res)!.user.email}`;
  const onError = (err: unknown, res: import("express").Response, next: import("express").NextFunction) => {
    if (err instanceof MissionNotFound) return res.status(404).json({ error: "not found" });
    if (err instanceof MissionStateError) return res.status(409).json({ error: err.message });
    if (err instanceof Error && err.name === "ZodError") return res.status(400).json({ error: "invalid", detail: err.message });
    if (err instanceof AiBudgetExceeded) return res.status(429).json({ error: "monthly AI budget spent" });
    return next(err);
  };

  router.get("/api/brands/:slug/missions", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const list = await listMissions(db, d.brand.id);
      const withProgress = await Promise.all(list.map(async (m) => ({ mission: m, progress: m.status === "active" || m.status === "done" || m.status === "paused" ? await missionProgress(db, m) : null })));
      res.json({ missions: withProgress, aiIsMock: ai.isMock });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/brands/:slug/missions", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const body = z.object({ text: z.string().min(10).max(1000) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "text required (10–1000 chars)" });
      res.status(201).json(await draftMission(db, ai, d.brand, body.data.text, actor(res)));
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.get("/api/brands/:slug/missions/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      if (!id.success) return res.status(404).json({ error: "not found" });
      const { mission, experiments } = await getMission(db, d.brand.id, id.data);
      const latest = await latestProposals(db, experiments.map((e) => e.id));
      const exps = await Promise.all(
        experiments.map(async (e) => {
          const p = latest.get(e.id);
          const violations = ((p?.policyResult as { violations?: { rule: string }[] } | null)?.violations ?? []).map((v) => v.rule);
          return { experiment: e, ledger: await experimentLedger(db, e), campaign: p ? { proposalId: p.id, status: p.status, violations } : null };
        }),
      );
      res.json({ mission, progress: mission.startsAt ? await missionProgress(db, mission) : null, experiments: exps });
    } catch (err) {
      onError(err, res, next);
    }
  });

  router.patch("/api/brands/:slug/missions/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = z.object({ action: z.enum(["edit", "plan", "activate", "pause"]), fields: z.unknown().optional() }).safeParse(req.body);
      if (!id.success || !body.success) return res.status(400).json({ error: "invalid request" });
      const who = actor(res);
      switch (body.data.action) {
        case "edit":
          return res.json({ mission: await editMission(db, d.brand.id, id.data, who, body.data.fields ?? {}) });
        case "plan":
          return res.json(await planForMission(db, ai, d.brand, id.data, who));
        case "activate":
          return res.json(await activateMission(db, d.brand, id.data, who));
        case "pause":
          return res.json({ mission: await pauseMission(db, d.brand.id, id.data, who) });
      }
    } catch (err) {
      onError(err, res, next);
    }
  });

  // The daily pass, on demand.
  router.post("/api/brands/:slug/missions/progress", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      res.json(await progressBrand(db, d.brand.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
