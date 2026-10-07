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

export class AnthropicAiClient implements AiClient {
  readonly isMock = false;
  private readonly client: Anthropic;
  constructor(
    private readonly db: Db,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async structured<T extends z.ZodType>(call: StructuredCall<T>, _mockFallback: () => z.infer<T>): Promise<StructuredResult<z.infer<T>>> {
    await assertBudget(this.db, call.brandId);
    const response = await this.client.messages.parse({
      model: call.model,
      max_tokens: call.maxTokens ?? 8000,
      system: call.system,
      messages: [{ role: "user", content: call.user }],
      output_config: { format: zodOutputFormat(call.schema) },
    });
    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const cost = costMicros(call.model, tokensIn, tokensOut);
    if (response.stop_reason === "refusal" || response.parsed_output === null || response.parsed_output === undefined) {
      await logRun(this.db, call, { output: null, errors: [{ stop_reason: response.stop_reason }], tokensIn, tokensOut, cost, model: call.model });
      throw new Error(`model returned no usable output (${response.stop_reason})`);
    }
    const parsed = call.schema.safeParse(response.parsed_output);
    if (!parsed.success) {
      await logRun(this.db, call, { output: response.parsed_output, errors: parsed.error.issues, tokensIn, tokensOut, cost, model: call.model });
      throw new Error("model output failed validation");
    }
    const runId = await logRun(this.db, call, { output: parsed.data, tokensIn, tokensOut, cost, model: call.model });
    return { data: parsed.data, runId, isMock: false, costMicros: cost };
  }
}

export function aiClientFor(db: Db, apiKey: string | undefined): AiClient {
  return apiKey && apiKey.trim() ? new AnthropicAiClient(db, apiKey.trim()) : new MockAiClient(db);
}
