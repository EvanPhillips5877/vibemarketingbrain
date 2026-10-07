import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { isAllowed } from "./allowlist.js";
import type { IdentityProvider } from "./google.js";
import { currentUser, requireCsrf, requireUser } from "./middleware.js";
import { recordRefusal, SESSION_COOKIE, SESSION_TTL_MS, signIn, signOut } from "./sessions.js";

const STATE_COOKIE = "mb_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

interface AuthDeps {
  config: Config;
  db: Db;
  identity: IdentityProvider | null; // null in dev mode
}

// OAuth state: random nonce + expiry, HMAC-signed with APP_SECRET, kept in a
// short-lived httpOnly cookie. The callback must present the same value.
function signState(secret: string): string {
  const body = `${randomBytes(16).toString("base64url")}.${Date.now() + STATE_TTL_MS}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function stateIsValid(state: string, secret: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, exp, mac] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${nonce}.${exp}`).digest("base64url");
  if (mac.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function setSessionCookie(res: Response, config: Config, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: config.isProduction, path: "/" });
}

/** Shared by Google and dev sign-in: allowlist, then session. */
async function admit(
  deps: AuthDeps,
  res: Response,
  identity: { email: string; emailVerified: boolean; name: string | null },
): Promise<boolean> {
  if (!identity.emailVerified) {
    await recordRefusal(deps.db, identity.email, "email not verified");
    return false;
  }
  if (!isAllowed(identity.email, deps.config.allowedEmails)) {
    await recordRefusal(deps.db, identity.email, "not on allowlist");
    return false;
  }
  const { sessionId } = await signIn(deps.db, identity.email, identity.name);
  setSessionCookie(res, deps.config, sessionId);
  return true;
}

export function authRouter(deps: AuthDeps): Router {
  const { config } = deps;
  const router = Router();
  const redirectUri = `${config.publicBaseUrl}/auth/google/callback`;

  router.get("/auth/google", (_req, res) => {
    if (!deps.identity) {
      res.status(404).json({ error: "Google sign-in is not configured" });
      return;
    }
    const state = signState(config.appSecret);
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProduction,
      path: "/auth",
      maxAge: STATE_TTL_MS,
    });
    res.redirect(deps.identity.startUrl(state, redirectUri));
  });

  router.get("/auth/google/callback", async (req, res, next) => {
    try {
      if (!deps.identity) {
        res.status(404).json({ error: "Google sign-in is not configured" });
        return;
      }
      const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
      const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
      const stateCookie = cookies[STATE_COOKIE];
      res.clearCookie(STATE_COOKIE, { path: "/auth" });
      if (!query.success || !stateCookie || stateCookie !== query.data.state || !stateIsValid(stateCookie, config.appSecret)) {
        res.status(400).send("Sign-in could not be verified. Please try again.");
        return;
      }
      const identity = await deps.identity.complete(query.data.code, redirectUri);
      const ok = await admit(deps, res, identity);
      if (!ok) {
        res.status(403).send("This address is not allowed to use MarketingBrain.");
        return;
      }
      res.redirect("/");
    } catch (err) {
      next(err);
    }
  });

  if (config.auth.mode === "dev") {
    // Local development only: config refuses dev mode in production. Still
    // allowlisted, still audited, so the rest of the app behaves identically.
    router.post("/auth/dev-login", async (req, res, next) => {
      try {
        const body = z.object({ email: z.string().email() }).safeParse(req.body);
        if (!body.success) {
          res.status(400).json({ error: "email required" });
          return;
        }
        const ok = await admit(deps, res, { email: body.data.email, emailVerified: true, name: null });
        if (!ok) {
          res.status(403).json({ error: "not allowed" });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
  }

  router.post("/auth/logout", requireUser, requireCsrf, async (_req, res, next) => {
    try {
      const session = currentUser(res);
      if (session) await signOut(deps.db, session);
      clearSessionCookie(res, config);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
