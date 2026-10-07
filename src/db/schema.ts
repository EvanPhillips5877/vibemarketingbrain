import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Phase 1 holds only what sign-in needs. Brands, missions, experiments and
// the rest arrive in Phase 2 (see docs/ARCHITECTURE.md §3).

// A person allowed to use MarketingBrain. Rows are created on first
// successful sign-in; the allowlist in config decides who gets that far.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});
export type User = typeof users.$inferSelect;

// Server-side sessions. The cookie carries only the id; the CSRF token is
// handed to the client through /api/me and must come back on every
// mutating request.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId), index("idx_sessions_expires").on(t.expiresAt)],
);
export type Session = typeof sessions.$inferSelect;

// Append-only. Who did what to what. Sign-ins start here; approvals, policy
// changes and brand-fact edits join in later phases.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actor: text("actor").notNull(), // an email, or "system:<job>"
    verb: text("verb").notNull(), // "login", "logout", "login_refused", ...
    subject: text("subject"), // what it was done to, when there is one
    data: jsonb("data").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_audit_events_at").on(t.at)],
);
export type AuditEvent = typeof auditEvents.$inferSelect;
