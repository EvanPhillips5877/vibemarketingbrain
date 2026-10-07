import { Router } from "express";
import { z } from "zod";
import { executeApproved, proposeRollback, reconcileUnknown } from "../actions/executor.js";
import { approve, expireStale, listProposals, ProposalNotFound, ProposalStateError, propose, reject } from "../actions/proposals.js";
import { currentUser, requireUser } from "../auth/middleware.js";
import type { AdapterRegistry } from "../channels/registry.js";
import type { Db } from "../db/client.js";
import type { ProposalStatus } from "../db/schema.js";
import { brandOr404 } from "./brandParam.js";

const idSchema = z.string().uuid();
const OPEN: ProposalStatus[] = ["awaiting_approval", "approved", "executing", "unknown"];
const DONE: ProposalStatus[] = ["executed", "failed", "expired", "rejected", "blocked", "rolled_back"];

export function proposalsRouter(db: Db, registry: AdapterRegistry): Router {
  const router = Router();
  const actor = (res: import("express").Response) => `manual:${currentUser(res)!.user.email}`;

  router.get("/api/brands/:slug/proposals", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const [open, done] = await Promise.all([listProposals(db, d.brand.id, OPEN), listProposals(db, d.brand.id, DONE, 50)]);
      res.json({ open, done });
    } catch (err) {
      next(err);
    }
  });

  // A person proposes by hand (the command bar will use the same path).
  router.post("/api/brands/:slug/proposals", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const body = z.object({ payload: z.unknown(), reason: z.string().min(1).max(500) }).safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "payload and reason required" });
        return;
      }
      const r = await propose(db, { brandId: d.brand.id, payload: body.data.payload, reason: body.data.reason, source: actor(res) });
      res.status(r.duplicate ? 200 : 201).json(r);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "invalid payload", issues: err.issues });
        return;
      }
      next(err);
    }
  });

  const decision = z.object({ action: z.enum(["approve", "reject", "rollback"]), reason: z.string().max(500).optional() });

  router.patch("/api/brands/:slug/proposals/:id", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      const id = idSchema.safeParse(req.params["id"]);
      const body = decision.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: "invalid request" });
        return;
      }
      const who = actor(res);
      if (body.data.action === "rollback") {
        res.json(await proposeRollback(db, registry, d.brand.id, id.data, who));
        return;
      }
      const proposal = body.data.action === "approve" ? await approve(db, d.brand.id, id.data, who) : await reject(db, d.brand.id, id.data, who, body.data.reason);
      res.json({ proposal });
    } catch (err) {
      if (err instanceof ProposalNotFound) {
        res.status(404).json({ error: "not found" });
        return;
      }
      if (err instanceof ProposalStateError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // Run the executor and the reconciler now (the scheduler does this every few minutes).
  router.post("/api/brands/:slug/execute", requireUser, async (req, res, next) => {
    try {
      const d = await brandOr404(db, req.params["slug"], res);
      if (!d) return;
      await expireStale(db);
      const reconciled = await reconcileUnknown(db, registry, d.brand.id);
      const executed = await executeApproved(db, registry, d.brand.id);
      res.json({ executed, reconciled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
