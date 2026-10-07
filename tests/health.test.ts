import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { makeContext } from "./helpers.js";

describe("app basics", () => {
  const ctx = makeContext();
  afterAll(() => ctx.handle.close());

  it("answers /health without a session", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, env: "test" });
  });

  it("returns JSON 404 for unknown /api routes", async () => {
    const res = await request(ctx.app).get("/api/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("does not advertise the framework", async () => {
    const res = await request(ctx.app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
