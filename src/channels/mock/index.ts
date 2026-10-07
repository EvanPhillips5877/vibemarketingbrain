import { createHash } from "node:crypto";
import type { AdapterCommand } from "../../domain/actions.js";
import { adapterCommandSchema } from "../../domain/actions.js";
import type {
  AccountRef,
  Capability,
  ChannelAdapter,
  CreativeFormatSpec,
  ExecResult,
  ExtObjectInput,
  MetricRow,
  ValidationResult,
} from "../adapter.js";

// A pretend ad platform with a fixture account. Deterministic: the same
// account id and date always produce the same numbers, so tests and the
// dashboard are reproducible. State created by execute() lives in memory
// for the process; sync afterwards sees it, as it would on a real platform.

interface MockObject extends ExtObjectInput {
  idempotencyKey?: string;
  /** Day the object came into being; nothing delivers before it. Fixture objects: the epoch. */
  createdOn: string;
  /** Closed or open pause intervals [from, to). `to` null = still paused. Delivery history is derived, never rewritten. */
  pauses: { from: string; to: string | null }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const EPOCH = "1970-01-01";
const alwaysPaused = (): MockObject["pauses"] => [{ from: EPOCH, to: null }];

interface MockAccountState {
  objects: Map<string, MockObject>; // keyed by `${kind}:${externalId}`
  negativeKeywords: { campaignExternalId: string; keyword: string; matchType: string }[];
  nextId: number;
}

const key = (kind: string, externalId: string) => `${kind}:${externalId}`;

// A small integer from a string, stable across runs.
function hashInt(s: string, mod: number): number {
  const h = createHash("sha256").update(s).digest();
  return h.readUInt32BE(0) % mod;
}

function fixture(accountId: string): MockAccountState {
  const objects = new Map<string, MockObject>();
  const put = (o: MockObject) => objects.set(key(o.kind, o.externalId), o);
  put({ kind: "campaign", externalId: `${accountId}-c1`, parentExternalId: null, name: "Spring tryouts - CA", status: "ACTIVE", dailyBudgetMicros: 30_000_000, settings: { objective: "registrations", geos: ["CA"] }, raw: {}, createdOn: EPOCH, pauses: [] });
  put({ kind: "campaign", externalId: `${accountId}-c2`, parentExternalId: null, name: "Volleyball clubs - US", status: "PAUSED", dailyBudgetMicros: 15_000_000, settings: { objective: "registrations", geos: ["US"] }, raw: {}, createdOn: EPOCH, pauses: alwaysPaused() });
  put({ kind: "ad_group", externalId: `${accountId}-g1`, parentExternalId: `${accountId}-c1`, name: "Coaches 25-54", status: "ACTIVE", dailyBudgetMicros: null, settings: {}, raw: {}, createdOn: EPOCH, pauses: [] });
  put({ kind: "ad_group", externalId: `${accountId}-g2`, parentExternalId: `${accountId}-c2`, name: "Volleyball directors", status: "PAUSED", dailyBudgetMicros: null, settings: {}, raw: {}, createdOn: EPOCH, pauses: alwaysPaused() });
  put({ kind: "ad", externalId: `${accountId}-a1`, parentExternalId: `${accountId}-g1`, name: "Fairness / Room screenshot", status: "ACTIVE", dailyBudgetMicros: null, settings: { hook: "fairness" }, raw: {}, createdOn: EPOCH, pauses: [] });
  put({ kind: "ad", externalId: `${accountId}-a2`, parentExternalId: `${accountId}-g1`, name: "Stop running tryouts on spreadsheets", status: "ACTIVE", dailyBudgetMicros: null, settings: { hook: "pain" }, raw: {}, createdOn: EPOCH, pauses: [] });
  put({ kind: "ad", externalId: `${accountId}-a3`, parentExternalId: `${accountId}-g2`, name: "Volleyball - abstract art", status: "PAUSED", dailyBudgetMicros: null, settings: { hook: "fairness" }, raw: {}, createdOn: EPOCH, pauses: alwaysPaused() });
  put({ kind: "keyword", externalId: `${accountId}-k1`, parentExternalId: `${accountId}-g1`, name: "tryout software", status: "ACTIVE", dailyBudgetMicros: null, settings: { matchType: "phrase" }, raw: {}, createdOn: EPOCH, pauses: [] });
  return { objects, negativeKeywords: [], nextId: 100 };
}

function* dateRange(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

const FORMATS: Record<string, CreativeFormatSpec> = {
  mock_image: {
    format: "mock_image",
    textFields: [
      { name: "primary_text", maxChars: 125 },
      { name: "headline", maxChars: 40 },
      { name: "description", maxChars: 30 },
    ],
    imageAspectRatios: ["1:1", "4:5", "9:16", "16:9"],
    landingUrlMacro: "utm_content={{ad.id}}",
  },
};

export class MockAdapter implements ChannelAdapter {
  readonly channel = "mock" as const;
  readonly isMock = true;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    "read_structure",
    "read_metrics",
    "pause_activate",
    "change_budget",
    "create_campaign",
    "create_ad_group",
    "create_ad",
    "negative_keywords",
    "image_ads",
  ]);

  private readonly accounts = new Map<string, MockAccountState>();
  /** Every execute() call, for tests and the mock's own audit. */
  readonly calls: { accountId: string; command: AdapterCommand }[] = [];

  private state(account: AccountRef): MockAccountState {
    // Two channels may legitimately share an external account id.
    const k = `${account.channel}:${account.externalAccountId}`;
    let s = this.accounts.get(k);
    if (!s) {
      s = fixture(account.externalAccountId);
      this.accounts.set(k, s);
    }
    return s;
  }

  async *syncStructure(account: AccountRef): AsyncIterable<ExtObjectInput> {
    const s = this.state(account);
    for (const o of s.objects.values()) {
      const { idempotencyKey: _k, createdOn: _c, pauses: _p, ...rest } = o;
      yield { ...rest, settings: { ...rest.settings }, raw: { ...rest.raw } };
    }
    // Negative keywords live on the campaign, as on Google; surfaced so the
    // mirror shows them.
    for (const [i, nk] of s.negativeKeywords.entries()) {
      yield {
        kind: "keyword",
        externalId: `${nk.campaignExternalId}-neg${i + 1}`,
        parentExternalId: nk.campaignExternalId,
        name: nk.keyword,
        status: "ACTIVE",
        dailyBudgetMicros: null,
        settings: { negative: true, matchType: nk.matchType },
        raw: {},
      };
    }
  }

  /** Whether an ad delivered on a given day: it and its ancestors were active that day. */
  private deliveredOn(s: MockAccountState, ad: MockObject, date: string): boolean {
    const parent = ad.parentExternalId ? s.objects.get(key("ad_group", ad.parentExternalId)) : null;
    const campaign = parent?.parentExternalId ? s.objects.get(key("campaign", parent.parentExternalId)) : null;
    for (const o of [ad, parent, campaign]) {
      if (!o) return false;
      if (date < o.createdOn) return false;
      if (o.pauses.some((p) => date >= p.from && (p.to === null || date < p.to))) return false;
    }
    return true;
  }

  async *fetchDailyMetrics(account: AccountRef, fromDate: string, toDate: string): AsyncIterable<MetricRow> {
    const s = this.state(account);
    for (const o of s.objects.values()) {
      if (o.kind !== "ad") continue;
      for (const date of dateRange(fromDate, toDate)) {
        // Pausing changes the future, not the past: history is never restated to zero.
        if (!this.deliveredOn(s, o, date)) {
          yield { externalId: o.externalId, kind: "ad", date, impressions: 0, clicks: 0, spendMicros: 0, platformConversions: {}, frequency: null, reach: null, raw: {} };
          continue;
        }
        const seed = `${account.externalAccountId}|${o.externalId}|${date}`;
        const impressions = 800 + hashInt(`${seed}|i`, 1200);
        const clicks = Math.max(1, Math.round(impressions * (0.01 + hashInt(`${seed}|c`, 30) / 1000)));
        const spendMicros = clicks * (900_000 + hashInt(`${seed}|s`, 600_000));
        const conv = hashInt(`${seed}|v`, o.settings["hook"] === "fairness" ? 4 : 3);
        yield {
          externalId: o.externalId,
          kind: "ad",
          date,
          impressions,
          clicks,
          spendMicros,
          platformConversions: conv > 0 ? { registration: conv } : {},
          frequency: 1 + hashInt(`${seed}|f`, 20) / 10,
          reach: Math.round(impressions / (1 + hashInt(`${seed}|f`, 20) / 10)),
          raw: {},
        };
      }
    }
  }

  async validate(account: AccountRef, command: AdapterCommand): Promise<ValidationResult> {
    const parsed = adapterCommandSchema.safeParse(command);
    if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const s = this.state(account);
    const c = parsed.data;
    const errors: string[] = [];
    const mustExist = (kind: string, id: string) => {
      if (!s.objects.has(key(kind, id))) errors.push(`${kind} ${id} does not exist in account ${account.externalAccountId}`);
    };
    switch (c.type) {
      case "PAUSE_AD":
      case "ACTIVATE":
        mustExist(c.kind, c.externalId);
        break;
      case "CHANGE_BUDGET":
        mustExist(c.kind, c.externalId);
        if (c.dailyBudgetMicros < 1_000_000) errors.push("daily budget must be at least 1.00");
        break;
      case "CREATE_AD_GROUP":
        mustExist("campaign", c.campaignExternalId);
        break;
      case "CREATE_AD":
        mustExist("ad_group", c.adGroupExternalId);
        break;
      case "ADD_NEGATIVE_KEYWORD":
        mustExist("campaign", c.campaignExternalId);
        break;
      case "CREATE_CAMPAIGN":
        if (c.dailyBudgetMicros < 1_000_000) errors.push("daily budget must be at least 1.00");
        break;
    }
    return { ok: errors.length === 0, errors };
  }

  async execute(account: AccountRef, command: AdapterCommand): Promise<ExecResult> {
    const v = await this.validate(account, command);
    if (!v.ok) throw new Error(`mock adapter refused: ${v.errors.join("; ")}`);
    const s = this.state(account);
    this.calls.push({ accountId: account.externalAccountId, command });

    // Kind-scoped: a key reused for a different kind must not find the other object.
    const existingForKey = (kind: MockObject["kind"], k: string) => [...s.objects.values()].find((o) => o.kind === kind && o.idempotencyKey === k);
    const newId = () => `${account.externalAccountId}-n${s.nextId++}`;

    switch (command.type) {
      case "PAUSE_AD":
      case "ACTIVATE": {
        const o = s.objects.get(key(command.kind, command.externalId))!;
        const previous = o.status;
        const open = o.pauses.find((p) => p.to === null);
        if (command.type === "PAUSE_AD") {
          o.status = "PAUSED";
          if (!open) o.pauses.push({ from: today(), to: null });
        } else {
          o.status = "ACTIVE";
          // Close the pause as of today; the paused days stay paused in history.
          if (open) open.to = today();
          o.pauses = o.pauses.filter((p) => p.to === null || p.from < p.to);
        }
        return {
          externalIds: { [command.kind]: o.externalId },
          response: { status: o.status },
          rollback: previous === "ACTIVE" ? { type: "ACTIVATE", kind: command.kind, externalId: o.externalId } : { type: "PAUSE_AD", kind: command.kind, externalId: o.externalId },
        };
      }
      case "CHANGE_BUDGET": {
        const o = s.objects.get(key(command.kind, command.externalId))!;
        const previous = o.dailyBudgetMicros;
        o.dailyBudgetMicros = command.dailyBudgetMicros;
        return {
          externalIds: { [command.kind]: o.externalId },
          response: { dailyBudgetMicros: o.dailyBudgetMicros },
          // An inherited (null) budget has no valid inverse command; say so rather than invent one.
          rollback: previous === null ? null : { type: "CHANGE_BUDGET", kind: command.kind, externalId: o.externalId, dailyBudgetMicros: previous },
        };
      }
      case "CREATE_CAMPAIGN": {
        const existing = existingForKey("campaign", command.idempotencyKey);
        if (existing) return { externalIds: { campaign: existing.externalId }, response: { reused: true }, rollback: null };
        const o: MockObject = { kind: "campaign", externalId: newId(), parentExternalId: null, name: command.name, status: "PAUSED", dailyBudgetMicros: command.dailyBudgetMicros, settings: { objective: command.objective, geos: command.geos }, raw: {}, idempotencyKey: command.idempotencyKey, createdOn: today(), pauses: alwaysPaused() };
        s.objects.set(key(o.kind, o.externalId), o);
        return { externalIds: { campaign: o.externalId }, response: { created: true, status: "PAUSED" }, rollback: null };
      }
      case "CREATE_AD_GROUP": {
        const existing = existingForKey("ad_group", command.idempotencyKey);
        if (existing) return { externalIds: { ad_group: existing.externalId }, response: { reused: true }, rollback: null };
        const o: MockObject = { kind: "ad_group", externalId: newId(), parentExternalId: command.campaignExternalId, name: command.name, status: "PAUSED", dailyBudgetMicros: null, settings: { audience: command.audience }, raw: {}, idempotencyKey: command.idempotencyKey, createdOn: today(), pauses: alwaysPaused() };
        s.objects.set(key(o.kind, o.externalId), o);
        return { externalIds: { ad_group: o.externalId }, response: { created: true, status: "PAUSED" }, rollback: null };
      }
      case "CREATE_AD": {
        const existing = existingForKey("ad", command.idempotencyKey);
        if (existing) return { externalIds: { ad: existing.externalId }, response: { reused: true }, rollback: null };
        const o: MockObject = { kind: "ad", externalId: newId(), parentExternalId: command.adGroupExternalId, name: command.name, status: "PAUSED", dailyBudgetMicros: null, settings: { creativeVariantId: command.creativeVariantId, landingUrl: command.landingUrl, ...command.payload }, raw: {}, idempotencyKey: command.idempotencyKey, createdOn: today(), pauses: alwaysPaused() };
        s.objects.set(key(o.kind, o.externalId), o);
        return { externalIds: { ad: o.externalId }, response: { created: true, status: "PAUSED" }, rollback: null };
      }
      case "ADD_NEGATIVE_KEYWORD": {
        s.negativeKeywords.push({ campaignExternalId: command.campaignExternalId, keyword: command.keyword, matchType: command.matchType });
        return { externalIds: { campaign: command.campaignExternalId }, response: { negativeKeywords: s.negativeKeywords.length }, rollback: null };
      }
    }
  }

  async findByIdempotencyKey(account: AccountRef, kind: ExtObjectInput["kind"], idempotencyKey: string): Promise<ExtObjectInput | null> {
    const o = [...this.state(account).objects.values()].find((x) => x.kind === kind && x.idempotencyKey === idempotencyKey);
    if (!o) return null;
    const { idempotencyKey: _k, createdOn: _c, pauses: _p, ...rest } = o;
    return rest;
  }

  formatSpec(format: string): CreativeFormatSpec | null {
    return FORMATS[format] ?? null;
  }
}
