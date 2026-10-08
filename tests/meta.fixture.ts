import { idempotencyTag } from "../src/channels/meta/index.js";

// A pretend Graph API for the Meta adapter: recorded-shape responses, two
// pages for campaigns, usage headers and throttling on demand. Every
// request is kept so tests can assert what was asked and that the token
// only ever travelled in the Authorization header.

export interface FakeGraphOptions {
  usagePct?: number; // sets x-ad-account-usage on every response
  throttleFirst?: number; // first N requests answer 429 with Meta's rate-limit body
  missingIds?: string[]; // objects that answer "does not exist"
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
}

const ACT = "act_1082877204521539";

export const FIXTURE = {
  campaigns: [
    { id: "120001", name: "Spring tryouts - CA", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "3000", objective: "OUTCOME_TRAFFIC", bid_strategy: "LOWEST_COST_WITHOUT_CAP", created_time: "2026-09-01T12:00:00+0000", updated_time: "2026-10-01T12:00:00+0000" },
    { id: "120002", name: "Volleyball clubs - US", status: "PAUSED", effective_status: "PAUSED", daily_budget: "1500", objective: "OUTCOME_LEADS", created_time: "2026-09-01T12:00:00+0000", updated_time: "2026-10-01T12:00:00+0000" },
    { id: "120003", name: `Old test ${idempotencyTag("old-test-key")}`, status: "ARCHIVED", effective_status: "ARCHIVED", lifetime_budget: "10000", objective: "OUTCOME_TRAFFIC", created_time: "2026-08-01T12:00:00+0000", updated_time: "2026-08-20T12:00:00+0000" },
  ],
  adsets: [
    { id: "130001", name: "Coaches 25-54", status: "ACTIVE", effective_status: "ACTIVE", campaign_id: "120001", optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["CA"] }, age_min: 25, age_max: 54 } },
    { id: "130002", name: "Volleyball directors", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED", campaign_id: "120002", daily_budget: "1500", optimization_goal: "LEAD_GENERATION", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] } } },
  ],
  ads: [
    { id: "140001", name: "Fairness / Room screenshot", status: "ACTIVE", effective_status: "ACTIVE", adset_id: "130001", creative: { id: "150001", name: "fairness-1", object_story_spec: { page_id: "1361698740353589", link_data: { link: "https://tryoutbrain.com/?utm_content={{ad.id}}", access_token: "should-never-leak" } } } },
    { id: "140002", name: "Stop running tryouts on spreadsheets", status: "ACTIVE", effective_status: "WITH_ISSUES", adset_id: "130001", creative: { id: "150002" } },
    { id: "140003", name: "Volleyball - abstract art", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", adset_id: "130002", creative: { id: "150003" } },
  ],
  insightsFor(since: string, until: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const d = new Date(`${since}T00:00:00Z`);
    const end = new Date(`${until}T00:00:00Z`);
    let i = 0;
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      out.push({ ad_id: "140001", adset_id: "130001", campaign_id: "120001", date_start: date, date_stop: date, impressions: String(1000 + i), clicks: String(40 + i), inline_link_clicks: String(30 + i), spend: (12.5 + i).toFixed(2), reach: String(800 + i), frequency: "1.25", actions: [{ action_type: "link_click", value: String(30 + i) }, { action_type: "lead", value: "2" }, { action_type: "post_engagement", value: "5" }] });
      out.push({ ad_id: "140002", adset_id: "130001", campaign_id: "120001", date_start: date, date_stop: date, impressions: "500", clicks: "20", spend: "6.00", reach: "450", frequency: "1.1111" });
      d.setUTCDate(d.getUTCDate() + 1);
      i++;
    }
    return out;
  },
};

export function fakeGraph(opts: FakeGraphOptions = {}) {
  const requests: RecordedRequest[] = [];
  let throttled = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(opts.usagePct !== undefined ? { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: opts.usagePct, call_count: opts.usagePct, total_cputime: 1, total_time: 1 }) } : {}) },
    });
  const page = <T>(items: T[], url: URL, pageSize = 2) => {
    const after = url.searchParams.get("after");
    const start = after ? Number(after) : 0;
    const slice = items.slice(start, start + pageSize);
    const nextCursor = start + pageSize < items.length ? String(start + pageSize) : null;
    return { data: slice, paging: nextCursor ? { cursors: { after: nextCursor }, next: `${url.origin}${url.pathname}?after=${nextCursor}` } : { cursors: {} } };
  };
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of FIXTURE.campaigns) byId.set(c.id, c);
  for (const s of FIXTURE.adsets) byId.set(s.id, s);
  for (const a of FIXTURE.ads) byId.set(a.id, a);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url: url.toString(), authorization: headers.get("authorization") });
    if (throttled < (opts.throttleFirst ?? 0)) {
      throttled++;
      return json({ error: { message: "(#17) User request limit reached", type: "OAuthException", code: 17, fbtrace_id: "Axyz" } }, 400);
    }
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    const filtering = url.searchParams.get("filtering");
    const nameFilter = filtering ? (JSON.parse(filtering) as { field: string; value: string }[]).find((f) => f.field === "name")?.value : null;
    const filtered = <T extends { name: string }>(items: T[]) => (nameFilter ? items.filter((x) => x.name.includes(nameFilter)) : items);
    if (path === `${ACT}`) return json({ id: ACT, name: "TryoutBrain", currency: "CAD", timezone_name: "America/Toronto", account_status: 1 });
    if (path === `${ACT}/campaigns`) return json(page(filtered(FIXTURE.campaigns), url));
    if (path === `${ACT}/adsets`) return json(page(filtered(FIXTURE.adsets), url));
    if (path === `${ACT}/ads`) return json(page(filtered(FIXTURE.ads), url));
    if (path === `${ACT}/insights`) {
      const range = JSON.parse(url.searchParams.get("time_range") ?? "{}") as { since: string; until: string };
      return json(page(FIXTURE.insightsFor(range.since, range.until), url, 500));
    }
    if (opts.missingIds?.includes(path)) return json({ error: { message: "Unsupported get request. Object with ID does not exist", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400);
    const obj = byId.get(path);
    if (obj) return json(obj);
    return json({ error: { message: `fake graph: no route for ${path}`, code: 100 } }, 404);
  };
  return { fetchImpl, requests };
}
