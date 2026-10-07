import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { devLogin, makeContext } from "./helpers.js";

describe("brands API", () => {
  const ctx = makeContext();
  let cookie = "";
  beforeAll(async () => {
    await seedTryoutBrain(ctx.handle.db);
    cookie = (await devLogin(ctx.app, "evan@example.com")).cookie;
  });
  afterAll(() => ctx.handle.close());

  it("requires a session", async () => {
    expect((await request(ctx.app).get("/api/brands")).status).toBe(401);
    expect((await request(ctx.app).get("/api/brands/tryoutbrain")).status).toBe(401);
  });

  it("lists brands with the policy in force", async () => {
    const res = await request(ctx.app).get("/api/brands").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].brand.slug).toBe("tryoutbrain");
    expect(res.body.brands[0].policy).toMatchObject({ version: 1, level: "approve" });
  });

  it("returns a brand with facts and the full policy", async () => {
    const res = await request(ctx.app).get("/api/brands/tryoutbrain").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.policy.rules.actionModes.CREATE_CREATIVE).toBe("auto");
    expect(res.body.policy.rules.actionModes.CHANGE_BUDGET).toBe("approve");
    expect(res.body.facts.some((f: { category: string }) => f.category === "prohibited_claim")).toBe(true);
  });

  it("404s for unknown or malformed slugs", async () => {
    expect((await request(ctx.app).get("/api/brands/nope").set("Cookie", cookie)).status).toBe(404);
    expect((await request(ctx.app).get("/api/brands/Bad%20Slug").set("Cookie", cookie)).status).toBe(404);
  });
});
