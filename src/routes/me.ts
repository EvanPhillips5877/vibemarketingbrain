import { Router } from "express";
import type { Config } from "../config.js";
import { currentUser, requireUser } from "../auth/middleware.js";

// What the web shell needs on load: who is signed in, the CSRF token to send
// back on mutations, and which integrations are running as mocks.
export function meRouter(config: Config): Router {
  const router = Router();
  router.get("/api/me", requireUser, (_req, res) => {
    const session = currentUser(res)!;
    res.json({
      user: { email: session.user.email, name: session.user.name },
      csrfToken: session.csrfToken,
      env: config.env,
      authMode: config.auth.mode,
      mock: config.mock,
    });
  });
  router.get("/api/auth-mode", (_req, res) => {
    res.json({ authMode: config.auth.mode });
  });
  return router;
}
