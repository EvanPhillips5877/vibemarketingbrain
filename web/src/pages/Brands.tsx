import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "wouter";
import { api } from "../api";
import { MockBadge } from "../components/StatTile";
import { money } from "../lib/format";

interface BrandRow {
  brand: { id: string; slug: string; name: string; website: string; status: string; defaultCurrency: string; defaults: Record<string, unknown> };
  policy: { version: number; level: string } | null;
  factCounts: { active: number; proposed: number };
}

interface Fact {
  id: string;
  category: string;
  key: string;
  value: { text: string; quote?: string; patterns?: string[] } & Record<string, unknown>;
  source: string;
  status: "active" | "proposed" | "retired";
  sourceUrl: string | null;
  confidence: number | null;
  supersedesId: string | null;
}

interface FactsResponse {
  facts: Fact[];
  pages: { url: string; title: string | null; httpStatus: number | null; fetchedAt: string }[];
  aiIsMock: boolean;
}

interface BrandDetail {
  brand: BrandRow["brand"];
  policy: { version: number; level: string; rules: Record<string, unknown>; createdAt: string } | null;
}

export function BrandList() {
  const q = useQuery({ queryKey: ["brands"], queryFn: () => api<{ brands: BrandRow[] }>("/api/brands") });
  if (q.isPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{q.error.message}</p>;
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Brands</h1>
      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {q.data.brands.map(({ brand, policy, factCounts }) => (
          <li key={brand.id} className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            <Link href={`/brands/${brand.slug}`} className="text-base font-medium hover:underline">
              {brand.name}
            </Link>
            <p className="text-xs text-neutral-500">{brand.website}</p>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-neutral-500">Autonomy</dt>
              <dd className="font-mono">{policy ? `${policy.level} (v${policy.version})` : "no policy"}</dd>
              <dt className="text-neutral-500">Facts</dt>
              <dd className="font-mono">
                {factCounts.active} active · {factCounts.proposed} proposed
              </dd>
            </dl>
          </li>
        ))}
        {q.data.brands.length === 0 && <li className="text-sm text-neutral-500">No brands yet. Run `pnpm run seed`.</li>}
      </ul>
    </section>
  );
}

const btn = "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function FactRow({ fact, slug, activeSibling }: { fact: Fact; slug: string; activeSibling: Fact | undefined }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.value.text);
  const act = useMutation({
    mutationFn: (body: { action: "accept" | "reject" | "edit"; value?: unknown }) => api(`/api/brands/${slug}/facts/${fact.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["facts", slug] });
      void qc.invalidateQueries({ queryKey: ["brands"] });
    },
  });
  const proposed = fact.status === "proposed";
  return (
    <li className="flex gap-3 p-3 text-sm">
      <span
        className={`mt-0.5 h-fit rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${proposed ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"}`}
      >
        {fact.status}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
        ) : (
          <p>{fact.value.text}</p>
        )}
        {proposed && activeSibling && <p className="mt-1 text-xs text-neutral-500">Would replace: “{activeSibling.value.text.slice(0, 160)}”</p>}
        {fact.value.quote && <p className="mt-1 text-xs italic text-neutral-500">“{fact.value.quote}”</p>}
        {fact.value.patterns && <p className="mt-1 font-mono text-[11px] text-neutral-500">patterns: {fact.value.patterns.join("  ·  ")}</p>}
        <p className="mt-1 font-mono text-[11px] text-neutral-500">
          {fact.key} · {fact.source}
          {fact.confidence !== null ? ` · ${Math.round(fact.confidence * 100)}%` : ""}
          {fact.sourceUrl ? ` · ${fact.sourceUrl}` : ""}
        </p>
        <div className="mt-2 flex gap-2">
          {proposed && (
            <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "accept" })}>
              Accept
            </button>
          )}
          {editing ? (
            <>
              <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "edit", value: { ...fact.value, text } })}>
                Save
              </button>
              <button className={btn} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className={btn} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "reject" })}>
            {proposed ? "Reject" : "Retire"}
          </button>
          {act.isError && <span className="text-xs text-red-600">{act.error.message}</span>}
        </div>
      </div>
    </li>
  );
}

function AddFact({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("product");
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: () => api(`/api/brands/${slug}/facts`, { method: "POST", body: { category, key, value: { text }, source: "manual", status: "active" } }),
    onSuccess: () => {
      setOpen(false);
      setKey("");
      setText("");
      void qc.invalidateQueries({ queryKey: ["facts", slug] });
    },
  });
  if (!open)
    return (
      <button className={btn} onClick={() => setOpen(true)}>
        Add a fact
      </button>
    );
  const categories = ["product", "pricing", "audience", "problem", "differentiator", "voice", "visual", "offer", "testimonial", "competitor", "geo", "landing_page", "prohibited_claim", "sport", "seasonality", "messaging_won", "messaging_lost"];
  return (
    <div className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex flex-wrap gap-2">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key (lower-case slug)" className="rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900" />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="The fact, in plain words" className="mt-2 w-full rounded-md border border-neutral-300 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900" />
      <div className="mt-2 flex gap-2">
        <button className={btn} disabled={create.isPending || !key || !text} onClick={() => create.mutate()}>
          Save as active
        </button>
        <button className={btn} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {create.isError && <span className="text-xs text-red-600">{create.error.message}</span>}
      </div>
    </div>
  );
}

export function BrandPage() {
  const { slug } = useParams<{ slug: string }>();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["brand", slug], queryFn: () => api<BrandDetail>(`/api/brands/${slug}`) });
  const facts = useQuery({ queryKey: ["facts", slug], queryFn: () => api<FactsResponse>(`/api/brands/${slug}/facts`) });
  const [tab, setTab] = useState<"proposed" | "active" | "brief">("proposed");
  const crawl = useMutation({
    mutationFn: () => api<{ pages: unknown[]; proposed: number; unchanged: number; isMock: boolean }>(`/api/brands/${slug}/crawl`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["facts", slug] }),
  });
  const brief = useQuery({ queryKey: ["brief", slug], enabled: tab === "brief", queryFn: async () => (await fetch(`/api/brands/${slug}/brief`, { credentials: "same-origin" })).text() });

  if (detail.isPending || facts.isPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (detail.isError) return <p className="text-sm text-red-600">{detail.error.message}</p>;
  if (facts.isError) return <p className="text-sm text-red-600">{facts.error.message}</p>;

  const { brand, policy } = detail.data;
  const all = facts.data.facts;
  const proposed = all.filter((f) => f.status === "proposed");
  const active = all.filter((f) => f.status === "active");
  const shown = tab === "proposed" ? proposed : active;
  const byCategory = new Map<string, Fact[]>();
  for (const f of shown) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
  const cur = brand.defaultCurrency;
  const rules = policy?.rules ?? {};

  return (
    <section className="max-w-3xl">
      <Link href="/brands" className="text-xs text-neutral-500 hover:underline">
        ← Brands
      </Link>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{brand.name}</h1>
          <p className="text-sm text-neutral-500">
            {brand.website} · policy {policy ? `${policy.level} v${policy.version}` : "none"} · {money(rules["monthlyBudgetMicros"] as number, cur)}/month · AI {money(rules["monthlyAiBudgetMicros"] as number, cur)}/month
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MockBadge show={facts.data.aiIsMock} what="AI" />
          <button className={btn} disabled={crawl.isPending} onClick={() => crawl.mutate()}>
            {crawl.isPending ? "Crawling…" : "Crawl site & propose facts"}
          </button>
        </div>
      </div>
      {crawl.isSuccess && (
        <p className="mt-2 text-xs text-neutral-500">
          Read {crawl.data.pages.length} pages; {crawl.data.proposed} new proposal(s), {crawl.data.unchanged} already known{crawl.data.isMock ? " (mock extraction: no model configured)" : ""}.
        </p>
      )}
      {crawl.isError && <p className="mt-2 text-sm text-red-600">{crawl.error.message}</p>}

      <div className="mt-6 flex gap-1 text-sm" role="tablist">
        {(["proposed", "active", "brief"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 ${tab === t ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}
          >
            {t === "proposed" ? `To review (${proposed.length})` : t === "active" ? `Active (${active.length})` : "Brand Brief"}
          </button>
        ))}
      </div>

      {tab === "brief" ? (
        <pre className="mt-4 whitespace-pre-wrap rounded-md border border-neutral-200 p-4 text-xs dark:border-neutral-800">{brief.data ?? "Loading…"}</pre>
      ) : (
        <>
          {tab === "active" && (
            <div className="mt-4">
              <AddFact slug={slug} />
            </div>
          )}
          {shown.length === 0 && <p className="mt-4 text-sm text-neutral-500">{tab === "proposed" ? "Nothing to review. Crawl the site to get proposals." : "No active facts."}</p>}
          {[...byCategory.entries()].map(([category, list]) => (
            <div key={category} className="mt-4">
              <h3 className="text-sm font-medium">{category.replace(/_/g, " ")}</h3>
              <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {list.map((f) => (
                  <FactRow key={f.id} fact={f} slug={slug} activeSibling={f.status === "proposed" ? active.find((a) => a.category === f.category && a.key === f.key) : undefined} />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {facts.data.pages.length > 0 && (
        <details className="mt-8 text-xs text-neutral-500">
          <summary>Pages last crawled ({facts.data.pages.length})</summary>
          <ul className="mt-2 space-y-0.5 font-mono">
            {facts.data.pages.map((p) => (
              <li key={p.url}>
                {p.httpStatus} {p.url} {p.title ? `· ${p.title}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
