import { createHash } from "node:crypto";
import type { AdapterCommand } from "../../domain/actions.js";
import { adapterCommandSchema } from "../../domain/actions.js";
import { FORMAT_SPECS } from "../../creative/formats.js";
import type { ExtObjectKind } from "../../db/schema.js";
import { getSecret } from "../../secrets.js";
import type { AccountRef, Capability, ChannelAdapter, CreativeFormatSpec, ExecResult, ExtObjectInput, MetricRow, ValidationResult } from "../adapter.js";
import { redact } from "../adapter.js";
import { GraphClient, MetaApiError, type GraphOptions } from "./graph.js";

// The Meta adapter, Phase 4: reads. Structure (campaigns → ad sets → ads)
// and daily insights at ad level. Writes are Phase 12; until then the
// capabilities say so and execute() refuses, so no code path can reach
// the ad account's spend from here. The token is resolved from the
// account's secret ref at call time and never stored on the adapter.

export const CAMPAIGN_FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget,objective,bid_strategy,created_time,updated_time";
export const ADSET_FIELDS = "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,created_time,updated_time";
export const AD_FIELDS = "id,name,status,effective_status,adset_id,creative{id,name,object_story_spec},created_time,updated_time";
export const INSIGHT_FIELDS = "ad_id,adset_id,campaign_id,date_start,impressions,clicks,inline_link_clicks,spend,reach,frequency,actions";

/**
 * What counts as a registration for us. Meta reports "lead" and
 * "complete_registration" as aggregates of their component action types,
 * so a component is counted only when its aggregate is absent; adding both
 * would count the same event twice.
 */
const REGISTRATION_AGGREGATES: Record<string, string[]> = {
  lead: ["offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped", "leadgen_grouped"],
  complete_registration: ["offsite_conversion.fb_pixel_complete_registration"],
};

/** Meta's effective_status → the six statuses the rest of the system understands. */
export function normalizeStatus(effective: string | undefined, configured: string | undefined): string {
  const s = (effective ?? configured ?? "").toUpperCase();
  if (s === "ACTIVE") return "ACTIVE";
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED" || s === "ADSET_PAUSED") return "PAUSED";
  if (s === "DELETED" || s === "ARCHIVED") return "REMOVED";
  if (s === "PENDING_REVIEW" || s === "IN_PROCESS" || s === "PENDING_BILLING_INFO" || s === "PREAPPROVED") return "PENDING_REVIEW";
  if (s === "DISAPPROVED" || s === "WITH_ISSUES") return "DISAPPROVED";
  return "OTHER";
}

/** Meta budgets are strings in the account currency's minor unit (cents). */
export function minorToMicros(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10_000) : null;
}

/** Insights spend is a decimal string in the account currency. */
export function spendToMicros(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
}

/** Short, stable marker written into a created object's name so a timed-out create can be found again. */
export function idempotencyTag(key: string): string {
  return `#${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

export function actionsToConversions(actions: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(actions)) return out;
  for (const a of actions as { action_type?: string; value?: string }[]) {
    if (!a?.action_type) continue;
    const n = Number(a.value ?? 0);
    if (!Number.isFinite(n)) continue;
    out[a.action_type] = (out[a.action_type] ?? 0) + n;
  }
  let registration = 0;
  for (const [aggregate, components] of Object.entries(REGISTRATION_AGGREGATES)) {
    if (out[aggregate] !== undefined) registration += out[aggregate];
    else for (const c of components) registration += out[c] ?? 0;
  }
  if (registration > 0) out["registration"] = registration;
  return out;
}

export interface MetaAdapterOptions {
  version?: string;
  fetchImpl?: typeof fetch;
  sleep?: GraphOptions["sleep"];
  env?: NodeJS.ProcessEnv;
}

export class MetaAdapter implements ChannelAdapter {
  readonly channel = "meta" as const;
  readonly isMock = false;
  // Writes arrive with Phase 12; declaring only what exists keeps the engine honest.
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(["read_structure", "read_metrics", "image_ads"]);
  private readonly clients = new Map<string, GraphClient>();

  constructor(private readonly opts: MetaAdapterOptions = {}) {}

  private client(account: AccountRef): GraphClient {
    const token = getSecret(account.secretRef, this.opts.env);
    if (!token) throw new Error(`Meta account ${account.externalAccountId}: no token under secret ref ${account.secretRef ?? "(none)"}`);
    // Keyed by account and by the token itself, so a rotated secret gets a fresh client instead of the old one failing forever.
    const cacheKey = `${account.id}:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
    let c = this.clients.get(cacheKey);
    if (!c) {
      for (const k of this.clients.keys()) if (k.startsWith(`${account.id}:`)) this.clients.delete(k);
      c = new GraphClient({ token, ...(this.opts.version ? { version: this.opts.version } : {}), ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
      this.clients.set(cacheKey, c);
    }
    return c;
  }

  /** For tests and diagnostics: the client's call/backoff counters for an account. */
  statsFor(account: AccountRef): GraphClient["stats"] | null {
    for (const [k, c] of this.clients) if (k.startsWith(`${account.id}:`)) return c.stats;
    return null;
  }

  private act(account: AccountRef): string {
    return account.externalAccountId.startsWith("act_") ? account.externalAccountId : `act_${account.externalAccountId}`;
  }

  /** Currency and timezone as the platform states them; the seed uses this so the mirror never guesses. */
  async describeAccount(account: AccountRef): Promise<{ name: string; currency: string; timezone: string; status: number }> {
    const r = await this.client(account).get<{ name: string; currency: string; timezone_name: string; account_status: number }>(this.act(account), { fields: "name,currency,timezone_name,account_status" });
    return { name: r.name, currency: r.currency, timezone: r.timezone_name, status: r.account_status };
  }

  private campaignInput(c: Record<string, unknown>): ExtObjectInput {
    return {
      kind: "campaign",
      externalId: String(c["id"]),
      parentExternalId: null,
      name: (c["name"] as string | undefined) ?? null,
      status: normalizeStatus(c["effective_status"] as string | undefined, c["status"] as string | undefined),
      dailyBudgetMicros: minorToMicros(c["daily_budget"]),
      settings: { objective: c["objective"] ?? null, bidStrategy: c["bid_strategy"] ?? null, effectiveStatus: c["effective_status"] ?? null, lifetimeBudgetMicros: minorToMicros(c["lifetime_budget"]) },
      raw: redact(c),
    };
  }

  private adsetInput(g: Record<string, unknown>): ExtObjectInput {
    const targeting = (g["targeting"] as { geo_locations?: { countries?: string[] } } | undefined) ?? {};
    return {
      kind: "ad_group",
      externalId: String(g["id"]),
      parentExternalId: g["campaign_id"] ? String(g["campaign_id"]) : null,
      name: (g["name"] as string | undefined) ?? null,
      status: normalizeStatus(g["effective_status"] as string | undefined, g["status"] as string | undefined),
      dailyBudgetMicros: minorToMicros(g["daily_budget"]),
      settings: { geos: targeting.geo_locations?.countries ?? [], optimizationGoal: g["optimization_goal"] ?? null, billingEvent: g["billing_event"] ?? null, effectiveStatus: g["effective_status"] ?? null, lifetimeBudgetMicros: minorToMicros(g["lifetime_budget"]) },
      raw: redact(g),
    };
  }

  private adInput(a: Record<string, unknown>): ExtObjectInput {
    const creative = (a["creative"] as { id?: string; object_story_spec?: { link_data?: { link?: string } } } | undefined) ?? {};
    return {
      kind: "ad",
      externalId: String(a["id"]),
      parentExternalId: a["adset_id"] ? String(a["adset_id"]) : null,
      name: (a["name"] as string | undefined) ?? null,
      status: normalizeStatus(a["effective_status"] as string | undefined, a["status"] as string | undefined),
      dailyBudgetMicros: null,
      settings: { creativeId: creative.id ?? null, landingUrl: creative.object_story_spec?.link_data?.link ?? null, effectiveStatus: a["effective_status"] ?? null },
      raw: redact(a),
    };
  }

  async *syncStructure(account: AccountRef): AsyncIterable<ExtObjectInput> {
    const g = this.client(account);
    const act = this.act(account);
    for await (const c of g.paginate<Record<string, unknown>>(`${act}/campaigns`, { fields: CAMPAIGN_FIELDS })) yield this.campaignInput(c);
    for await (const s of g.paginate<Record<string, unknown>>(`${act}/adsets`, { fields: ADSET_FIELDS })) yield this.adsetInput(s);
    for await (const a of g.paginate<Record<string, unknown>>(`${act}/ads`, { fields: AD_FIELDS })) yield this.adInput(a);
  }

  async *fetchDailyMetrics(account: AccountRef, fromDate: string, toDate: string): AsyncIterable<MetricRow> {
    const g = this.client(account);
    const rows = g.paginate<Record<string, unknown>>(`${this.act(account)}/insights`, {
      level: "ad",
      fields: INSIGHT_FIELDS,
      time_increment: 1,
      time_range: JSON.stringify({ since: fromDate, until: toDate }),
      limit: 500,
    });
    for await (const r of rows) {
      const date = String(r["date_start"] ?? "");
      if (date < fromDate || date > toDate) continue; // Meta's window is inclusive; never trust it blindly
      const impressions = Number(r["impressions"] ?? 0) || 0;
      const linkClicks = r["inline_link_clicks"] === undefined ? null : Number(r["inline_link_clicks"]);
      const allClicks = Number(r["clicks"] ?? 0) || 0;
      const clicks = Math.min(impressions, linkClicks !== null && Number.isFinite(linkClicks) ? linkClicks : allClicks);
      const frequency = r["frequency"] === undefined ? null : Number(r["frequency"]);
      const reach = r["reach"] === undefined ? null : Number(r["reach"]);
      yield {
        externalId: String(r["ad_id"]),
        kind: "ad",
        date,
        impressions,
        clicks: Math.max(0, clicks),
        spendMicros: spendToMicros(r["spend"]),
        platformConversions: actionsToConversions(r["actions"]),
        frequency: frequency !== null && Number.isFinite(frequency) ? Math.round(frequency * 100) / 100 : null,
        reach: reach !== null && Number.isFinite(reach) ? reach : null,
        raw: { allClicks, linkClicks, adsetId: r["adset_id"] ?? null, campaignId: r["campaign_id"] ?? null },
      };
    }
  }

  async validate(_account: AccountRef, command: AdapterCommand): Promise<ValidationResult> {
    const parsed = adapterCommandSchema.safeParse(command);
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    return { ok: false, errors: [`Meta writes are not available yet (Phase 12): ${parsed.data.type} refused`] };
  }

  async execute(account: AccountRef, command: AdapterCommand): Promise<ExecResult> {
    const v = await this.validate(account, command);
    throw new Error(`meta adapter refused: ${v.errors.join("; ")}`);
  }

  private edgeFor(kind: ExtObjectKind): { edge: string; fields: string; map: (o: Record<string, unknown>) => ExtObjectInput } | null {
    if (kind === "campaign") return { edge: "campaigns", fields: CAMPAIGN_FIELDS, map: (o) => this.campaignInput(o) };
    if (kind === "ad_group") return { edge: "adsets", fields: ADSET_FIELDS, map: (o) => this.adsetInput(o) };
    if (kind === "ad") return { edge: "ads", fields: AD_FIELDS, map: (o) => this.adInput(o) };
    return null;
  }

  /** Created objects carry a name marker derived from the key; Meta's name filter finds them again. */
  async findByIdempotencyKey(account: AccountRef, kind: ExtObjectKind, idempotencyKey: string): Promise<ExtObjectInput | null> {
    const e = this.edgeFor(kind);
    if (!e) return null;
    const tag = idempotencyTag(idempotencyKey);
    const g = this.client(account);
    for await (const o of g.paginate<Record<string, unknown>>(`${this.act(account)}/${e.edge}`, { fields: e.fields, filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: tag }]) })) {
      const name = String(o["name"] ?? "");
      if (name.includes(tag)) return e.map(o);
    }
    return null;
  }

  async fetchObject(account: AccountRef, kind: ExtObjectKind, externalId: string): Promise<ExtObjectInput | null> {
    const e = this.edgeFor(kind);
    if (!e) return null;
    try {
      const o = await this.client(account).get<Record<string, unknown>>(externalId, { fields: e.fields });
      return e.map(o);
    } catch (err) {
      if (err instanceof MetaApiError && err.isMissing) return null;
      throw err;
    }
  }

  formatSpec(format: string): CreativeFormatSpec | null {
    return format === "meta_image" ? FORMAT_SPECS.meta_image : null;
  }
}
