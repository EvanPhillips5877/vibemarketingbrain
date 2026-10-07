import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://test:test@localhost:5432/x",
  APP_SECRET: "test-suite-secret-not-real-0123",
  ALLOWED_EMAILS: "A@b.com ,c@d.com,,",
};

describe("loadConfig", () => {
  it("normalizes the allowlist and defaults to dev auth and full mock mode", () => {
    const c = loadConfig(base);
    expect(c.allowedEmails).toEqual(["a@b.com", "c@d.com"]);
    expect(c.auth.mode).toBe("dev");
    expect(c.mock).toEqual({ ai: true, meta: true, googleAds: true });
    expect(c.jobsEnabled).toBe(false);
  });

  it("switches to Google auth when both client values are present", () => {
    const c = loadConfig({ ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
    expect(c.auth).toEqual({ mode: "google", clientId: "id", clientSecret: "secret" });
  });

  it("treats a blank key as absent", () => {
    const c = loadConfig({ ...base, ANTHROPIC_API_KEY: "  ", META_ACCESS_TOKEN: "tok" });
    expect(c.mock.ai).toBe(true);
    expect(c.mock.meta).toBe(false);
  });

  it("refuses production without Google sign-in", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("refuses production with an empty allowlist", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", ALLOWED_EMAILS: "", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }),
    ).toThrow(/ALLOWED_EMAILS/);
  });

  it("rejects a short APP_SECRET and a missing DATABASE_URL", () => {
    expect(() => loadConfig({ ...base, APP_SECRET: "short" })).toThrow(/APP_SECRET/);
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});
