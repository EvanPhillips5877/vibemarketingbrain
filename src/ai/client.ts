import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, gte, sql } from "drizzle-orm";
// The SDK's structured-output helper speaks zod v4; schemas handed to this
// client are built with `zod/v4` (see brands/extract.ts).
import type { z } from "zod/v4";
import type { Db } from "../db/client.js";
import { aiRuns } from "../db/schema.js";
import { currentPolicy } from "../brands/queries.js";

// The one door to the model. Every call is a structured-output call
// validated by zod, logged to ai_runs with its cost, and refused when the
// brand's monthly AI budget is spent. There is no mock *model*: in mock
// mode each caller supplies a deterministic fallback, clearly labelled.
//
// Nothing here can reach an advertising API; the model's only effect on
// the world is the parsed object handed back to the caller.

export const MODELS = {
  extract: "claude-haiku-5-5",
  creative: "claude-sonnet-5-5",
  analyst: "claude-opus-5-5",
  strategist: "claude-opus-5-5",
  command: "claude-sonnet-5-5",
  commandWhy: "claude-opus-5-5",
} as const;

// USD per million tokens (input, output). Cost is tracked in USD micros.
const PRICE_USD_PER_MTOK: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const [inPrice, outPrice] = PRICE_USD_PER_MTOK[model] ?? [4, 20];
  return Math.round((inputTokens * inPrice + outputTokens * outPrice) / 1_000_000 * 1_000_000);
}

/** The model's answer broke the schema twice; the caller decides what that means for the person. */
export class AiOutputInvalid extends Error {
  constructor(
    public readonly fn: string,
    public readonly issues: string[],
    public readonly runId: string,
  ) {
    super(`model output failed validation after a retry (${fn}): ${issues.slice(0, 5).join("; ")}`);
    this.name = "AiOutputInvalid";
  }
}

export class AiBudgetExceeded extends Error {
  constructor(public readonly spentMicros: number, public readonly budgetMicros: number) {
    super(`monthly AI budget spent: ${spentMicros} of ${budgetMicros} micros`);
  }
}

export interface StructuredCall<T extends z.ZodType> {
  brandId: string | null;
  fn: keyof typeof MODELS | string;
  promptVersion: string;
  model: string;
  system: string;
  user: string;
  schema: T;
  inputRefs?: Record<string, unknown>;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  runId: string;
  isMock: boolean;
  costMicros: number;
}

export interface AiClient {
  readonly isMock: boolean;
  /** Validated structured output, or the mock fallback when there is no model. */
  structured<T extends z.ZodType>(call: StructuredCall<T>, mockFallback: () => z.infer<T>): Promise<StructuredResult<z.infer<T>>>;
}

/** USD micros spent by a brand since the first of the month (UTC). */
export async function monthSpendMicros(db: Db, brandId: string): Promise<number> {
  const [row] = await db
    .select({ s: sql<number>`coalesce(sum(${aiRuns.costMicros}), 0)::bigint` })
    .from(aiRuns)
    .where(and(eq(aiRuns.brandId, brandId), gte(aiRuns.createdAt, sql`date_trunc('month', now())`)));
  return Number(row?.s ?? 0);
}

async function assertBudget(db: Db, brandId: string | null): Promise<void> {
  if (!brandId) return;
  const policy = await currentPolicy(db, brandId);
  if (!policy) return;
  const spent = await monthSpendMicros(db, brandId);
  if (spent >= policy.rules.monthlyAiBudgetMicros) throw new AiBudgetExceeded(spent, policy.rules.monthlyAiBudgetMicros);
}

async function logRun(db: Db, call: StructuredCall<z.ZodType>, out: { output: unknown; errors?: unknown[]; tokensIn: number; tokensOut: number; cost: number; model: string }): Promise<string> {
  const [row] = await db
    .insert(aiRuns)
    .values({
      brandId: call.brandId,
      fn: String(call.fn),
      promptVersion: call.promptVersion,
      model: out.model,
      inputRefs: call.inputRefs ?? {},
      output: (out.output ?? null) as Record<string, unknown> | null,
      validationErrors: out.errors ?? null,
      tokensIn: out.tokensIn,
      tokensOut: out.tokensOut,
      costMicros: out.cost,
    })
    .returning({ id: aiRuns.id });
  return row!.id;
}

export class MockAiClient implements AiClient {
  readonly isMock = true;
  constructor(private readonly db: Db) {}
  async structured<T extends z.ZodType>(call: StructuredCall<T>, mockFallback: () => z.infer<T>): Promise<StructuredResult<z.infer<T>>> {
    await assertBudget(this.db, call.brandId);
    const data = call.schema.parse(mockFallback());
    const runId = await logRun(this.db, call, { output: data, tokensIn: 0, tokensOut: 0, cost: 0, model: "mock" });
    return { data, runId, isMock: true, costMicros: 0 };
  }
}

/** The slice of the SDK this client uses, so tests can hand in a fake. */
export interface MessagesLike {
  create(params: { model: string; max_tokens: number; system: string; messages: { role: "user" | "assistant"; content: string }[]; output_config: { format: unknown } }): Promise<{ content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number }; stop_reason: string | null }>;
}

const issueLines = (issues: { path: PropertyKey[]; message: string }[]): string[] => issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

export class AnthropicAiClient implements AiClient {
  readonly isMock = false;
  private readonly messages: MessagesLike;
  constructor(
    private readonly db: Db,
    apiKey: string,
    messages?: MessagesLike,
  ) {
    this.messages = messages ?? (new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }).messages as unknown as MessagesLike);
  }

  /**
   * One structured call with one retry. The model is given the schema as
   * the output format, but a length limit it overshoots is reported back
   * once, verbatim, before the call is declared failed. Both attempts are
   * logged to ai_runs with their cost.
   */
  async structured<T extends z.ZodType>(call: StructuredCall<T>, _mockFallback: () => z.infer<T>): Promise<StructuredResult<z.infer<T>>> {
    await assertBudget(this.db, call.brandId);
    const format = zodOutputFormat(call.schema);
    let complaints: string[] | null = null;
    let previousAnswer: string | null = null;
    let lastRunId = "";
    let totalCost = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The retry carries the first answer as the assistant's own turn, so "keep everything else" has something to keep.
      const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: call.user }];
      if (complaints && previousAnswer !== null) {
        messages.push({ role: "assistant", content: previousAnswer });
        messages.push({ role: "user", content: `That answer was rejected for these reasons; fix every one and keep everything else:\n${complaints.map((c) => `- ${c}`).join("\n")}` });
      }
      const response = await this.messages.create({
        model: call.model,
        max_tokens: call.maxTokens ?? 8000,
        system: call.system,
        messages,
        output_config: { format },
      });
      const tokensIn = response.usage.input_tokens;
      const tokensOut = response.usage.output_tokens;
      const cost = costMicros(call.model, tokensIn, tokensOut);
      totalCost += cost;
      const text = response.content.find((b) => b.type === "text")?.text ?? null;
      let raw: unknown = null;
      try {
        raw = text === null ? null : JSON.parse(text);
      } catch {
        raw = null;
      }
      if (response.stop_reason === "refusal" || raw === null) {
        await logRun(this.db, call, { output: null, errors: [{ stop_reason: response.stop_reason, text: text?.slice(0, 500) ?? null }], tokensIn, tokensOut, cost, model: call.model });
        throw new Error(`model returned no usable output (${response.stop_reason})`);
      }
      const parsed = call.schema.safeParse(raw);
      if (parsed.success) {
        const runId = await logRun(this.db, call, { output: parsed.data, tokensIn, tokensOut, cost, model: call.model });
        return { data: parsed.data, runId, isMock: false, costMicros: totalCost };
      }
      complaints = issueLines(parsed.error.issues as { path: PropertyKey[]; message: string }[]);
      previousAnswer = text;
      lastRunId = await logRun(this.db, call, { output: raw as Record<string, unknown>, errors: parsed.error.issues, tokensIn, tokensOut, cost, model: call.model });
    }
    throw new AiOutputInvalid(String(call.fn), complaints ?? [], lastRunId);
  }
}

export function aiClientFor(db: Db, apiKey: string | undefined): AiClient {
  return apiKey && apiKey.trim() ? new AnthropicAiClient(db, apiKey.trim()) : new MockAiClient(db);
}
