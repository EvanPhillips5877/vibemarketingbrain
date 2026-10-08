// A thin client for Meta's Graph / Marketing API. Pinned version, bearer
// auth (the token never appears in a URL), cursor pagination, and the two
// things that keep a small account out of trouble: backoff when Meta's
// usage headers pass 75%, and a bounded retry on throttling errors.
// Nothing here knows about MarketingBrain's objects; the adapter does.

export const META_API_VERSION = "v21.0";
export const USAGE_BACKOFF_PCT = 75;

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | null,
    public readonly subcode: number | null,
    public readonly fbtraceId: string | null,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
  /** Throttling: retry after a pause. Codes per Meta's error reference. */
  get isThrottle(): boolean {
    return this.status === 429 || this.code === 4 || this.code === 17 || this.code === 32 || this.code === 613 || this.code === 80004;
  }
  /** The object is gone or was never ours to see. */
  get isMissing(): boolean {
    return this.status === 404 || this.code === 100 || this.code === 803;
  }
}

export interface GraphOptions {
  token: string;
  version?: string;
  fetchImpl?: typeof fetch;
  /** Injected so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface Page<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Highest usage percentage Meta reports in its throttling headers, or 0.
 * Three shapes exist: x-app-usage is a flat object of percentages,
 * x-ad-account-usage is a flat object with acc_id_util_pct, and
 * x-business-use-case-usage maps a business id to a list of objects.
 */
const USAGE_KEYS = new Set(["call_count", "total_cputime", "total_time", "acc_id_util_pct"]);
export function usagePct(headers: Headers): number {
  let max = 0;
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === "number") {
      if (key && USAGE_KEYS.has(key) && Number.isFinite(v)) max = Math.max(max, v);
      return;
    }
    if (Array.isArray(v)) for (const x of v) walk(x, null);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  for (const name of ["x-business-use-case-usage", "x-ad-account-usage", "x-app-usage"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      walk(JSON.parse(raw), null);
    } catch {
      /* a header we cannot parse is not a reason to stop */
    }
  }
  return max;
}

export class GraphClient {
  private readonly token: string;
  readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  /** Milliseconds to pause before the next call, set from the last response's usage headers. */
  private cooldownMs = 0;
  /** For tests and logs: how often backoff kicked in. */
  readonly stats = { calls: 0, backoffs: 0, retries: 0 };

  constructor(opts: GraphOptions) {
    this.token = opts.token;
    this.version = opts.version ?? META_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private url(path: string, params: Record<string, string | number | undefined>): string {
    const u = new URL(`https://graph.facebook.com/${this.version}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** One GET with retry and backoff. Returns the parsed body. */
  async get<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  async post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, string | number | undefined>, body?: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (this.cooldownMs > 0) {
        this.stats.backoffs++;
        await this.sleep(this.cooldownMs);
        this.cooldownMs = 0;
      }
      this.stats.calls++;
      const res = await this.fetchImpl(this.url(path, params), {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // Over 75% of any usage budget: pause before the next call, growing with pressure.
      const pct = usagePct(res.headers);
      if (pct >= USAGE_BACKOFF_PCT) this.cooldownMs = pct >= 95 ? 60_000 : pct >= 85 ? 20_000 : 5_000;

      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.ok) return json as T;

      const err = (json as { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } } | null)?.error;
      const e = new MetaApiError(`Meta API ${res.status}: ${err?.message ?? text.slice(0, 200)}`, res.status, err?.code ?? null, err?.error_subcode ?? null, err?.fbtrace_id ?? null);
      if (e.isThrottle && attempt < this.maxRetries) {
        attempt++;
        this.stats.retries++;
        await this.sleep(Math.min(60_000, 2_000 * 2 ** attempt));
        continue;
      }
      throw e;
    }
  }

  /** Every item across all pages of an edge. */
  async *paginate<T>(path: string, params: Record<string, string | number | undefined> = {}): AsyncIterable<T> {
    let after: string | undefined;
    for (;;) {
      const page = await this.get<Page<T>>(path, { limit: 100, ...params, ...(after ? { after } : {}) });
      for (const item of page.data ?? []) yield item;
      const next = page.paging?.cursors?.after;
      if (!next || !page.paging?.next) return;
      after = next;
    }
  }
}
