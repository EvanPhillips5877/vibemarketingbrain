import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, sessions, users, type User } from "../db/schema.js";

export const SESSION_COOKIE = "mb_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  sessionId: string;
  csrfToken: string;
  user: User;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Find-or-create the user row for a verified, allowlisted address, then open a session. */
export async function signIn(db: Db, email: string, name: string | null): Promise<{ sessionId: string }> {
  const normalized = email.trim().toLowerCase();
  const [user] = await db
    .insert(users)
    .values({ email: normalized, name, lastLoginAt: sql`now()` })
    .onConflictDoUpdate({
      target: users.email,
      set: { lastLoginAt: sql`now()`, name: name ?? sql`${users.name}` },
    })
    .returning();
  if (!user) throw new Error("user upsert returned no row");

  const sessionId = token(32);
  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    csrfToken: token(24),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  await db.insert(auditEvents).values({ actor: normalized, verb: "login", subject: `user:${user.id}` });
  return { sessionId };
}

/** Resolve a cookie value to a live session, or null. Expired rows are ignored (and swept lazily). */
export async function getSession(db: Db, sessionId: string): Promise<SessionUser | null> {
  if (!sessionId || sessionId.length > 128) return null;
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Touch at most once a minute; this is bookkeeping, not security.
  if (Date.now() - row.session.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, sessionId));
  }
  return { sessionId, csrfToken: row.session.csrfToken, user: row.user };
}

export async function signOut(db: Db, current: SessionUser): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, current.sessionId));
  await db.insert(auditEvents).values({ actor: current.user.email, verb: "logout", subject: `user:${current.user.id}` });
}

/** End a session the user did not ask to end (allowlist change, later: admin action). */
export async function revokeSession(db: Db, current: SessionUser, reason: string): Promise<void> {
  // Concurrent requests may all find the same dead session; only the one
  // whose DELETE removed the row writes the audit event.
  const deleted = await db.delete(sessions).where(eq(sessions.id, current.sessionId)).returning({ id: sessions.id });
  if (deleted.length === 0) return;
  await db.insert(auditEvents).values({
    actor: "system:auth",
    verb: "session_revoked",
    subject: `user:${current.user.id}`,
    data: { reason, email: current.user.email },
  });
}

export async function recordRefusal(db: Db, email: string, reason: string): Promise<void> {
  await db.insert(auditEvents).values({ actor: email.trim().toLowerCase(), verb: "login_refused", data: { reason } });
}
