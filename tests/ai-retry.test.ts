import { desc, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { AiOutputInvalid, AnthropicAiClient, type MessagesLike } from "../src/ai/client.js";
import { seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { aiRuns } from "../src/db/schema.js";
import { createApp } from "../src/app.js";
import { devLogin, makeContext } from "./helpers.js";

// The live client against a scripted model: the first answer overshoots a
// limit, the second obeys. Nothing here reaches Anthropic.

const schema = z.object({ headlines: z.array(z.string().max(30)).min(2) });

function scripted(answers: unknown[]): MessagesLike & { prompts: string[]; turns: number[] } {
  const prompts: string[] = [];
  const turns: number[] = [];
  return {
    prompts,
    turns,
    async create(params) {
      prompts.push(params.messages.map((m) => `${m.role}: ${m.content}`).join("\n"));
      turns.push(params.messages.length);
      const next = answers.shift();
      return { content: [{ type: "text", text: JSON.stringify(next) }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn" };
    },
  };
}

describe("live AI client: retry on invalid output", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  let brandId: string;
  beforeAll(async () => {
    brandId = (await seedTryoutBrain(db)).brandId;
  });
  afterAll(() => ctx.handle.close());

  const call = (fn: string) => ({ brandId, fn, promptVersion: "test.v1", model: "claude-sonnet-5-5", system: "s", user: "write two headlines", schema });

  it("sends the violations back once and accepts the corrected answer; both attempts are logged with cost", async () => {
    const model = scripted([{ headlines: ["short one", "this headline is far too long for the limit"] }, { headlines: ["short one", "fits now"] }]);
    const ai = new AnthropicAiClient(db, "not-a-real-key", model);
    const r = await ai.structured(call("creative"), () => ({ headlines: [] }));
    expect(r.data.headlines).toEqual(["short one", "fits now"]);
    expect(r.isMock).toBe(false);
    expect(model.prompts).toHaveLength(2);
    expect(model.turns).toEqual([1, 3]); // user; then user, the model's own answer, the complaint
    expect(model.prompts[1]).toContain("headlines.1: Too big");
    expect(model.prompts[1]).toContain("assistant: ");
    expect(model.prompts[1]).toContain("far too long for the limit"); // the first answer travels back verbatim
    expect(r.costMicros).toBe(2 * (100 * 2 + 20 * 10)); // both attempts, in USD micros at Sonnet's prices
    const runs = await db.select().from(aiRuns).where(eq(aiRuns.brandId, brandId)).orderBy(desc(aiRuns.createdAt)).limit(2);
    expect(runs.map((x) => x.validationErrors === null)).toEqual([true, false]); // the retry succeeded, the first attempt is kept with its errors
    expect(runs.every((x) => (x.costMicros ?? 0) > 0)).toBe(true);
  });

  it("gives up after the second bad answer with a typed error naming the issues", async () => {
    const model = scripted([{ headlines: ["x".repeat(40), "y"] }, { headlines: ["z".repeat(31), "y"] }]);
    const ai = new AnthropicAiClient(db, "not-a-real-key", model);
    await expect(ai.structured(call("creative"), () => ({ headlines: [] }))).rejects.toSatisfy((e: unknown) => e instanceof AiOutputInvalid && e.fn === "creative" && e.issues[0]!.startsWith("headlines.0"));
    expect(model.prompts).toHaveLength(2);
  });

  it("a refusal or non-JSON answer fails immediately, without a retry", async () => {
    const model: MessagesLike = { async create() { return { content: [{ type: "text", text: "I cannot do that" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "refusal" }; } };
    const ai = new AnthropicAiClient(db, "not-a-real-key", model);
    await expect(ai.structured(call("creative"), () => ({ headlines: [] }))).rejects.toThrow(/no usable output/);
  });

  it("the API answers 422 with the reason instead of a bare internal error", async () => {
    const model = scripted([{ headlines: ["x".repeat(40)] }, { headlines: ["x".repeat(40)] }]);
    const ai = new AnthropicAiClient(db, "not-a-real-key", model);
    const app = createApp({ config: ctx.config, db, ai });
    const { cookie, csrf } = await devLogin(app, "evan@example.com");
    // The analyze route runs the analyst through the same client; its schema is different, so the scripted answers fail it twice.
    const res = await request(app).post("/api/brands/tryoutbrain/analyze").set("Cookie", cookie).set("x-csrf-token", csrf);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/platform limits after a retry/);
  });
});
