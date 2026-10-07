import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { api } from "../api";

interface BrandRow {
  brand: { id: string; slug: string; name: string; website: string; status: string; defaultCurrency: string; defaults: Record<string, unknown> };
  policy: { version: number; level: string } | null;
  factCounts: { active: number; proposed: number };
}

interface Fact {
  id: string;
  category: string;
  key: string;
  value: { text: string } & Record<string, unknown>;
  source: string;
  status: string;
  sourceUrl: string | null;
}

interface BrandDetail {
  brand: BrandRow["brand"];
  policy: { version: number; level: string; rules: Record<string, unknown>; createdAt: string } | null;
  facts: Fact[];
}

const money = (micros: unknown, currency: string) =>
  typeof micros === "number" ? `${currency} ${(micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";

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
              <dt className="text-neutral-500">Status</dt>
              <dd className="font-mono">{brand.status}</dd>
            </dl>
          </li>
        ))}
        {q.data.brands.length === 0 && <li className="text-sm text-neutral-500">No brands yet. Run `pnpm run seed`.</li>}
      </ul>
    </section>
  );
}

export function BrandPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useQuery({ queryKey: ["brand", slug], queryFn: () => api<BrandDetail>(`/api/brands/${slug}`) });
  if (q.isPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{q.error.message}</p>;
  const { brand, policy, facts } = q.data;
  const cur = brand.defaultCurrency;
  const byCategory = new Map<string, Fact[]>();
  for (const f of facts) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
  const rules = policy?.rules ?? {};
  const modes = (rules["actionModes"] ?? {}) as Record<string, string>;

  return (
    <section className="max-w-3xl">
      <Link href="/brands" className="text-xs text-neutral-500 hover:underline">
        ← Brands
      </Link>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">{brand.name}</h1>
      <p className="text-sm text-neutral-500">{brand.website}</p>

      <h2 className="mt-6 text-xs uppercase tracking-wide text-neutral-500">Autonomy policy {policy ? `v${policy.version}` : ""}</h2>
      {policy ? (
        <div className="mt-2 rounded-md border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <div className="grid grid-cols-2 gap-y-1 md:grid-cols-4">
            <span className="text-neutral-500">Level</span>
            <span className="font-mono">{policy.level}</span>
            <span className="text-neutral-500">Monthly budget</span>
            <span className="font-mono">{money(rules["monthlyBudgetMicros"], cur)}</span>
            <span className="text-neutral-500">Max daily spend</span>
            <span className="font-mono">{money(rules["maxDailySpendMicros"], cur)}</span>
            <span className="text-neutral-500">Auto shift</span>
            <span className="font-mono">{String(rules["maxAutoShiftPct"])}%</span>
            <span className="text-neutral-500">Cooldown</span>
            <span className="font-mono">{String(rules["minHoursBetweenChanges"])} h</span>
            <span className="text-neutral-500">Experiments</span>
            <span className="font-mono">≤ {String(rules["maxRunningExperiments"])} running</span>
            <span className="text-neutral-500">Geos</span>
            <span className="font-mono">{(rules["allowedGeos"] as string[] | undefined)?.join(", ")}</span>
            <span className="text-neutral-500">AI budget</span>
            <span className="font-mono">{money(rules["monthlyAiBudgetMicros"], cur)}/mo</span>
          </div>
          <ul className="mt-3 flex flex-wrap gap-1">
            {Object.entries(modes).map(([type, mode]) => (
              <li key={type} className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs dark:bg-neutral-800">
                {type}: {mode}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-neutral-500">Policies are immutable; a change creates the next version. Editing arrives with the Action Engine.</p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">No policy. Nothing can execute for this brand.</p>
      )}

      <h2 className="mt-6 text-xs uppercase tracking-wide text-neutral-500">Brand Brain</h2>
      {[...byCategory.entries()].map(([category, list]) => (
        <div key={category} className="mt-3">
          <h3 className="text-sm font-medium">{category.replace(/_/g, " ")}</h3>
          <ul className="mt-1 divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {list.map((f) => (
              <li key={f.id} className="flex gap-3 p-3 text-sm">
                <span
                  className={`mt-0.5 h-fit rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${f.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" : "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"}`}
                >
                  {f.status}
                </span>
                <div className="min-w-0">
                  <p>{f.value.text}</p>
                  <p className="mt-1 font-mono text-[11px] text-neutral-500">
                    {f.key} · {f.source}
                    {f.sourceUrl ? ` · ${f.sourceUrl}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
