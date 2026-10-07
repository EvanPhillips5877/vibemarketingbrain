# MarketingBrain — architecture & V1 build plan

2026-10-07 · plan only, no code written · awaiting Evan's approval

---

## 0. What I inspected, and what it changes

| Looked at | Finding | Consequence for MarketingBrain |
|---|---|---|
| `C:\dev\tryoutbrain` | pnpm monorepo, Express 5 + React 19/Vite + Drizzle, Supabase Auth, prod Postgres on Supabase ca-central-1, ECS Fargate. Holds **minors' data**. | Keep MarketingBrain and its ad tokens well away from this codebase and DB. |
| TryoutBrain `site_events` + `analytics.ts` | First-party, cookieless analytics. Captures `utm_source/medium/campaign` per page view, day-scoped visitor hash. **No `gclid`/`fbclid`, no `utm_content`, and no first-touch source stored on the organization.** | Attribution to revenue isn't possible today. TryoutBrain needs a small, separate change: capture click IDs and first-touch UTMs, store them on the org at signup, and expose them through an internal export. |
| TryoutBrain `organizations` | `subscription_tier/status`, `stripe_subscription_id` on the org. | "Paid customer" and "revenue" can come from TryoutBrain's own tables. MarketingBrain never needs Stripe keys. |
| `C:\dev\fernz` | Single-package Express 5 + Drizzle + zod + vitest, mock mode for every integration, sacred approval gate, `agent_events` memory, Meta **Pages** publishing, a completed Meta App Review pack, RDS + ECS. | This is the house style to copy: one process, one DB, mock mode, approval gate. Fernz's Meta app is for *tenants'* Pages; MarketingBrain uses **its own** Meta app so it doesn't complicate Fernz's review. |
| `C:\dev\kompete` | Client work, analysis files only, client's DB. | Kompete as a "brand" means advertising **on a client's behalf, from the client's ad accounts**. The model supports that, but it's out of V1. |
| `C:\dev\marketingbrain` | Doesn't exist. | New repo. |

API facts checked on 2026-10-07:
- **Meta:** the Marketing API throughput feature is now called the *Marketing API Access Tier* (Limited / Full, since 2026-05-04). For ad accounts you own, `ads_management` at Limited Access works **without App Review**. Full Access needs 500 calls in 15 days. [Meta blog](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/) · [features reference](https://developers.facebook.com/docs/features-reference/)
- **Google Ads API:** a developer token (which requires a manager/MCC account) starts at Test Account access. It may be auto-upgraded to **Explorer** (2,880 ops/day on production accounts). **Basic** (15,000 ops/day) has a review of about 5 business days. There's currently a review backlog. [Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels) · [ppc.land on the backlog](https://ppc.land/google-faces-developer-token-application-backlog-as-new-api-tier-debuts/)
- **ChatGPT Ads:** self-serve Ads Manager (beta since May 2026), a Bulk Ads API (July 2026) and a Conversions API now exist. These come from secondary sources; verify against OpenAI's own docs before building the adapter. [WebFX](https://www.webfx.com/blog/ai/chatgpt-ads-manager/) · [Context Hints timeline](https://www.contexthints.com/guide/chatgpt-ads-news.html)

---

## 1. Recommended architecture

**Standalone repo, standalone service, same AWS account and region. Your instinct is right.** Two reasons settle it:

1. **Trust boundary.** MarketingBrain holds credentials that can spend money and runs LLM loops over untrusted web content (crawled pages, competitor sites). TryoutBrain holds minors' data. They should share nothing but a narrow, read-only export.
2. **Multi-brand by nature.** MarketingBrain sits *above* the products. Put inside one of them, it would inherit that product's deploy cadence, blast radius and tenancy model.

The one real argument for building inside Fernz: Fernz already has an approval gate and Meta plumbing. But those are Pages publishing for customers, not the Ads API for you. **Copy the patterns, not the code.**

### The shape (one process, one database)

```
                ┌───────────────────── MarketingBrain (1 container) ──────────────────────┐
  You ──UI──▶   │  Web (React)  ──▶  API (Express)                                         │
                │                        │                                                 │
                │   AI layer (Claude) ───┤  reads: metric packs, brand facts, learnings   │
                │   - strategist         │  writes: ONLY proposals (never executes)       │
                │   - analyst            ▼                                                 │
                │   - creative     ┌──────────────┐   deterministic: zod schema + policy   │
                │   - command bar  │ Action Engine│── approve? ── you                      │
                │                  └──────┬───────┘                                        │
                │                         ▼                                                │
                │        Channel adapters (Meta, Google, mock; later Reddit, ChatGPT)     │
                │                         │                                                │
                │   Jobs (pg-boss): ingest, analyze, detect, execute, reconcile           │
                └─────────────────────────┼────────────────────────────────────────────────┘
                                          ▼
                      Postgres (source of truth) ◀── pull ── TryoutBrain /internal/marketing export
```

**The core rule:** *Detectors find, the LLM explains and invents, the policy decides, the adapter executes.* Each of these is a separate module with its own tests. The LLM's only write path is "create a proposal".

---

## 2. Recommended stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), Node 24 | Same as everything else on this machine |
| Server | Express 5 | House style (Fernz, TryoutBrain) |
| DB | PostgreSQL 16 + Drizzle ORM + versioned migrations | House style; local PG 16 already installed |
| Validation | zod everywhere, including LLM structured outputs | One schema drives API bodies, action payloads and AI output |
| Jobs/cron | **pg-boss** (Postgres-backed queue + cron) | No Redis, transactional enqueue, singleton jobs, retries. Boring and correct. |
| Web | React 19 + Vite + TanStack Query + shadcn/Tailwind, served by the same Express process | Same as TryoutBrain; one container |
| LLM | Anthropic SDK, structured outputs / tool use. Opus 5.5 for strategy and analysis, Sonnet 5.5 for creative copy, Haiku 4.5 for extraction and tagging | Models are chosen per function, in config |
| Meta | `facebook-nodejs-business-sdk`, or thin `fetch` on the Graph/Marketing API (pinned version) | Official |
| Google | Google Ads API via the `google-ads-api` Node client (wraps the official gRPC/REST), GAQL for reads | Official API; Google has no first-party Node client, so check this wrapper when building. Falling back to raw REST is fine |
| Creative rendering | Satori + resvg (HTML/JSX template → PNG) or sharp compositing over **real product screenshots** | Deterministic, on-brand, cheap. AI image generation comes later, as an adapter |
| Crawling | `fetch` + Readability/cheerio, sitemap-driven, own-domain only in V1 | Enough for the Brand Brain |
| Tests | vitest + supertest, real local Postgres (Fernz pattern) | |
| Package manager | pnpm (single package, not a monorepo) | Simpler than TryoutBrain's workspace |

Not using: vector DB, Redis, Kafka, microservices, LangChain, multi-agent frameworks.

---

## 3. Database / schema design

Fourteen-ish tables. Key shapes below (money is integer **micros** plus a currency, matching Google; dates for metrics are in the **ad account's timezone**).

### Brand Brain
- `brands` — id, slug, name, website, default_currency, timezone, status
- `brand_facts` — id, brand_id, **category** (`product|pricing|audience|problem|differentiator|voice|visual|offer|testimonial|competitor|geo|landing_page|prohibited_claim|sport|…`), key, value (jsonb, typed per category by zod), **source** (`crawl|manual|ai_inferred|learning`), source_url, confidence, **status** (`proposed|active|retired`), verified_at, supersedes_id. *Structured facts are the source of truth. AI-extracted facts arrive as `proposed` until you confirm them.*
- `brand_assets` — id, brand_id, kind (`screenshot|logo|photo|video|font`), s3_key, tags[], width/height, approved
- `offers` — id, brand_id, name, terms, landing_url, active
- `audiences` — id, brand_id, name, description, definition (jsonb: geo, sport, role, interests/keywords), per-channel mapping (jsonb)

### Channels & mirror
- `channel_accounts` — id, brand_id, channel (`meta|google|reddit|chatgpt|mock`), external_account_id, currency, timezone, **secret_ref** (Secrets Manager ARN; no token in DB), status, last_synced_at
- `ext_objects` — **one table for every platform object**: id, channel_account_id, kind (`campaign|ad_group|ad|creative|keyword|asset`), external_id, parent_id, name, status, daily_budget_micros, settings (jsonb), raw (jsonb), mission_id?, creative_variant_id?, **created_by_action_id?**, synced_at. Unique on (channel_account_id, kind, external_id).
- `metrics_daily` — ext_object_id, date, impressions, clicks, spend_micros, platform_conversions (jsonb by action type), frequency?, reach?, raw (jsonb). PK (ext_object_id, date). Upserted over a trailing window, because platforms restate data.

### Revenue truth (from the brand's own app)
- `customer_events` — brand_id, external_customer_id (e.g. TryoutBrain org id, never a person's or athlete's data), **stage** (`registered|activated|paid|churned`), value_micros, occurred_at, first_touch (jsonb: utm_*, gclid, fbclid, landing_path, referrer_host), **attributed_ext_object_id?**, attribution_method. Unique on (brand_id, external_customer_id, stage).

### Missions & creative lineage
- `missions` — id, brand_id, objective_text, goal (jsonb: `{metric:"paid_customers", target:100}`), target_cac_micros, budget_micros, starts/ends, markets[], channels[], status (`draft|active|paused|done`), plan (jsonb, the strategist's last plan)
- `hypotheses` — id, brand_id, mission_id?, statement, **dimensions** (jsonb: angle, pain_point, audience_id, offer_id, visual_style, sport, geo), status (`untested|testing|supported|refuted|inconclusive`), parent_id
- `hooks` — id, brand_id, text, hook_type (`pain|fairness|time_saving|social_proof|…`)
- `creatives` — id, brand_id, hypothesis_id, hook_id, offer_id, audience_id, concept, parent_creative_id (descendants), status
- `creative_variants` — id, creative_id, channel, format (`meta_image|meta_video|google_rsa|…`), payload (jsonb: primary_text, headline, description, cta, image asset ids / RSA headlines[]/descriptions[], keywords[]), rendered_asset_ids[], status (`draft|approved|live|retired`)

- `experiments` (added 2026-10-07, approved) — id, brand_id, **mission_id**, **hypothesis_id**, audience_id?, offer_id?, **channel**, name, **primary_metric** (`cpa|registration_rate|ctr|paid_cac`), target_value, budget_micros, starts_at, ends_at, status (`planned|running|ended`), **result** (jsonb snapshot at close: spend, impressions, clicks, conversions, metric value, sample sizes, per-variant breakdown), **conclusion** (`supported|refuted|inconclusive`, null until closed), concluded_at, learning_id? (the learning written at close). Variants join through `experiment_variants (experiment_id, creative_variant_id)`; platform objects created for the experiment carry `ext_objects.experiment_id`.
  *Rules:* at most **3 experiments `running` per mission** (enforced in code, a policy number so it can change). An experiment is the unit of deliberate learning: the Analyst may only write a `validated|refuted` learning from a closed experiment; patterns noticed outside an experiment are `observation` at best. V1 closes experiments with plain thresholds (spent ≥ planned budget or end date passed, then compare the metric to target with a minimum-sample gate); holdouts and Bayesian readouts stay in V2.

The chain **variant → creative → hook + hypothesis.dimensions → audience/offer** is what lets the system say "fairness + coach pain + real screenshot works for volleyball", not "Ad #423 worked".

### Learnings (Audience/Creative/Performance "brains")
- `learnings` — id, brand_id? (null = cross-brand), statement, **kind** (`observation|hypothesis|validated|refuted`), scope (`audience|creative|channel|geo|funnel`), dimensions (jsonb, same vocabulary as hypotheses), evidence (jsonb: metric query + result snapshot, sample sizes), confidence, status (`active|retired`), supersedes_id, created_by (`job|ai|manual`)

**Four "brains", one design:** Brand Brain = `brand_facts` + assets/offers/audiences. Audience, Creative and Performance Brains = `learnings` filtered by `scope`, plus SQL views over `metrics_daily ⋈ ext_objects ⋈ creative lineage`. No separate services.

### Action Engine & audit
- `autonomy_policies` — brand_id, **version**, level (`suggest|approve|autopilot`), rules (jsonb, zod-validated: monthly_budget, max_daily_spend, max_auto_shift_pct, per-action-type mode `never|approve|auto`, allowed geos, blocked claims…), created_at. Policies are immutable rows; the newest version wins.
- `action_proposals` — id, brand_id, mission_id?, **type** (`PAUSE_AD|ACTIVATE|CREATE_CAMPAIGN|CREATE_AD_GROUP|CREATE_AD|UPLOAD_CREATIVE|CHANGE_BUDGET|REALLOCATE_BUDGET|CREATE_CREATIVE|START_EXPERIMENT|ADD_NEGATIVE_KEYWORD`), payload (jsonb, zod per type), reason, **evidence** (jsonb refs), expected_outcome, confidence, source (`detector:<name>|ai:<run_id>|command:<id>|manual`), **policy_version**, policy_result (jsonb: allowed?, needs_approval?, violated rules), status (`proposed|blocked|awaiting_approval|approved|rejected|executing|executed|failed|unknown|rolled_back|expired`), **idempotency_key UNIQUE**, approved_by/at, expires_at
- `action_executions` — id, proposal_id, attempt, adapter, request (jsonb), response (jsonb), external_ids, **rollback** (jsonb: the inverse action, e.g. previous budget), outcome, started_at, finished_at
- `ai_runs` — id, function (`analyst|strategist|creative|command|crawler_extract`), prompt_version, model, input_refs, output (jsonb), validation_errors, tokens_in/out, cost_micros, created_at
- `audit_events` — append-only: actor, verb, subject, before/after, at. Covers fact edits, policy changes, approvals and logins.

---

## 4. Major modules

```
domain/        pure types + zod schemas (actions, policies, facts, claims)
brands/        Brand Brain CRUD, crawler, fact extraction
channels/      ChannelAdapter interface + meta/, google/, mock/
ingest/        structure sync, metrics sync, customer-event pull, attribution
analytics/     metric packs, deltas, thresholds, detectors (deterministic)
ai/            prompts (versioned), structured-output calls, claim validator, tool registry
creative/      hypothesis → creative → variants, renderer (templates → PNG)
missions/      mission lifecycle, planning, progress
actions/       proposal store, policy evaluator (pure), approval, executor, reconciler
jobs/          pg-boss schedules wiring the above
web/           React command center
```

**ChannelAdapter** (the rest of the system doesn't care which provider it's talking to):
```ts
interface ChannelAdapter {
  channel: Channel;
  capabilities: Set<Capability>;            // e.g. 'create_search_campaign', 'video_ads'
  syncStructure(acct): AsyncIterable<ExtObject>;
  fetchDailyMetrics(acct, from, to): AsyncIterable<MetricRow>;
  validate(action): Promise<ValidationResult>;   // dry run (Google validate_only, Meta execution_options=validate_only)
  execute(action, idemKey): Promise<ExecResult>; // always creates PAUSED
  findByIdempotencyKey(acct, key): Promise<ExtObject | null>; // reconcile after a timeout
  formatSpec(format): CreativeFormatSpec;   // char limits, image sizes → used by Creative Factory
}
```

---

## 5. Meta integration design

- **Access:** a new Meta app ("MarketingBrain", type Business) in your Business Manager, plus a **System User** with `ads_management` + `ads_read` on the TryoutBrain ad account, Page and Instagram account. Its token is long-lived. **No OAuth web flow and no App Review** (own assets, Limited Access tier). The token goes in Secrets Manager.
- **Reads:** structure via `/act_{id}/campaigns|adsets|ads|adcreatives` with field lists. Metrics via **Insights at ad level, `time_increment=1`**, with actions/cost-per-action and frequency. Daily job pulls the **trailing 7 days** (Meta restates); weekly job re-pulls 28 days. Larger ranges use async report runs.
- **Writes (V1):** pause/activate ad and ad set; change ad-set or campaign budget; upload image (`adimages`, hash-deduped); create campaign → ad set → creative → ad, **all created `PAUSED`**. Activation is a separate `ACTIVATE` action. Every created object's name carries the `mb:<proposalId>` tag for reconciliation.
- **Structure opinion:** at TryoutBrain's volume you won't exit the learning phase (about 50 optimization events per ad set per week). Use **one campaign per mission per objective, 1–2 ad sets, broad/Advantage+ audience, geo = CA/US**, and run creatives as ads inside them. The levers MarketingBrain pulls are **creative and budget**, not micro-targeting.
- **Optimization event:** registration (a lead/CompleteRegistration). Paid conversions are too sparse to optimize on directly. Send conversions **server-side via the Conversions API**, never a browser pixel on the app, because the app handles minors' data. The landing page is the only possible pixel location, and V1 doesn't need one.
- **Rate limits:** respect `x-business-use-case-usage` / `x-ad-account-usage` headers. The adapter backs off when usage passes 75%.

## 6. Google integration design

- **Access:** create a **Google Ads manager (MCC) account**, link the TryoutBrain Ads account, and apply for a developer token **now** (the long pole). Use an OAuth client in a GCP project; get a **refresh token once** with a local script (installed-app flow), stored in Secrets Manager. Explorer access (2,880 ops/day) is plenty for one brand; apply for Basic anyway.
- **Reads:** GAQL `SearchStream` for campaign / ad_group / ad_group_ad / keyword_view / search_term_view with `segments.date`, trailing 7-day re-pull. Search-term reports feed negative-keyword proposals.
- **Writes (V1):** **Search campaigns only.** Create budget + campaign (PAUSED) + ad group + keywords (phrase/exact) + **Responsive Search Ad** (up to 15 headlines ≤30 chars, 4 descriptions ≤90). Also pause/enable, change budget, add negative keywords. Every mutate first runs with `validate_only=true`. Use `partial_failure` off for creates, so creation is atomic per request.
- **Bidding:** start with Maximize Clicks with a CPC cap, or Manual CPC. Move to Maximize Conversions / tCPA only after about 15–30 conversions per month, which requires the offline conversion import.
- **Performance Max:** **not in V1.** It needs conversion volume and gives MarketingBrain little to learn from.
- **Conversions:** upload offline conversions (registration, paid) by `gclid` from TryoutBrain's export. Enhanced conversions with hashed email is a later privacy decision (see Risks).
- Google's daily budget can overspend up to 2× on a given day; the monthly cap is 30.4× daily. The policy engine accounts for this.

## 7. Brand Brain design

- **Population:** a crawl job fetches the sitemap and top pages of `tryoutbrain.com` (and the per-sport landing pages). An extraction pass (Haiku/Sonnet, structured output) emits **proposed facts** with source URL and quote. You confirm or edit in a review screen; nothing becomes `active` silently. Re-crawl weekly and propose diffs.
- **Manual-first categories:** prohibited claims (e.g. no promises about "selecting the best athletes", no claims about minors), pricing, voice rules, competitors. The crawler can suggest these; you own them.
- **Use:** every AI call gets a compact **Brand Brief** rendered deterministically from active facts. No embeddings needed at this size. If facts grow past a few hundred, add pgvector *later*, as a retrieval aid only.
- **Guardrail:** generated copy is checked deterministically against `prohibited_claim` facts (string and regex rules), plus one LLM "compliance read" with a structured verdict. Both must pass before a variant can be approved.

## 8. Mission architecture

A **Mission** is a goal + budget + constraints + a living plan.

1. You state it (form or command bar) → parsed into structured fields that you confirm.
2. **Strategist** (Opus) reads the Brand Brief, active learnings and current account state, and produces a **Plan**: 3–6 hypotheses, channel split, test budget per hypothesis, kill and scale criteria, and timeline. The plan is stored on the mission and versioned through `ai_runs`.
3. The plan expands into **experiments** (one per hypothesis, ≤ 3 running at once) and their **proposals**: CREATE_CREATIVE, CREATE_CAMPAIGN, and so on. All go through the Action Engine. Objects created for an experiment are tagged with it, so its ledger is a filter, not a guess.
4. **Mission ledger** = SQL over `metrics_daily` + `customer_events`, for objects tagged with the mission: spend vs budget, CAC vs target, pacing, and progress toward the goal.
5. A daily **mission progress** job compares against kill/scale criteria and creates proposals. A weekly job re-plans.
6. A mission ends when its budget is spent, its goal is hit or its date passes. The last step writes learnings.

V1: one active mission per brand. The model allows many.

## 9. Creative Factory architecture

```
Hypothesis ──▶ Hooks (3–5) ──▶ Creative concepts ──▶ Channel variants ──▶ Render ──▶ Compliance ──▶ Approval ──▶ CREATE_AD proposals
                     ▲                                       │
          learnings + best performers               adapter.formatSpec() (char limits, sizes)
```

- **Copy:** Sonnet with structured output per format (Meta: primary text, headline, description, CTA enum; Google RSA: headline/description arrays with enforced lengths, plus keyword themes). Lengths are enforced by zod *and* re-checked by the adapter spec.
- **Images (V1):** 4–6 hand-designed **templates** (screenshot-in-device + headline, quote card, before/after "spreadsheet vs Room", stat card) rendered from real TryoutBrain screenshots in `brand_assets`. The AI chooses the template, screenshot and overlay text. This is cheap, on-brand, and directly tests the hypothesis that real screenshots outperform AI art.
- **Descendants:** "make 3 children of Creative 7" clones the dimensions, holds the hook constant and varies one dimension. `parent_creative_id` records the lineage.
- **Later:** AI image generation and short video (script, storyboard, then an `ImageGenAdapter`/`VideoAdapter`), and Reddit-native copy formats.

## 10. Performance ingestion architecture

| Job | When | What |
|---|---|---|
| `sync-structure` | every 6 h + after any execution | Mirror campaigns/ad sets/ads/creatives into `ext_objects` |
| `sync-metrics` | daily 06:00 ET + hourly "today" for pacing | Upsert trailing 7 days; weekly 28-day refresh |
| `pull-customer-events` | hourly | `GET {brand}/api/internal/marketing/events?since=` (signed). Idempotent upserts |
| `attribute` | after pull | Match `gclid`→Google click, `fbclid`/`utm_content=ad_id`→Meta ad, else UTM campaign, else `unattributed`. Last non-direct touch, stored with its method |
| `detectors` | after metrics | Deterministic: overspend/pacing, zero-conv spend ≥ 3× target CPA, CPA drift, frequency/fatigue, disapproved ads, broken landing URLs |

**UTM convention, enforced by the adapter on every created ad:**
`utm_source={meta|google}&utm_medium=paid&utm_campaign={mission_slug}&utm_content={ad_id}&utm_term={keyword}`. Meta's dynamic `{{ad.id}}` and Google's ValueTrack `{creative}`/`{keyword}` fill these automatically, so every visit maps to an ad without a pixel.

**Change needed in TryoutBrain** (its own small, reviewed PR):
1. On landing, keep `gclid`/`gbraid`/`wbraid`/`fbclid` + full UTMs + landing path in `sessionStorage` (first touch, 30-day `localStorage` fallback). Send them with the signup request. Store as `organizations.acquisition` (jsonb), clipped and validated with zod since it's untrusted input.
2. `GET /api/internal/marketing/events?since=` — bearer/HMAC-authenticated, returns **org-level** rows only: org id, stage timestamps (registered, activated = first tryout with ≥ N scores, paid = subscription active), plan value, acquisition. **No names, emails or athlete data.**
3. A privacy policy line about advertising attribution.

The **pull** direction is deliberate: TryoutBrain stays stateless and has no outbox; MarketingBrain can re-pull history any time; the same contract later works for Fernz and Kompete.

## 11. Action Engine + safety design

**Lifecycle:** `proposed → (policy) → blocked | awaiting_approval | approved → executing → executed | failed | unknown → (reconciled) → executed | failed`; also `rejected`, `expired`, `rolled_back`.

1. **Schema gate.** Each action type has a zod payload schema. Anything else is rejected before it's stored.
2. **Policy gate.** `evaluatePolicy(proposal, policy, ledgerSnapshot) → {allowed, needsApproval, violations[]}` is a **pure function** with exhaustive unit tests. Rules:
   - monthly spend projected **including this change** ≤ policy monthly budget (and ≤ mission budget)
   - sum of daily budgets ≤ max daily spend (Google 2× overspend accounted for in the projection)
   - automatic budget moves ≤ `max_auto_shift_pct` of current budget per rolling 7 days
   - **total monthly budget increase: always `never`-auto, regardless of level**
   - geo / claim / channel allowlists
   - per-type mode: `never | approve | auto`, then capped by brand level (Suggest → nothing executes; Approve → everything needs you; Autopilot → only types marked `auto`)
3. **Freshness gate.** At execution time, re-read live object state from the platform. If it differs from the proposal's assumptions (budget changed, ad already paused) → `expired`, not executed. Approvals expire after 72 h.
4. **Idempotency.** `idempotency_key = hash(type, target, normalized payload, mission, day-bucket)`, enforced by a unique index, so the same detector firing twice can't create two proposals. Execution takes a row lock (`SELECT … FOR UPDATE SKIP LOCKED`) and records the attempt **before** the API call. On timeout or network error → `unknown`. The reconciler looks the object up by its `mb:<id>` name tag or reads current state. **Never a blind retry.**
5. **Created PAUSED, activated separately.** The worst a creation bug can do is leave paused objects behind.
6. **Rollback info:** every mutating execution stores its inverse (previous budget, previous status). "Undo" is just a new proposal using it.
7. **Platform-side backstops (you set these by hand, once):** a Meta ad-account **spending limit** and a Google **campaign budget ceiling / account budget**. If every line of MarketingBrain's code failed, the platforms would still stop spend.
8. **Kill switch:** `brands.status = 'halted'` blocks all execution. A one-click "pause everything MarketingBrain created" is itself a proposal type, pre-approved.
9. **Audit:** proposal + policy result + approver + request/response + rollback, all retained.

TryoutBrain starts at **Level 2 (Approve)**, with `PAUSE_AD` allowed for detector-originated proposals only after a month of you seeing the proposals and agreeing with them.

## 12. AI / orchestration design

**One orchestrator, four prompt-functions, a tool registry. No agent swarm.**

| Function | Model | Input | Output (structured) |
|---|---|---|---|
| Analyst | Opus 5.5 | **Metric pack** (precomputed by SQL: totals, deltas, per-dimension breakdowns, sample sizes, significance flags) | `claims[]` + `proposals[]` |
| Strategist | Opus 5.5 | Mission + Brand Brief + learnings + account state | Plan (hypotheses, split, criteria) |
| Creative | Sonnet 5.5 | Hypothesis + Brand Brief + format spec + top performers | Variants |
| Command bar | Sonnet 5.5 (Opus for "why") | Your text + tools | Answer with claims, or proposals |
| Extractors | Haiku 4.5 | Crawled pages | Proposed facts |

**Claim discipline (enforced in code):**
```ts
Claim = { kind: 'FACT'|'OBSERVATION'|'HYPOTHESIS'|'RECOMMENDATION'|'ACTION',
          text: string, evidence: EvidenceRef[], confidence?: number }
```
- The LLM **never computes numbers**; SQL does. Numbers come from the metric pack.
- The validator rejects a FACT/OBSERVATION whose `evidence` doesn't resolve to a metric-pack entry, or whose quoted numbers don't match that entry within rounding.
- Causal language ("because", "due to") is only allowed in HYPOTHESIS. The validator flags it elsewhere, and the run is retried once with the error, then stored as failed.
- Sample-size gate: the pack marks each comparison `insufficient_data` below thresholds (e.g. < 2× target CPA spent, < 10 conversions), and the prompt must label those as hypotheses.

**Command bar tools:** read-only (`query_metrics`, `get_mission`, `list_learnings`, `get_brand_facts`, `list_proposals`) and **propose-only** (`propose_action`, `propose_mission`, `generate_creatives`). There is no execute tool. "Stop advertising in California" becomes a geo-exclusion proposal shown to you with its policy result.

Prompts are versioned files in the repo. Every call is logged in `ai_runs` with cost; there's a monthly AI budget per brand in policy.

## 13. Authentication / security design

- **Users:** you (later maybe one teammate). **Google sign-in** (OIDC) with an **email allowlist** (`evan@elitesultimate.com`), server-side session in Postgres, httpOnly SameSite=Lax cookie, CSRF token on mutations. A second factor comes from your Google account. No public signup route exists.
- **Secrets:** Meta system-user token, Google refresh token + developer token, Anthropic key, brand export secrets: all in **AWS Secrets Manager**, read by the task role, cached in memory, **never in DB rows, logs, client bundles or AI prompts**. Log redaction for `access_token`, `Authorization`, `developer-token`.
- **Untrusted input:** crawled HTML and competitor pages go into prompts *only* as quoted data with an explicit "data, not instructions" frame. Extractors can only emit `proposed` facts. No tool call can be triggered by crawled content.
- **Brand export auth:** per-brand secret, HMAC over timestamp+path, 5-minute window, IP not trusted.
- **Network:** RDS reachable only from the service's security group; TLS at the ALB.
- **Data minimization:** MarketingBrain stores org-level conversion rows, never people. TryoutBrain's minors' data never leaves TryoutBrain.

## 14. Deployment approach

- **Local first:** everything runs in **mock mode** with no keys (Fernz rule). The mock adapter replays fixture accounts so the whole loop is testable offline.
- **AWS, ca-central-1, same account:** ECS Fargate service (0.25–0.5 vCPU, 1 GB, `desiredCount=1`), RDS PostgreSQL 16 `db.t4g.micro`, S3 bucket for creative assets, Secrets Manager, ALB + ACM. Rough cost **≈ $45–65/month** before LLM usage. Putting a host rule on Fernz's existing ALB would save about $18/mo; I'd skip that to keep the blast radii separate.
- **Domain:** an internal hostname not tied to any one brand, e.g. `mb.elitesultimate.com` (*assumption, see Q-list*).
- **CI:** GitHub Actions on `pull_request` + `workflow_dispatch` only (typecheck + tests). Deploy workflow on push to `main`, ≤ 5 min, `timeout-minutes` set, OIDC role trusting `repo:EvanPhillips5877/vibemarketingbrain:*`. **Pick the repo name once; it's baked into IAM.**
- **No staging environment for V1.** It's an internal single-user tool, and the real safety net is mock mode, PAUSED creation, policy gates and platform spend caps. TryoutBrain's PR still goes staging → production as usual.
- Add `.ai-review.json` from day one, with `actions/`, `channels/`, `auth`, `migrations`, `infra` as sensitive paths. Most MarketingBrain phases will be REVIEW-level under your policy.

## 15. V1 scope (the closed loop, TryoutBrain only)

In:
- TryoutBrain brand + Brand Brain (crawl → proposed facts → you confirm; manual prohibited claims)
- Meta + Google **read** ingestion, unified daily metrics
- TryoutBrain conversion export + attribution (click-id/UTM, last-touch)
- **Today** screen + **Campaigns** (unified table) + **Approvals** inbox
- Deterministic detectors + Analyst (claim-typed, evidence-validated), morning run
- Action Engine with policies, approvals, idempotency, reconciliation, audit
- Creative Factory: copy + templated screenshot images (Meta) and RSAs + keywords (Google)
- **Writes:** Meta create campaign/ad set/ad (PAUSED) + activate + pause + budget; Google Search create (PAUSED) + activate + pause + budget + negatives
- **One mission** per brand with plan + ledger + progress
- Command bar: questions + proposals (no execution)
- Learnings: written by the weekly job and the mission close-out, editable

Out of V1: Reddit, ChatGPT Ads, Autopilot, PMax, video, AI image generation, multi-user, Fernz/Kompete onboarding, CAPI with hashed email, budget reallocation across channels as one action (V1 does it as two budget changes).

## 16. V2 scope
- Level 3 Autopilot for a whitelist: `PAUSE_AD` (detector-originated), `CHANGE_BUDGET` within ±20%, `ADD_NEGATIVE_KEYWORD`
- Meta CAPI / Google offline conversions for **paid** events, feeding value-based optimization
- Experiments as first-class (A/B with holdout budgets, Bayesian readout)
- Fernz as brand #2 (same export contract)
- AI image generation adapter; short-video concept → storyboard → render
- Fatigue/anomaly detectors with seasonality baselines (tryout season matters)
- Landing-page experiments (variant URLs on tryoutbrain.com, measured via the same export)

## 17. Later roadmap
- Reddit Ads adapter (Reddit Ads API v3)
- ChatGPT Ads adapter (Bulk Ads API + Conversions API), once Canada availability and API terms are verified
- Kompete as a client brand (client-owned ad accounts, client-approved policy, separate reporting)
- Cross-brand learnings ("Canadian youth-sports coaches respond to fairness framing")
- Budget allocation across missions/brands with a portfolio view
- pgvector retrieval over large creative and learning histories, if the corpus ever outgrows the prompt

## 18. Risks / API limitations

1. **Statistical power is the biggest real risk.** $1,000 at $20 CPA is about 50 conversions in total. Most comparisons will be noise. The system must say "inconclusive" often, test few hypotheses at a time (≤ 3 live), and optimize Meta on registrations, not paid.
2. **Seasonality.** Tryouts cluster in spring and late summer. CPA will swing for reasons no creative explains. Detectors need a season-aware baseline, and the analyst must know the calendar (a brand fact).
3. **Google developer token review** (backlog in 2026) can delay Google writes. Apply in week 1; Explorer access may arrive automatically.
4. **Ad review latency/rejections** on both platforms. "Executed" ≠ "live". Status sync must surface disapprovals.
5. **Attribution gaps:** iOS/ATT, cross-device, people who see an ad and type the URL later. Expect 20–40% of signups to be `unattributed`. Report it honestly rather than smearing it across channels.
6. **Privacy (Canada/PIPEDA, minors' platform):** no ad pixels in the app; org-level data only; sending hashed coach emails to Meta/Google is a decision for you (Q2).
7. **API churn:** Meta versions roughly every 4 months, Google Ads API versions sunset about 12 months after release. Pin versions in adapter config and keep a quarterly upgrade checklist.
8. **LLM hallucination:** mitigated by metric packs, claim validation, and propose-only tools. The residual risk is bad *ideas*, which approval catches.
9. **Token loss/compromise:** the system-user token can spend money. Secrets Manager, never logged, plus the platform spend cap limits the worst case.
10. **Meta Special Ad Category:** not applicable (not housing/employment/credit), but targeting by age near minors is sensitive. Target coaches/adults only.

## 19. Exact build sequence

See **V1 build plan** below. The order puts the read-only loop first, so nothing can spend money until Phase 10, and nothing spends without you until V2.

## 20. Proposed repository / file structure

```
marketingbrain/
  CLAUDE.md                 rules: propose-only AI, policy purity, PAUSED creation, mock mode
  .ai-review.json
  Dockerfile
  drizzle/                  migrations
  docs/  ACTIONS.md  ATTRIBUTION.md  ADAPTERS.md  RUNBOOK.md
  prompts/                  analyst.v1.md, strategist.v1.md, creative-meta.v1.md, …
  src/
    index.ts  app.ts        createApp() (listen-free for tests)
    config.ts               env + secrets loading, mock mode
    db/schema.ts  db/client.ts
    domain/                 zod: actions.ts, policy.ts, claims.ts, facts.ts, creative.ts
    auth/                   google-oidc.ts, sessions.ts, allowlist.ts
    brands/                 facts.ts, crawler.ts, extract.ts, brief.ts
    channels/
      adapter.ts            ChannelAdapter interface + capabilities
      mock/  meta/  google/ (client.ts, sync.ts, metrics.ts, execute.ts, reconcile.ts, spec.ts)
    ingest/                 structure.ts, metrics.ts, customerEvents.ts, attribute.ts
    analytics/              metricPack.ts, detectors/*.ts, ledger.ts
    ai/                     client.ts, run.ts (logging, cost), validateClaims.ts, tools.ts, functions/*.ts
    creative/               factory.ts, compliance.ts, render/ (templates/*.tsx, render.ts)
    missions/               missions.ts, plan.ts, progress.ts
    actions/                proposals.ts, policy.ts (pure), approve.ts, executor.ts, reconciler.ts, rollback.ts
    jobs/                   schedule.ts, *.job.ts
    routes/                 today.ts, missions.ts, creative.ts, campaigns.ts, learnings.ts, brands.ts, actions.ts, command.ts
  web/                      React app (Vite): pages/Today, Missions, Creative, Campaigns, Learnings, Brands, Settings; CommandBar
  tests/                    policy.test.ts (exhaustive), executor.idempotency.test.ts, claims.test.ts, adapters.contract.test.ts, …
  scripts/                  google-refresh-token.ts, seed-tryoutbrain.ts
```

---

## 21. Competitive design references

Added 2026-10-07 at Evan's request, after the plan above was drafted. Sources are the vendors' public sites, their published API docs and machine-readable discovery files, plus press coverage; none of these products was trialled. Where a page was marketing-only, I say so rather than guess.

### 21.1 Omneky (primary reference)

**What it actually is, as of today.** A creative-generation platform with a launcher bolted on. Its product list: Creative Generation Pro, Smart Ads (hundreds of variations from one brief), Video Ad Generator, AI Avatars (UGC-style spokesperson videos), Ad Launcher (Meta, Google, TikTok, LinkedIn, Reddit, OpenAI/ChatGPT Ads since Aug 2026), Insights (spend/ROAS/CTR/conversions vs prior period + an "AI Creative Score"), Creative Brief, and Brand (logos, colours, fonts, brand book, brand rules, default campaign settings, auto-generated from the website). Multi-brand with role-based access is an agency/enterprise feature. Self-serve pricing: Lite $29 (1 brand, 200 credits), Standard $99 (3 brands, 1,000 credits), Pro $249 (5 brands, 4,000 credits); image = 5–10 credits, video = 10–75 credits, "AI performance insights" = 1–2 credits per asset. Top-ups $1 per 10 credits.

**The API and the "MCP server", checked against primary sources, not the press release.**
- The public API has **two creation endpoints**, `POST /create_image_ad_async` and `POST /create_video_ad_async`, plus `GET /jobs/{id}`. Inputs: brand URL (it scrapes colours/fonts/logo) or explicit brand assets, product URL/name/description/images, your headline/subheadline/CTA/offer, aspect ratios, resolution, locale, a free-text creative direction. Output: rendered image or video files. 10 requests/min, 2–7 minute jobs, API key auth.
- The API does **not** expose launching, ad-account data, performance, insights, brand-rule enforcement, or audiences. The docs say so explicitly, and the "brand guardrails" are limited to the colours/fonts/logo you pass or it scrapes.
- `omneky.com/.well-known/mcp.json` states: *"Omneky does not currently expose a public Model Context Protocol server."* Programmatic access beyond the two endpoints is "request via support@omneky.com". The `agent-skills.json` file lists 12 skills (generate creative, smart variations, video, avatars, brief, launch, approve-and-launch, analyze performance, enforce brand guidelines, brand-tuned LLM, demo, trial), but these are **discovery descriptions of dashboard features, not callable tools**. The May-2026 press release's "MCP server" claim is ahead of what is actually published.
- The "AI Ad Agent" page ("ask your ads anything, launch the answer") has no technical documentation; the approval and compliance pages describe stakeholder sign-off and "compliance checks for regulated verticals" without specifics.

**Worth borrowing**
1. **Brand kit auto-generated from the URL, then edited by hand.** Exactly our Brand Brain crawl → proposed facts → confirm. Omneky validates that this is the right onboarding shape.
2. **"Default campaign settings" on the brand.** We should add per-brand defaults (geo, objective, placements, daily budget floor/ceiling, UTM template) so the strategist doesn't re-decide them every mission. Small schema addition: `brands.defaults` jsonb.
3. **One brief → many variations, per channel and per aspect ratio.** Our Creative Factory already fans out; the explicit "every aspect ratio from one concept" output contract (1:1, 4:5, 9:16, 16:9) should be part of `CreativeFormatSpec` from day one.
4. **Brand-tuned copy that learns from "historical winners".** We do this through `learnings` + top-performer examples in the prompt rather than a fine-tuned model, which is the right call at our volume.
5. **Multimodal creative tagging** (what's in the image: product screenshot, person, text density, colour, format). This is the missing piece in our lineage model: hypotheses tag *intent*, tags describe *what shipped*. Add `creative_variants.tags` (jsonb, produced by a Haiku vision pass at approval time) so the Performance Brain can compare "real screenshot vs illustration" even when the hypothesis didn't name it.
6. **Approve-and-launch as a single flow.** Our Approvals inbox should let one approval cover "these 4 variants + this campaign + activation", bundled as one proposal group, instead of 6 separate approvals.

**To avoid**
- **A "creative score" with no stated method.** Opaque scores hide sample-size problems; our claim validator and `insufficient_data` flags are the opposite philosophy.
- **The credit model as a cost control.** Our `ai_runs` cost log plus a monthly AI budget per brand is more honest for an internal tool.
- **Agent-launches-the-answer.** Omneky's agent goes from conversation to live spend; we keep the propose-only tool boundary.
- **"Let Omneky run it without an ad account."** Spend through a vendor's account would break our attribution, audit trail and platform-side spend caps.

**Unnecessary for private internal use:** seats/roles, white-label, enterprise IP allowlisting, UGC avatar videos (coaches will smell it), TikTok/LinkedIn, fundraising vertical, the public ad library, a creative-brief generator as a separate product (ours is a step inside the mission plan).

**Omneky's weak spot relative to our design:** everything learns at the creative level. Nothing on the site shows learning that survives a campaign and is stated as a business fact with evidence ("fairness messaging works for volleyball clubs"). Our `learnings` table with evidence refs and the hypothesis → hook → variant lineage is the differentiator, and it is also the part no vendor will sell us.

### 21.2 Smartly

Enterprise creative + media platform (Forrester Wave leader, enterprise pricing). Relevant pieces: **Automated Triggers** (conditions on campaign/ad set/ad → actions such as pause, budget up/down, rotate ads, weekend budget cuts), **ad rotation for fatigue**, **Predictive Budget Allocation** (ML reallocates across ad sets/campaigns before statistical significance, claimed ~11% uplift), **creative intelligence** (multivariate element testing: image × headline × CTA × format), **Brand Pulse** and a unified cross-channel view.

Worth borrowing: the trigger shape "level + metric + window + threshold → action" matches our detectors exactly and confirms the action vocabulary (pause, budget change, rotate). "Rotate" is worth adding as a derived proposal: `PAUSE_AD` + `ACTIVATE` of a waiting variant, so fatigue handling swaps rather than just cuts. Element-level attribution is what our lineage + tags give us.

To avoid: predictive reallocation that moves money *before* significance. That works at enterprise volume; at 50 conversions a mission it would chase noise. Our policy's `max_auto_shift_pct` and sample-size gates are the deliberate opposite. Unnecessary: programmatic/DSP, dynamic product feeds, team workflows.

### 21.3 Albert

Fully autonomous cross-channel media buyer: the marketer sets a goal, KPIs and guardrails plus a budget; Albert adjusts bids, audiences, schedules, devices and budget allocation continuously across search, social, video and programmatic. Humans keep strategy and creative; Albert does no copy or creative. Exploration appetite is tuned by giving it more budget or a looser goal.

Worth borrowing: **"goal + guardrails + budget cushion" as the control surface** is precisely our Mission + autonomy policy. The explicit idea that *the cushion between target CAC and acceptable CAC is the exploration budget* should become a mission field (`explore_cac_micros` or an "explore %" of budget) that the strategist allocates to new hypotheses versus proven ones. Also worth copying: Albert works *inside existing ad accounts* rather than its own, as we planned.

To avoid: Level 3 from day one, and cross-channel budget moves driven by short windows. Albert needs enterprise volume for its models; we should reach autopilot gradually, type by type. Unnecessary: DV360/programmatic, Bing, customer-success onboarding.

### 21.4 Optmyzr

The clearest model of **recommendation vs approval vs automation** among the four. Strategies are "funnels of stacked rules" with conditions over two date ranges, relative benchmarks ("1.5× the ad group's average CPA"), percentile operators ("bottom 10%"), external Google Sheets as inputs, and a **"recently changed" cooldown condition** that protects Smart Bidding learning periods. Every strategy previews suggested changes by default; automation has four modes (email the list, write to a sheet, add to alerts/Slack, apply changes), with apply off until deliberately enabled. Scheduled runs (daily/weekly/monthly, 3-hour slots) email a receipt even when nothing happened.

Worth borrowing, all of it cheap:
1. **Relative and dual-window conditions** in detectors, rather than fixed thresholds: "CPA over 7d > 1.5× trailing-28d CPA" ages better than "$30".
2. **Cooldown as a policy rule.** Add `min_hours_between_changes` per object and per action type to `autonomy_policies`; the policy evaluator blocks a proposal whose target was changed by MarketingBrain inside the window. This also protects Meta's learning phase.
3. **"Alert first, automate later" as the explicit path to Level 3.** Each action type carries its own mode (`never|approve|auto`), and the Settings page should show, per type, how many proposals you approved unchanged in the last 30 days, so the decision to flip a type to `auto` is evidence-based.
4. **A run receipt even when nothing was found.** The morning job posts "ran, nothing to propose" to Today; silence should never be ambiguous.

To avoid: a visual rule builder. For one user, detectors as code with tests are simpler and safer. Unnecessary: cross-account portfolio deployment, Amazon/Microsoft Ads, spreadsheet exports.

### 21.5 Build our own Creative Factory, or integrate Omneky?

**Decision: build our own Creative Factory, and keep Omneky's two generation endpoints as an optional `ImageGenAdapter` behind an interface, not as the creative layer.**

Reasons, in order of weight:
1. **The API only renders.** Given a URL, a product and *your* headline/CTA, Omneky returns images or video. It does not do the parts that make our factory worth having: hypotheses, hooks, audience/offer linkage, channel-native copy (Google RSAs, keywords), compliance against our prohibited claims, descendants of winners, or anything that feeds `learnings`. Everything upstream of "render" we would have to build anyway.
2. **No launching, no performance, no MCP.** The public API carries no ad-account, insight or launch capability, and the MCP server does not exist yet despite the press. Integrating the "agent" would mean driving a dashboard, which is not integration.
3. **Our V1 image strategy is real screenshots in fixed templates**, which Omneky cannot produce; it composes from product photos and a scraped brand kit. For a B2B tool sold to coaches, the screenshot of the Room *is* the creative.
4. **Lock-in and attribution.** Credits per asset are fine, but the value we want compounds in our own tables (tags, lineage, learnings). A vendor's "AI Creative Score" never becomes a brand fact.
5. **Cost is not the issue.** Lite at $29/month with 200 credits would be cheap enough; it simply does not buy the right thing.

Where Omneky *would* earn a place, in V2 or later:
- **Video.** Product-image → 10–15 s product animation / short commercial is the one output we have no cheap path to. An `OmnekyVideoAdapter` behind `VideoAdapter` (input: our brand kit + screenshots + our approved copy; output: file in `brand_assets`) is a two-day job once the factory exists.
- **Illustrated image variants** to test *against* screenshots. Same adapter pattern, same approval gate, variants tagged `visual_style: generated` so the comparison lands in `learnings`.
- Re-evaluate if Omneky ships the MCP server with real tools (performance read, launch), but even then only for generation; the Action Engine stays ours.

### 21.6 Changes to the architecture that this review suggests

None change the approved shape. All are additive and small; I'd fold them into the phases shown rather than adding phases.

| Change | Where | Phase |
|---|---|---|
| `brands.defaults` jsonb: default geo, objective, placements, budget floor/ceiling, UTM template | §3 Brand Brain | 2 |
| `creative_variants.tags` jsonb from a vision/text tagging pass at approval; tag vocabulary shared with `hypotheses.dimensions` | §3, §9 | 13 |
| Aspect-ratio fan-out (1:1, 4:5, 9:16, 16:9) in `CreativeFormatSpec` and the template renderer | §9 | 13 |
| `autonomy_policies.rules.cooldowns`: min hours between MarketingBrain changes per object and per action type; policy evaluator enforces | §11 | 11 |
| Detector conditions expressed relatively and over two windows (7d vs trailing 28d, percentile within campaign) | §10 | 10 |
| Proposal **groups**: one approval can cover variants + campaign + activation | §11, Approvals UI | 11–12 |
| `ROTATE_AD` as a composite proposal (pause one, activate a waiting variant) | §11 action types | 12 |
| Mission `explore_share` (share of budget / CAC cushion reserved for untested hypotheses) used by the strategist | §8 | 15 |
| Per-action-type "approved unchanged in last 30 days" counter on Settings, as the evidence for flipping a type to `auto` in V2 | §11, §16 | 16 |
| Morning job posts a receipt to Today even when it proposes nothing | §10 | 10 |
| `ImageGenAdapter` / `VideoAdapter` interfaces reserved in `creative/render/`; Omneky as the first implementation in V2 | §9, §16 | V2 |

Sources: [Omneky API docs](https://www.omneky.com/api-docs) · [Omneky mcp.json](https://www.omneky.com/.well-known/mcp.json) · [Omneky agent-skills.json](https://www.omneky.com/.well-known/agent-skills.json) · [Omneky llms.txt](https://www.omneky.com/llms.txt) · [Omneky pricing](https://www.omneky.com/pricing-plans) · [Omneky API/MCP press release](https://www.prnewswire.com/news-releases/omneky-launches-public-api-and-mcp-server-bringing-autonomous-ad-creative-generation-to-any-platform-or-ai-agent-302822766.html) · [Omneky ChatGPT Ads launch](https://finance.yahoo.com/media-advertising/articles/omneky-launches-self-chatgpt-advertising-123300664.html) · [Omneky Insights](https://omneky.com/omnichannel-insights) · [Smartly triggers](https://www.smartly.io/product-features/triggers) · [Smartly platform overview](https://smartly.io/product/platform-overview) · [Segwise comparison of AI ad platforms](https://segwise.ai/blog/ai-ad-platforms-compared-8-tools-machine-learning.md) · [Albert FAQ](https://albert.ai/faq/) · [Optmyzr Rule Engine](https://www.optmyzr.com/solutions/rule-engine/) · [Optmyzr automation help](https://help.optmyzr.com/en/articles/3076120-automation-in-rule-engine) · [Optmyzr vs Google automated rules](https://www.optmyzr.com/blog/optmyzr-rule-engine-vs-google-ads-automated-rules/)

---

# MARKETINGBRAIN V1 BUILD PLAN

Each phase ends with something testable. **Bold = needs you** (accounts, approvals, real spend).

| # | Phase | Done when | Money at risk |
|---|---|---|---|
| **0** | **Accounts (you, in parallel, day 1):** create GitHub repo `marketingbrain`; Meta app + System User with `ads_management` on the TryoutBrain ad account/Page/IG; Google Ads MCC + **apply for developer token**; GCP OAuth client; set **Meta account spending limit** and Google budget ceilings by hand | Tokens exist in Secrets Manager (not chat) | none |
| 1 | Skeleton: Express+Vite+Drizzle+pg-boss, config/mock mode, Google sign-in + allowlist, CI on PR, CLAUDE.md, `.ai-review.json` | Sign in locally; `pnpm.cmd test` green | none |
| 2 | Core schema + seed TryoutBrain brand + autonomy policy v1 (Level 2) | Migrations apply; seed visible | none |
| 3 | `ChannelAdapter` interface + mock adapter + contract tests | Mock account syncs into `ext_objects`/`metrics_daily` | none |
| 4 | Meta **read**: structure + insights ingestion, trailing-window upsert, rate-limit backoff | Real TryoutBrain Meta data matches Ads Manager totals for 7 days (±rounding) | none |
| 5 | Google **read**: GAQL structure + metrics + search terms | Real data matches the Google Ads UI | none |
| 6 | **TryoutBrain PR** (separate repo, REVIEW): click-id/UTM first-touch capture → `organizations.acquisition`; signed `/api/internal/marketing/events` | Staging returns events; tenant/PII test proves no personal data in output | none |
| 7 | Customer-event pull + attribution + Today/Campaigns screens (spend → registrations → paid → CAC) | Today shows month spend, registrations, CPA, CAC from real data | none |
| 8 | **Deploy** to AWS (ECS, RDS, S3, ALB, domain); scheduled ingestion runs daily | Morning numbers appear without you doing anything | none |
| 9 | Brand Brain: crawler → proposed facts → review/edit UI; prohibited claims; Brand Brief renderer | You've confirmed TryoutBrain's facts | none |
| 10 | Analytics: metric packs + detectors; Analyst with claim validator; morning analysis on Today | A morning report where every number traces to evidence | none |
| 11 | Action Engine: proposal types, pure policy evaluator (exhaustive tests), approvals inbox, executor + reconciler + rollback against **mock** adapter | Double-fire, timeout and stale-state tests pass | none |
| 12 | Meta **write**: pause/activate/budget, upload image, create campaign→ad set→ad PAUSED, name-tag reconcile | **You approve one $5/day test ad;** it's created paused, then activated by a second approval | **≈ $5/day, capped** |
| 13 | Creative Factory: hypotheses → hooks → variants (Meta copy + templated screenshot images; Google RSA + keywords), compliance check, approval → CREATE proposals | 10 approved variants from one hypothesis, all within platform limits | none |
| 14 | Google **write**: Search campaign create (validate_only first) PAUSED, activate, pause, budget, negatives | **You approve one small Search campaign** | **small, capped** |
| 15 | Missions + experiments: create from text → strategist plan → ≤ 3 experiments → proposals; mission and experiment ledgers; daily progress job closes experiments with a conclusion | "50 coaches at <$20 with $1,000" becomes a plan + proposals you can approve | per your approvals |
| 16 | Command bar: read tools + propose tools; answers in claim format | The seven example commands answer or propose correctly | none (propose-only) |
| 17 | Learnings: weekly distillation job (thresholded), mission close-out, Learnings page, fed back into strategist/creative | The first learnings exist with evidence, and the next creative run cites them | none |

**Milestone check:** after Phase 15 the loop you asked for is closed: connected → ingested → dashboard → analysis → proposals → you approve → it ships → results flow back. Phases 16–17 make it pleasant and make it learn.

## Assumptions (correct any that are wrong)
1. TryoutBrain already has (or you'll create) a Meta ad account, Page, IG account and a Google Ads account, all owned by your business.
2. Ad spend is in CAD for both accounts.
3. You're the only user in V1.
4. Kompete waits until V2 or later, and will advertise from the client's own accounts with their approval.
5. Hosting cost of ≈ $50–65/month plus LLM usage is acceptable.
6. No staging for MarketingBrain itself; TryoutBrain changes go through its own staging.
7. Copy is English only in V1 (French for Quebec later).

## Questions
- **Q1 (domain):** host it at `mb.elitesultimate.com`, or another domain you own? Not blocking until Phase 8.
- **Q2 (privacy):** in V2, may MarketingBrain send **SHA-256-hashed coach emails** to Meta/Google to improve conversion matching? V1 doesn't need it (click IDs only).
