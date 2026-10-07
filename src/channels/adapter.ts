import type { AdapterCommand } from "../domain/actions.js";
import type { Channel, ExtObjectKind } from "../db/schema.js";

// The one seam between MarketingBrain and an advertising platform. The rest
// of the system talks only to this interface; Meta, Google, Reddit and the
// mock each implement it. tests/adapters.contract.test.ts is the contract.

export interface AccountRef {
  /** channel_accounts.id */
  id: string;
  channel: Channel;
  externalAccountId: string;
  currency: string;
  timezone: string;
  /** Name of the secret holding credentials; the adapter resolves it. Null for mock. */
  secretRef: string | null;
}

/** A platform object as the adapter sees it. Ingest upserts it into ext_objects. */
export interface ExtObjectInput {
  kind: ExtObjectKind;
  externalId: string;
  parentExternalId: string | null;
  name: string | null;
  /** Platform status, normalized: ACTIVE | PAUSED | REMOVED | PENDING_REVIEW | DISAPPROVED | OTHER */
  status: string;
  dailyBudgetMicros: number | null;
  settings: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** One object, one day. `date` is YYYY-MM-DD in the account's timezone. */
export interface MetricRow {
  externalId: string;
  kind: ExtObjectKind;
  date: string;
  impressions: number;
  clicks: number;
  spendMicros: number;
  platformConversions: Record<string, number>;
  frequency: number | null;
  reach: number | null;
  raw: Record<string, unknown>;
}

export type Capability =
  | "read_structure"
  | "read_metrics"
  | "pause_activate"
  | "change_budget"
  | "create_campaign"
  | "create_ad_group"
  | "create_ad"
  | "negative_keywords"
  | "image_ads"
  | "video_ads"
  | "search_ads";

/** Limits the Creative Factory must respect for a format on this channel. */
export interface CreativeFormatSpec {
  format: string;
  textFields: { name: string; maxChars: number; min?: number; max?: number }[];
  imageAspectRatios: string[]; // e.g. ["1:1", "4:5", "9:16", "16:9"]
  landingUrlMacro: string; // what the adapter appends to fill utm_content etc.
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ExecResult {
  /** External ids created or touched, by role (campaign, ad_group, ad, ...). */
  externalIds: Record<string, string>;
  /** The adapter's raw response, redacted. */
  response: Record<string, unknown>;
  /** The inverse, when the adapter can express it (previous budget, previous status). */
  rollback: AdapterCommand | null;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  /** True when this adapter never talks to a real platform. Shown in the UI. */
  readonly isMock: boolean;
  readonly capabilities: ReadonlySet<Capability>;

  syncStructure(account: AccountRef): AsyncIterable<ExtObjectInput>;
  fetchDailyMetrics(account: AccountRef, fromDate: string, toDate: string): AsyncIterable<MetricRow>;

  /** Dry run. Must not change anything on the platform. */
  validate(account: AccountRef, command: AdapterCommand): Promise<ValidationResult>;
  /** Performs the command. Creates are always PAUSED. Throws on transport failure. */
  execute(account: AccountRef, command: AdapterCommand): Promise<ExecResult>;
  /** After a timeout: did a create of this kind with this key already land? */
  findByIdempotencyKey(account: AccountRef, kind: ExtObjectKind, idempotencyKey: string): Promise<ExtObjectInput | null>;
  /** One object's live state, or null if the platform no longer has it. */
  fetchObject(account: AccountRef, kind: ExtObjectKind, externalId: string): Promise<ExtObjectInput | null>;

  formatSpec(format: string): CreativeFormatSpec | null;
}

/** Strips anything that looks like a credential before a response is stored or logged. */
export function redact<T>(value: T): T {
  const SECRET_KEY = /(access[_-]?token|authorization|developer[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password)/i;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? "[redacted]" : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
