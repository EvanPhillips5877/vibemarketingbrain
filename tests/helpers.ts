import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { IdentityProvider } from "../src/auth/google.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, type DbHandle } from "../src/db/client.js";

/** A fake Google: the "code" is the email to return; "unverified:" prefix flips emailVerified. */
export const fakeIdentity: IdentityProvider = {
  startUrl: (state, redirectUri) => `https://fake-google.test/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  async complete(code) {
    if (code === "boom") throw new Error("provider failure");
    const unverified = code.startsWith("unverified:");
    const email = unverified ? code.slice("unverified:".length) : code;
    return { email, emailVerified: !unverified, name: "Test Person" };
  },
};

export interface TestContext {
  app: Express;
  config: Config;
  handle: DbHandle;
}

export function makeContext(overrides: Partial<NodeJS.ProcessEnv> = {}, identity: IdentityProvider | null = fakeIdentity): TestContext {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const config = loadConfig(env);
  const handle = createDb(config.databaseUrl);
  const app = createApp({ config, db: handle.db, identity });
  return { app, config, handle };
}

/** Sign in through the dev route and return the cookie + CSRF token. */
export async function devLogin(app: Express, email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app).post("/auth/dev-login").send({ email });
  if (res.status !== 200) throw new Error(`dev login failed: ${res.status} ${res.text}`);
  const cookie = cookieFrom(res);
  const me = await request(app).get("/api/me").set("Cookie", cookie);
  return { cookie, csrf: me.body.csrfToken as string };
}

export function cookieFrom(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}
