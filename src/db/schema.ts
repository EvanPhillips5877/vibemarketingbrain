import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AutonomyLevel, AutonomyRules } from "../domain/policy.js";
import type { BrandDefaults, FactCategory, FactSource, FactStatus } from "../domain/brand.js";

// The source of truth for every table. docs/ARCHITECTURE.md §3 explains the
// shape; comments here say only what the code cannot. Money is integer
// micros (1 CAD = 1_000_000) with the currency on the brand or account, as
// Google reports it. Dates in metrics are the ad account's own day.

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const micros = (name: string) => bigint(name, { mode: "number" });

/* ── People and sessions (Phase 1) ─────────────────────────────────── */

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});
export type User = typeof users.$inferSelect;

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    csrfToken: text("csrf_token").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_sessions_user").on(t.userId), index("idx_sessions_expires").on(t.expiresAt)],
);
export type Session = typeof sessions.$inferSelect;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actor: text("actor").notNull(), // an email, or "system:<job>"
    verb: text("verb").notNull(),
    subject: text("subject"),
    data: jsonb("data").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_audit_events_at").on(t.at)],
);
export type AuditEvent = typeof auditEvents.$inferSelect;

/* ── Brand Brain ───────────────────────────────────────────────────── */

export type BrandStatus = "active" | "halted"; // halted = kill switch: nothing executes

export const brands = pgTable("brands", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  website: text("website").notNull(),
  defaultCurrency: text("default_currency").notNull().default("CAD"),
  timezone: text("timezone").notNull().default("America/Toronto"),
  status: text("status").$type<BrandStatus>().notNull().default("active"),
  // Per-brand campaign defaults the strategist starts from (geo, objective,
  // budget floor/ceiling, UTM template). Validated by BrandDefaults in domain/.
  defaults: jsonb("defaults").$type<BrandDefaults>().notNull(),
  // Where the brand's own app exports its funnel (org-level rows), and the
  // name of the secret holding the bearer token. Null url = mock source.
  eventsExportUrl: text("events_export_url"),
  eventsExportSecretRef: text("events_export_secret_ref"),
  eventsCursor: text("events_cursor"),
  eventsPulledAt: timestamp("events_pulled_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export type Brand = typeof brands.$inferSelect;

// Structured business facts. `proposed` rows come from the crawler or a
// model and mean nothing until a person makes them `active`.
export const brandFacts = pgTable(
  "brand_facts",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    category: text("category").$type<FactCategory>().notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    source: text("source").$type<FactSource>().notNull(),
    sourceUrl: text("source_url"),
    confidence: real("confidence"),
    status: text("status").$type<FactStatus>().notNull().default("proposed"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_brand_facts_brand_category").on(t.brandId, t.category),
    // At most one active and one proposed fact per (brand, category, key):
    // a proposal can sit beside the active fact it would replace. History
    // lives in retired rows. Partial, so inserts can rely on it atomically.
    uniqueIndex("uq_brand_facts_key_status").on(t.brandId, t.category, t.key, t.status).where(sql`status <> 'retired'`),
  ],
);
export type BrandFact = typeof brandFacts.$inferSelect;

// A page of the brand's own site as last crawled: what the extractor reads.
// Text is clipped; it is data for a prompt, never an instruction.
export const brandPages = pgTable(
  "brand_pages",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    headings: text("headings").array().notNull().default(sql`'{}'::text[]`),
    text: text("text").notNull().default(""),
    httpStatus: integer("http_status"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_brand_pages_url").on(t.brandId, t.url)],
);
export type BrandPage = typeof brandPages.$inferSelect;

export type AssetKind = "screenshot" | "logo" | "photo" | "video" | "font" | "rendered";

export const brandAssets = pgTable("brand_assets", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  kind: text("kind").$type<AssetKind>().notNull(),
  storageKey: text("storage_key").notNull(), // S3 key later; local path in dev
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  width: integer("width"),
  height: integer("height"),
  approved: boolean("approved").notNull().default(false),
  createdAt: createdAt(),
});
export type BrandAsset = typeof brandAssets.$inferSelect;

export const offers = pgTable("offers", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  terms: text("terms"),
  landingUrl: text("landing_url").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});
export type Offer = typeof offers.$inferSelect;

export const audiences = pgTable("audiences", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Channel-neutral: geo, sport, role, interests/keywords. Adapters map it.
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  channelMapping: jsonb("channel_mapping").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
});
export type Audience = typeof audiences.$inferSelect;

/* ── Channels and the platform mirror ──────────────────────────────── */

export type Channel = "meta" | "google" | "reddit" | "chatgpt" | "mock";
export type ChannelAccountStatus = "active" | "paused" | "disconnected";

export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    channel: text("channel").$type<Channel>().notNull(),
    externalAccountId: text("external_account_id").notNull(),
    currency: text("currency").notNull(),
    timezone: text("timezone").notNull(),
    // Name of the secret (Secrets Manager ARN or env var), never the token.
    secretRef: text("secret_ref"),
    status: text("status").$type<ChannelAccountStatus>().notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("uq_channel_accounts").on(t.brandId, t.channel, t.externalAccountId)],
);
export type ChannelAccount = typeof channelAccounts.$inferSelect;

export type ExtObjectKind = "campaign" | "ad_group" | "ad" | "creative" | "keyword" | "asset";

// One table for every object on every platform. The platform is the source
// of truth for these rows; sync overwrites them.
export const extObjects = pgTable(
  "ext_objects",
  {
    id: id(),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ExtObjectKind>().notNull(),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id"),
    name: text("name"),
    status: text("status"),
    dailyBudgetMicros: micros("daily_budget_micros"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    // Our side of the join: which mission/experiment/variant/action made it.
    // Plain uuids (no FK) so a sync row can exist before or after ours.
    missionId: uuid("mission_id"),
    experimentId: uuid("experiment_id"),
    creativeVariantId: uuid("creative_variant_id"),
    createdByActionId: uuid("created_by_action_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_ext_objects").on(t.channelAccountId, t.kind, t.externalId),
    index("idx_ext_objects_mission").on(t.missionId),
    index("idx_ext_objects_experiment").on(t.experimentId),
  ],
);
export type ExtObject = typeof extObjects.$inferSelect;

// Upserted over a trailing window because platforms restate recent days.
export const metricsDaily = pgTable(
  "metrics_daily",
  {
    extObjectId: uuid("ext_object_id")
      .notNull()
      .references(() => extObjects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    spendMicros: micros("spend_micros").notNull().default(0),
    platformConversions: jsonb("platform_conversions").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    frequency: real("frequency"),
    reach: integer("reach"),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [primaryKey({ columns: [t.extObjectId, t.date] }), index("idx_metrics_daily_date").on(t.date)],
);
export type MetricsDaily = typeof metricsDaily.$inferSelect;

/* ── Revenue truth, pulled from the brand's own app ─────────────────── */

export type CustomerStage = "registered" | "activated" | "paid" | "churned";
export type AttributionMethod = "click_id" | "utm_content" | "utm_campaign" | "utm_source" | "unattributed";

// Org-level only. external_customer_id is the brand app's organization id;
// never a person. Enforced by the export contract, re-checked here by review.
export const customerEvents = pgTable(
  "customer_events",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    externalCustomerId: text("external_customer_id").notNull(),
    stage: text("stage").$type<CustomerStage>().notNull(),
    valueMicros: micros("value_micros"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    firstTouch: jsonb("first_touch").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    attributedExtObjectId: uuid("attributed_ext_object_id").references(() => extObjects.id, { onDelete: "set null" }),
    // Known even when no object is: a gclid says "google" without saying which ad.
    attributedChannel: text("attributed_channel").$type<Channel>(),
    attributionMethod: text("attribution_method").$type<AttributionMethod>(),
    plan: text("plan"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("uq_customer_events").on(t.brandId, t.externalCustomerId, t.stage),
    index("idx_customer_events_occurred").on(t.brandId, t.occurredAt),
    index("idx_customer_events_unattributed").on(t.brandId).where(sql`attribution_method is null`),
  ],
);
export type CustomerEvent = typeof customerEvents.$inferSelect;

/* ── Missions, hypotheses, creative lineage ─────────────────────────── */

export type MissionStatus = "draft" | "active" | "paused" | "done";

export const missions = pgTable("missions", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  objectiveText: text("objective_text").notNull(),
  goal: jsonb("goal").$type<{ metric: string; target: number }>().notNull(),
  targetCacMicros: micros("target_cac_micros"),
  budgetMicros: micros("budget_micros").notNull(),
  // Share of budget reserved for untested hypotheses vs. proven ones.
  exploreShare: real("explore_share").notNull().default(0.3),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  markets: text("markets").array().notNull().default(sql`'{}'::text[]`),
  channels: text("channels").array().notNull().default(sql`'{}'::text[]`),
  status: text("status").$type<MissionStatus>().notNull().default("draft"),
  plan: jsonb("plan").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export type Mission = typeof missions.$inferSelect;

export type HypothesisStatus = "untested" | "testing" | "supported" | "refuted" | "inconclusive";

export const hypotheses = pgTable("hypotheses", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
  statement: text("statement").notNull(),
  // Shared vocabulary with learnings.dimensions and creative_variants.tags:
  // angle, pain_point, audience, offer, visual_style, sport, geo, ...
  dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").$type<HypothesisStatus>().notNull().default("untested"),
  parentId: uuid("parent_id"),
  createdAt: createdAt(),
});
export type Hypothesis = typeof hypotheses.$inferSelect;

export const hooks = pgTable("hooks", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  hookType: text("hook_type").notNull(), // pain | fairness | time_saving | social_proof | ...
  createdAt: createdAt(),
});
export type Hook = typeof hooks.$inferSelect;

export type CreativeStatus = "draft" | "active" | "retired";

export const creatives = pgTable("creatives", {
  id: id(),
  brandId: uuid("brand_id")
    .notNull()
    .references(() => brands.id, { onDelete: "cascade" }),
  hypothesisId: uuid("hypothesis_id").references(() => hypotheses.id, { onDelete: "set null" }),
  hookId: uuid("hook_id").references(() => hooks.id, { onDelete: "set null" }),
  offerId: uuid("offer_id").references(() => offers.id, { onDelete: "set null" }),
  audienceId: uuid("audience_id").references(() => audiences.id, { onDelete: "set null" }),
  concept: text("concept").notNull(),
  parentCreativeId: uuid("parent_creative_id"), // descendants of a winner
  status: text("status").$type<CreativeStatus>().notNull().default("draft"),
  createdAt: createdAt(),
});
export type Creative = typeof creatives.$inferSelect;

export type VariantStatus = "draft" | "approved" | "live" | "retired";

export const creativeVariants = pgTable("creative_variants", {
  id: id(),
  creativeId: uuid("creative_id")
    .notNull()
    .references(() => creatives.id, { onDelete: "cascade" }),
  channel: text("channel").$type<Channel>().notNull(),
  format: text("format").notNull(), // meta_image | meta_video | google_rsa | ...
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  renderedAssetIds: uuid("rendered_asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
  // What actually shipped (visual_style, has_screenshot, text_density, ...),
  // tagged at approval so performance can be compared by element.
  tags: jsonb("tags").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  status: text("status").$type<VariantStatus>().notNull().default("draft"),
  createdAt: createdAt(),
});
export type CreativeVariant = typeof creativeVariants.$inferSelect;

/* ── Learnings and experiments ─────────────────────────────────────── */

export type LearningKind = "observation" | "hypothesis" | "validated" | "refuted";
export type LearningScope = "audience" | "creative" | "channel" | "geo" | "funnel";

// Knowledge that outlives a campaign. brand_id null = holds across brands.
// `validated` / `refuted` may only be written from a closed experiment.
export const learnings = pgTable("learnings", {
  id: id(),
  brandId: uuid("brand_id").references(() => brands.id, { onDelete: "cascade" }),
  statement: text("statement").notNull(),
  kind: text("kind").$type<LearningKind>().notNull(),
  scope: text("scope").$type<LearningScope>().notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  confidence: real("confidence"),
  status: text("status").$type<"active" | "retired">().notNull().default("active"),
  supersedesId: uuid("supersedes_id"),
  createdBy: text("created_by").notNull(), // job:<name> | ai:<run_id> | manual:<email>
  createdAt: createdAt(),
});
export type Learning = typeof learnings.$inferSelect;

export type ExperimentStatus = "planned" | "running" | "ended";
export type ExperimentConclusion = "supported" | "refuted" | "inconclusive";
export type PrimaryMetric = "cpa" | "registration_rate" | "ctr" | "paid_cac";

// The unit of deliberate learning. At most N running per mission (policy).
export const experiments = pgTable(
  "experiments",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    hypothesisId: uuid("hypothesis_id")
      .notNull()
      .references(() => hypotheses.id, { onDelete: "restrict" }),
    audienceId: uuid("audience_id").references(() => audiences.id, { onDelete: "set null" }),
    offerId: uuid("offer_id").references(() => offers.id, { onDelete: "set null" }),
    channel: text("channel").$type<Channel>().notNull(),
    name: text("name").notNull(),
    primaryMetric: text("primary_metric").$type<PrimaryMetric>().notNull(),
    targetValue: real("target_value"),
    budgetMicros: micros("budget_micros").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    status: text("status").$type<ExperimentStatus>().notNull().default("planned"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    conclusion: text("conclusion").$type<ExperimentConclusion>(),
    concludedAt: timestamp("concluded_at", { withTimezone: true }),
    learningId: uuid("learning_id").references(() => learnings.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("idx_experiments_mission_status").on(t.missionId, t.status)],
);
export type Experiment = typeof experiments.$inferSelect;

export const experimentVariants = pgTable(
  "experiment_variants",
  {
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiments.id, { onDelete: "cascade" }),
    creativeVariantId: uuid("creative_variant_id")
      .notNull()
      .references(() => creativeVariants.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.experimentId, t.creativeVariantId] })],
);

/* ── Action Engine ─────────────────────────────────────────────────── */

// Immutable rows; the highest version for a brand is in force.
export const autonomyPolicies = pgTable(
  "autonomy_policies",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    level: text("level").$type<AutonomyLevel>().notNull(),
    rules: jsonb("rules").$type<AutonomyRules>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("uq_autonomy_policies_version").on(t.brandId, t.version)],
);
export type AutonomyPolicy = typeof autonomyPolicies.$inferSelect;

export type ProposalStatus =
  | "proposed"
  | "blocked"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed"
  | "unknown"
  | "rolled_back"
  | "expired";

export const actionProposals = pgTable(
  "action_proposals",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    missionId: uuid("mission_id").references(() => missions.id, { onDelete: "set null" }),
    experimentId: uuid("experiment_id").references(() => experiments.id, { onDelete: "set null" }),
    groupId: uuid("group_id"), // one approval can cover a group
    type: text("type").notNull(), // ActionType in domain/policy.ts
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    expectedOutcome: text("expected_outcome"),
    confidence: real("confidence"),
    source: text("source").notNull(), // detector:<name> | ai:<run_id> | command:<id> | manual:<email>
    policyVersion: integer("policy_version"),
    policyResult: jsonb("policy_result").$type<Record<string, unknown>>(),
    status: text("status").$type<ProposalStatus>().notNull().default("proposed"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_action_proposals_brand_status").on(t.brandId, t.status)],
);
export type ActionProposal = typeof actionProposals.$inferSelect;

export const actionExecutions = pgTable("action_executions", {
  id: id(),
  proposalId: uuid("proposal_id")
    .notNull()
    .references(() => actionProposals.id, { onDelete: "cascade" }),
  attempt: integer("attempt").notNull().default(1),
  adapter: text("adapter").notNull(),
  request: jsonb("request").$type<Record<string, unknown>>().notNull(),
  response: jsonb("response").$type<Record<string, unknown>>(),
  externalIds: jsonb("external_ids").$type<Record<string, string>>(),
  rollback: jsonb("rollback").$type<Record<string, unknown>>(), // the inverse action, when known
  outcome: text("outcome").$type<"executed" | "failed" | "unknown">(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export type ActionExecution = typeof actionExecutions.$inferSelect;

// A morning (or on-demand) analysis: the pack it was built from, the
// detectors' findings, the claims that survived validation, and the ones
// that did not. Kept whole so any number on the screen can be traced.
export const analysisReports = pgTable(
  "analysis_reports",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("morning"),
    windowFrom: date("window_from").notNull(),
    windowTo: date("window_to").notNull(),
    pack: jsonb("pack").$type<Record<string, unknown>>().notNull(),
    findings: jsonb("findings").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    analysis: jsonb("analysis").$type<Record<string, unknown>>().notNull(),
    dropped: jsonb("dropped").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    aiRunId: uuid("ai_run_id"),
    isMock: boolean("is_mock").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_analysis_reports_brand_created").on(t.brandId, t.createdAt)],
);
export type AnalysisReport = typeof analysisReports.$inferSelect;

export const aiRuns = pgTable("ai_runs", {
  id: id(),
  brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
  fn: text("fn").notNull(), // analyst | strategist | creative | command | extract
  promptVersion: text("prompt_version").notNull(),
  model: text("model").notNull(),
  inputRefs: jsonb("input_refs").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  output: jsonb("output").$type<Record<string, unknown>>(),
  validationErrors: jsonb("validation_errors").$type<unknown[]>(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costMicros: micros("cost_micros"),
  createdAt: createdAt(),
});
export type AiRun = typeof aiRuns.$inferSelect;
