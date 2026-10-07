import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "../db/client.js";
import { isAllowed } from "./allowlist.js";
import { getSession, revokeSession, SESSION_COOKIE, type SessionUser } from "./sessions.js";

// Express 5 + TypeScript: the current session rides on res.locals, typed here
// once so routes never cast.
export function currentUser(res: Response): SessionUser | null {
  return (res.locals["session"] as SessionUser | undefined) ?? null;
}

/** Reads the session cookie (if any) and attaches the session to res.locals. Never rejects. */
export function attachSession(db: Db, allowedEmails: readonly string[]): RequestHandler {
  return async (req, res, next) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const id = cookies[SESSION_COOKIE];
    if (id) {
      try {
        const session = await getSession(db, id);
        // The allowlist is checked on every request, not only at sign-in:
        // removing an address from ALLOWED_EMAILS must end its access at
        // the next restart, not 30 days later.
        if (session && !isAllowed(session.user.email, allowedEmails)) {
          await revokeSession(db, session, "removed from allowlist");
        } else if (session) {
          res.locals["session"] = session;
        }
      } catch (err) {
        next(err);
        return;
      }
    }
    next();
  };
}

/** 401 without a live session. */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!currentUser(res)) {
    res.status(401).json({ error: "sign in required" });
    return;
  }
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Every mutating /api request must echo the session's CSRF token in a header. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const session = currentUser(res);
  const header = req.header("x-csrf-token");
  if (!session || !header || header !== session.csrfToken) {
    res.status(403).json({ error: "missing or invalid CSRF token" });
    return;
  }
  next();
}
