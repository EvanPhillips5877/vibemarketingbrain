import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { auditEvents, sessions, users } from "../src/db/schema.js";
import { cookieFrom, devLogin, makeContext } from "./helpers.js";

describe("sessions and allowlist (dev mode)", () => {
  const ctx = makeContext();
  afterAll(() => ctx.handle.close());

  it("rejects /api/me without a session", async () => {
    const res = await request(ctx.app).get("/api/me");
    expect(res.status).toBe(401);
  });

  it("refuses an address that is not on the allowlist, and audits it", async () => {
    const res = await request(ctx.app).post("/auth/dev-login").send({ email: "stranger@example.com" });
    expect(res.status).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
    const rows = await ctx.handle.db.select().from(auditEvents).where(eq(auditEvents.actor, "stranger@example.com"));
    expect(rows.map((r) => r.verb)).toEqual(["login_refused"]);
  });

  it("rejects a malformed email", async () => {
    const res = await request(ctx.app).post("/auth/dev-login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("signs in an allowlisted address case-insensitively and serves /api/me", async () => {
    const { cookie, csrf } = await devLogin(ctx.app, "SECOND@example.com");
    expect(cookie).toMatch(/^mb_session=/);
    const me = await request(ctx.app).get("/api/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("second@example.com");
    expect(me.body.authMode).toBe("dev");
    expect(me.body.mock).toEqual({ ai: true, meta: true, googleAds: true });
    expect(csrf).toHaveLength(32);
  });

  it("sets an httpOnly, SameSite=Lax cookie", async () => {
    const res = await request(ctx.app).post("/auth/dev-login").send({ email: "evan@example.com" });
    const raw = String(res.headers["set-cookie"]);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it("blocks mutations without the CSRF header and allows them with it", async () => {
    const { cookie, csrf } = await devLogin(ctx.app, "evan@example.com");
    const noHeader = await request(ctx.app).post("/auth/logout").set("Cookie", cookie);
    expect(noHeader.status).toBe(403);
    const wrong = await request(ctx.app).post("/auth/logout").set("Cookie", cookie).set("x-csrf-token", "nope");
    expect(wrong.status).toBe(403);
    const ok = await request(ctx.app).post("/auth/logout").set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(ok.status).toBe(200);
    const after = await request(ctx.app).get("/api/me").set("Cookie", cookie);
    expect(after.status).toBe(401);
  });

  it("ignores a session past its expiry", async () => {
    const { cookie } = await devLogin(ctx.app, "evan@example.com");
    const id = cookie.replace("mb_session=", "");
    await ctx.handle.db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(sessions.id, id));
    const res = await request(ctx.app).get("/api/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("ignores a forged session id", async () => {
    const res = await request(ctx.app).get("/api/me").set("Cookie", "mb_session=forged-value");
    expect(res.status).toBe(401);
  });

  it("ends an existing session once its address leaves the allowlist", async () => {
    const { cookie } = await devLogin(ctx.app, "second@example.com");
    // Same database, new process configuration without that address.
    const narrowed = makeContext({ ALLOWED_EMAILS: "evan@example.com" });
    try {
      // Several requests in flight at once: every one is refused, one audit row.
      const burst = await Promise.all([1, 2, 3, 4].map(() => request(narrowed.app).get("/api/me").set("Cookie", cookie)));
      expect(burst.map((r) => r.status)).toEqual([401, 401, 401, 401]);
      const revoked = await ctx.handle.db.select().from(auditEvents).where(eq(auditEvents.verb, "session_revoked"));
      expect(revoked).toHaveLength(1);
      const res = await request(narrowed.app).get("/api/me").set("Cookie", cookie);
      expect(res.status).toBe(401);
      // The session row is gone, so the old configuration cannot resurrect it either.
      const again = await request(ctx.app).get("/api/me").set("Cookie", cookie);
      expect(again.status).toBe(401);
      const audit = await ctx.handle.db.select().from(auditEvents).where(eq(auditEvents.verb, "session_revoked"));
      expect(audit.at(-1)?.data).toMatchObject({ reason: "removed from allowlist", email: "second@example.com" });
    } finally {
      await narrowed.handle.close();
    }
  });

  it("keeps one user row per address across sign-ins", async () => {
    await devLogin(ctx.app, "evan@example.com");
    await devLogin(ctx.app, "Evan@Example.com");
    const rows = await ctx.handle.db.select().from(users).where(eq(users.email, "evan@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastLoginAt).not.toBeNull();
  });
});

describe("Google sign-in flow (fake provider)", () => {
  const ctx = makeContext({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" });
  afterAll(() => ctx.handle.close());

  it("has no dev-login route in google mode", async () => {
    const res = await request(ctx.app).post("/auth/dev-login").send({ email: "evan@example.com" });
    expect(res.status).toBe(404);
  });

  it("redirects to the provider with a signed state cookie", async () => {
    const res = await request(ctx.app).get("/auth/google");
    expect(res.status).toBe(302);
    const location = new URL(res.headers["location"] as string);
    expect(location.hostname).toBe("fake-google.test");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:5100/auth/google/callback");
    const state = location.searchParams.get("state")!;
    expect(cookieFrom(res)).toBe(`mb_oauth_state=${encodeURIComponent(state)}`);
  });

  async function start() {
    const res = await request(ctx.app).get("/auth/google");
    const state = new URL(res.headers["location"] as string).searchParams.get("state")!;
    return { state, cookie: cookieFrom(res) };
  }

  it("completes sign-in for an allowlisted, verified identity", async () => {
    const { state, cookie } = await start();
    const res = await request(ctx.app).get("/auth/google/callback").query({ code: "evan@example.com", state }).set("Cookie", cookie);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/");
    const session = cookieFrom(res)
      .split("; ")
      .find((c) => c.startsWith("mb_session="));
    expect(session).toBeDefined();
    const me = await request(ctx.app).get("/api/me").set("Cookie", session!);
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe("Test Person");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const { cookie } = await start();
    const res = await request(ctx.app).get("/auth/google/callback").query({ code: "evan@example.com", state: "tampered" }).set("Cookie", cookie);
    expect(res.status).toBe(400);
    expect(res.headers["set-cookie"]?.toString() ?? "").not.toMatch(/mb_session=[^;]+[^=;]/);
  });

  it("rejects a callback without the state cookie", async () => {
    const { state } = await start();
    const res = await request(ctx.app).get("/auth/google/callback").query({ code: "evan@example.com", state });
    expect(res.status).toBe(400);
  });

  it("refuses an unverified email even when allowlisted", async () => {
    const { state, cookie } = await start();
    const res = await request(ctx.app)
      .get("/auth/google/callback")
      .query({ code: "unverified:evan@example.com", state })
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("refuses a verified identity that is not allowlisted", async () => {
    const { state, cookie } = await start();
    const res = await request(ctx.app).get("/auth/google/callback").query({ code: "stranger@example.com", state }).set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("answers 500 without leaking the error when the provider fails", async () => {
    const { state, cookie } = await start();
    const res = await request(ctx.app).get("/auth/google/callback").query({ code: "boom", state }).set("Cookie", cookie);
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/provider failure/);
  });
});
