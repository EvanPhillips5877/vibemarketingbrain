import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMockChannelAccount, seedTryoutBrain } from "../src/brands/seed-tryoutbrain.js";
import { AdapterRegistry } from "../src/channels/registry.js";
import { brands, customerEvents, type Brand } from "../src/db/schema.js";
import { exportRowSchema, HttpExportSource, MockExportSource, pullCustomerEvents, sourceFor } from "../src/ingest/customerEvents.js";
import { isoDay, syncMetrics } from "../src/ingest/metrics.js";
import { syncStructure } from "../src/ingest/structure.js";
import { getSecret } from "../src/secrets.js";
import { makeContext } from "./helpers.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  organizationId: id,
  registeredAt: "2026-09-10T15:00:00.000Z",
  activatedAt: "2026-09-11T15:00:00.000Z",
  paidAt: null,
  plan: "free",
  subscriptionStatus: "active",
  primarySport: "volleyball",
  acquisition: { gclid: "G-1", utmCampaign: "spring" },
  updatedAt: "2026-09-11T15:00:00.000Z",
  ...extra,
});

describe("export row schema", () => {
  it("strips anything personal that a future export might carry", () => {
    const parsed = exportRowSchema.parse(row("org-1", { name: "Ottawa VC", contactEmail: "x@y.z", acquisition: { gclid: "G", email: "a@b.c" } }));
    expect(JSON.stringify(parsed)).not.toMatch(/Ottawa|x@y\.z|a@b\.c/);
    expect(parsed.acquisition).toEqual({ gclid: "G" });
  });
  it("rejects a row without an id or with a bad timestamp", () => {
    expect(exportRowSchema.safeParse(row("")).success).toBe(false);
    expect(exportRowSchema.safeParse(row("x", { registeredAt: "yesterday" })).success).toBe(false);
  });
});

describe("getSecret", () => {
  it("reads a name from the environment and refuses values-as-names", () => {
    expect(getSecret("SOME_TOKEN", { SOME_TOKEN: " abc " })).toBe("abc");
    expect(getSecret("SOME_TOKEN", {})).toBeNull();
    expect(getSecret("not-a-name", { "not-a-name": "x" })).toBeNull();
    expect(getSecret(null)).toBeNull();
  });
});

describe("pullCustomerEvents", () => {
  const ctx = makeContext();
  const db = ctx.handle.db;
  let brand: Brand;
  beforeAll(async () => {
    const r = await seedTryoutBrain(db);
    brand = (await db.select().from(brands).where(eq(brands.id, r.brandId)))[0]!;
    await db.delete(customerEvents).where(eq(customerEvents.brandId, brand!.id));
  });
  afterAll(() => ctx.handle.close());

  it("pages through an HTTP export with a bearer token and stores one row per stage reached", async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, auth: (init?.headers as Record<string, string>)["authorization"] });
      const u = new URL(url);
      const page = u.searchParams.get("cursor") ? { rows: [row("org-3", { paidAt: "2026-09-20T00:00:00Z", plan: "club" })], next: null } : { rows: [row("org-1"), row("org-2", { activatedAt: null }), { junk: true }], next: "2026-09-11T15:00:00.000Z|org-2" };
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = new HttpExportSource("https://example.test/api/internal/marketing/events", "tok-not-real", fetchImpl);
    const r = await pullCustomerEvents(db, brand!, source, { limit: 2 });
    expect(r).toMatchObject({ pages: 2, rowsSeen: 4, rowsRejected: 1, isMock: false });
    expect(calls[0]!.auth).toBe("Bearer tok-not-real");
    expect(calls[0]!.url).toContain("since=");
    expect(calls[1]!.url).toContain("cursor=");
    const rows = await db.select().from(customerEvents).where(eq(customerEvents.brandId, brand!.id));
    const stages = (id: string) => rows.filter((x) => x.externalCustomerId === id).map((x) => x.stage).sort();
    expect(stages("org-1")).toEqual(["activated", "registered"]);
    expect(stages("org-2")).toEqual(["registered"]);
    expect(stages("org-3")).toEqual(["activated", "paid", "registered"]);
    expect(rows.find((x) => x.externalCustomerId === "org-3" && x.stage === "paid")?.plan).toBe("club");
    const [b] = await db.select().from(brands).where(eq(brands.id, brand!.id));
    expect(b?.eventsPulledAt).not.toBeNull();
  });

  it("is idempotent and keeps attribution when a row is restated with the same first touch", async () => {
    await db.update(customerEvents).set({ attributionMethod: "click_id", attributedChannel: "google" }).where(and(eq(customerEvents.externalCustomerId, "org-1"), eq(customerEvents.stage, "registered")));
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ rows: [row("org-1", { registeredAt: "2026-09-10T16:00:00.000Z" })], next: null }));
    const before = (await db.select().from(customerEvents).where(eq(customerEvents.brandId, brand!.id))).length;
    await pullCustomerEvents(db, brand!, new HttpExportSource("https://example.test/x", "t", fetchImpl));
    const after = await db.select().from(customerEvents).where(eq(customerEvents.brandId, brand!.id));
    expect(after).toHaveLength(before);
    const reg = after.find((x) => x.externalCustomerId === "org-1" && x.stage === "registered")!;
    expect(reg.occurredAt.toISOString()).toBe("2026-09-10T16:00:00.000Z");
    expect(reg.attributionMethod).toBe("click_id");
  });

  it("forgets attribution when the first touch itself is restated", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ rows: [row("org-1", { acquisition: { fbclid: "changed" } })], next: null }));
    await pullCustomerEvents(db, brand!, new HttpExportSource("https://example.test/x", "t", fetchImpl));
    const reg = (await db.select().from(customerEvents).where(and(eq(customerEvents.externalCustomerId, "org-1"), eq(customerEvents.stage, "registered"))))[0]!;
    expect(reg.firstTouch).toEqual({ fbclid: "changed" });
    expect(reg.attributionMethod).toBeNull();
    expect(reg.attributedChannel).toBeNull();
  });

  it("resumes from the stored cursor after hitting the page cap, and only then moves the watermark", async () => {
    const pagesServed: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const u = new URL(String(input));
      const c = u.searchParams.get("cursor");
      pagesServed.push(c);
      const n = c ? Number(c.split("|")[1]) + 1 : 0;
      const next = n < 4 ? `t|${n}` : null; // five pages in all: 0..4
      return new Response(JSON.stringify({ rows: [row(`page-org-${n}`)], next }));
    };
    const source = new HttpExportSource("https://example.test/x", "t", fetchImpl);
    const fresh = { ...brand!, eventsCursor: null, eventsPulledAt: null };
    const first = await pullCustomerEvents(db, fresh, source, { maxPages: 2 });
    expect(first.pages).toBe(2);
    expect(first.cursor).toBe("t|1");
    let [b] = await db.select().from(brands).where(eq(brands.id, brand!.id));
    expect(b?.eventsCursor).toBe("t|1");
    const second = await pullCustomerEvents(db, b!, source, { maxPages: 10 });
    expect(pagesServed.slice(2)[0]).toBe("t|1"); // picked up where it stopped
    expect(second.cursor).toBeNull();
    [b] = await db.select().from(brands).where(eq(brands.id, brand!.id));
    expect(b?.eventsCursor).toBeNull();
    expect(b?.eventsPulledAt).not.toBeNull();
    const ids = (await db.select().from(customerEvents).where(eq(customerEvents.brandId, brand!.id))).map((x) => x.externalCustomerId);
    for (let i = 0; i < 5; i++) expect(ids).toContain(`page-org-${i}`);
  });

  it("a mock pull never moves the real watermark or cursor", async () => {
    await db.update(brands).set({ eventsCursor: "keep|me", eventsPulledAt: null }).where(eq(brands.id, brand!.id));
    const [b] = await db.select().from(brands).where(eq(brands.id, brand!.id));
    await pullCustomerEvents(db, b!, new MockExportSource(db, brand!.id));
    const [after] = await db.select().from(brands).where(eq(brands.id, brand!.id));
    expect(after?.eventsCursor).toBe("keep|me");
    expect(after?.eventsPulledAt).toBeNull();
    await db.update(brands).set({ eventsCursor: null }).where(eq(brands.id, brand!.id));
  });

  it("fails without leaking the response body on a non-200", async () => {
    const fetchImpl: typeof fetch = async () => new Response("secret-ish body", { status: 500 });
    await expect(pullCustomerEvents(db, brand!, new HttpExportSource("https://example.test/x", "t", fetchImpl))).rejects.toThrow(/answered 500/);
  });

  it("uses the mock source when the brand has no URL or its token is missing", async () => {
    expect(sourceFor(db, { ...brand!, eventsExportUrl: null }, {}).isMock).toBe(true);
    expect(sourceFor(db, { ...brand!, eventsExportUrl: "https://x.test", eventsExportSecretRef: "TOK_REF" }, {}).isMock).toBe(true);
    expect(sourceFor(db, { ...brand!, eventsExportUrl: "https://x.test", eventsExportSecretRef: "TOK_REF" }, { TOK_REF: "tok" }).isMock).toBe(false);
  });

  it("mock source invents a funnel from the mock account and is deterministic", async () => {
    const account = await seedMockChannelAccount(db, brand!.id);
    const adapter = new AdapterRegistry(ctx.config).get("mock")!;
    await syncStructure(db, adapter, account);
    await syncMetrics(db, adapter, account, isoDay(7), isoDay(1));
    const a = await new MockExportSource(db, brand!.id).fetchPage(new Date(0), null, 500);
    const b = await new MockExportSource(db, brand!.id).fetchPage(new Date(0), null, 500);
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    // Pages, like the real export: small pages walk the whole list.
    const small = new MockExportSource(db, brand!.id);
    const all: unknown[] = [];
    let cursor: string | null = null;
    do {
      const p = await small.fetchPage(new Date(0), cursor, 3);
      all.push(...p.rows);
      cursor = p.next;
    } while (cursor);
    expect(all).toEqual(a.rows);
    for (const r of a.rows) expect(exportRowSchema.safeParse(r).success).toBe(true);
    const r = await pullCustomerEvents(db, { ...brand!, eventsPulledAt: null }, new MockExportSource(db, brand!.id));
    expect(r.isMock).toBe(true);
    expect(r.rowsRejected).toBe(0);
  });
});
