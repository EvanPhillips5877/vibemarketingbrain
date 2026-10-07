import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { MockBadge, StatTile, WindowPicker } from "../components/StatTile";
import { useCurrentBrand } from "../lib/brand";
import { int, money, pct, relativeTime } from "../lib/format";

interface Totals {
  spendMicros: number;
  impressions: number;
  clicks: number;
  platformConversions: number;
  registered: number;
  activated: number;
  paid: number;
  cpaMicros: number | null;
  cacMicros: number | null;
}
interface TodayResponse {
  brand: { slug: string; name: string; currency: string; lastSyncAt: string | null; eventsPulledAt: string | null; eventsSourceIsMock: boolean };
  summary: {
    window: { from: string; to: string };
    totals: Totals;
    byChannel: (Totals & { channel: string; isMock: boolean })[];
    attribution: { registered: number; attributedToAd: number; attributedToChannelOnly: number; unattributed: number; pending: number };
  };
}

export function Today() {
  const { brand, isPending: brandPending } = useCurrentBrand();
  const [days, setDays] = useState(30);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["today", brand?.slug, days],
    enabled: !!brand,
    queryFn: () => api<TodayResponse>(`/api/brands/${brand!.slug}/today?days=${days}`),
  });
  const sync = useMutation({
    mutationFn: () => api(`/api/brands/${brand!.slug}/sync`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });

  if (brandPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!brand) return <p className="text-sm text-neutral-500">No brand yet. Run `pnpm run seed`.</p>;
  if (q.isPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{q.error.message}</p>;

  const { totals: t, byChannel, attribution: a, window } = q.data.summary;
  const cur = q.data.brand.currency;
  const anyMock = byChannel.some((c) => c.isMock) || q.data.brand.eventsSourceIsMock;

  return (
    <section className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{q.data.brand.name}</h1>
          <p className="text-xs text-neutral-500">
            {window.from} to {window.to} · last sync {relativeTime(q.data.brand.lastSyncAt)}{" "}
            <MockBadge show={q.data.brand.eventsSourceIsMock} what="funnel" />
          </p>
        </div>
        <div className="flex items-center gap-3">
          <WindowPicker days={days} onChange={setDays} />
          <button
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
      {sync.isError && <p className="mt-2 text-sm text-red-600">Sync failed: {sync.error.message}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Spent" value={money(t.spendMicros, cur)} context={`${int(t.clicks)} clicks · ${int(t.impressions)} impressions`} />
        <StatTile label="Registrations" value={int(t.registered)} context={`platforms counted ${int(t.platformConversions)}`} />
        <StatTile label="Paid" value={int(t.paid)} context={`${int(t.activated)} activated`} />
        <StatTile label="CPA" value={money(t.cpaMicros, cur, { cents: true })} context="spend per registration" />
        <StatTile label="CAC" value={money(t.cacMicros, cur, { cents: true })} context="spend per paying club" />
      </div>

      <h2 className="mt-8 text-xs uppercase tracking-wide text-neutral-500">By channel</h2>
      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs text-neutral-500">
          <tr>
            <th className="py-1 font-normal">Channel</th>
            <th className="py-1 text-right font-normal">Spent</th>
            <th className="py-1 text-right font-normal">Clicks</th>
            <th className="py-1 text-right font-normal">Registrations</th>
            <th className="py-1 text-right font-normal">Paid</th>
            <th className="py-1 text-right font-normal">CPA</th>
            <th className="py-1 text-right font-normal">CAC</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {byChannel.map((c) => (
            <tr key={c.channel} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="py-1.5">
                {c.channel} <MockBadge show={c.isMock} what="ads" />
              </td>
              <td className="py-1.5 text-right">{money(c.spendMicros, cur)}</td>
              <td className="py-1.5 text-right">{int(c.clicks)}</td>
              <td className="py-1.5 text-right">{int(c.registered)}</td>
              <td className="py-1.5 text-right">{int(c.paid)}</td>
              <td className="py-1.5 text-right">{money(c.cpaMicros, cur, { cents: true })}</td>
              <td className="py-1.5 text-right">{money(c.cacMicros, cur, { cents: true })}</td>
            </tr>
          ))}
          {byChannel.length === 0 && (
            <tr>
              <td colSpan={7} className="py-3 text-neutral-500">
                Nothing in this window yet. Press "Sync now".
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="mt-8 text-xs uppercase tracking-wide text-neutral-500">Where registrations came from</h2>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        Of {int(a.registered)} registrations: {int(a.attributedToAd)} traced to a specific ad ({pct(a.attributedToAd, a.registered)}), {int(a.attributedToChannelOnly)} to a channel only, {int(a.unattributed)} unattributed
        {a.pending > 0 ? `, ${int(a.pending)} not yet decided` : ""}. Unattributed stays unattributed; it is never spread across channels.
      </p>

      <Report slug={brand.slug} anyMock={anyMock} />

      <h2 className="mt-8 text-xs uppercase tracking-wide text-neutral-500">Needs approval</h2>
      <p className="mt-2 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
        Nothing yet. Proposals and approvals arrive with the Action Engine (Phase 11).
      </p>
    </section>
  );
}

interface PackEntry {
  id: string;
  label: string;
  value: number | null;
  unit: "micros" | "count" | "ratio" | "pct";
  window: string;
  insufficient?: boolean;
}
interface Claim {
  kind: "FACT" | "OBSERVATION" | "HYPOTHESIS" | "RECOMMENDATION" | "ACTION";
  text: string;
  evidence: string[];
}
interface Finding {
  detector: string;
  severity: "info" | "warning" | "serious";
  text: string;
  evidence: string[];
  suggested?: { type: string; reason: string };
}
interface ReportResponse {
  report: {
    id: string;
    kind: string;
    windowFrom: string;
    windowTo: string;
    isMock: boolean;
    createdAt: string;
    pack: { entries: PackEntry[]; currency: string };
    findings: Finding[];
    analysis: { headline: string; claims: Claim[]; nextTests: string[] };
    dropped: { claim: Claim; problems: string[] }[];
  } | null;
}

function Evidence({ ids, entries, currency }: { ids: string[]; entries: Map<string, PackEntry>; currency: string }) {
  const show = (e: PackEntry) => (e.value === null ? "n/a" : e.unit === "micros" ? money(e.value, currency, { cents: true }) : e.unit === "pct" ? `${e.value}%` : String(e.value));
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const e = entries.get(id);
        return (
          <span key={id} title={e ? `${e.label} · ${e.window}${e.insufficient ? " · insufficient data" : ""}` : id} className="rounded border border-neutral-300 px-1 font-mono text-[10px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
            {e ? `${e.label.length > 28 ? `${e.label.slice(0, 27)}…` : e.label}: ${show(e)}` : id}
          </span>
        );
      })}
    </span>
  );
}

function Report({ slug, anyMock }: { slug: string; anyMock: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["report", slug], queryFn: () => api<ReportResponse>(`/api/brands/${slug}/report`) });
  const analyze = useMutation({
    mutationFn: () => api(`/api/brands/${slug}/analyze`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["report", slug] }),
  });
  const r = q.data?.report ?? null;
  const entries = new Map((r?.pack.entries ?? []).map((e) => [e.id, e]));
  const cur = r?.pack.currency ?? "CAD";
  const kindStyle: Record<Claim["kind"], string> = {
    FACT: "bg-neutral-200 dark:bg-neutral-700",
    OBSERVATION: "bg-neutral-200 dark:bg-neutral-700",
    HYPOTHESIS: "bg-amber-100 dark:bg-amber-900",
    RECOMMENDATION: "bg-sky-100 dark:bg-sky-900",
    ACTION: "bg-emerald-100 dark:bg-emerald-900",
  };
  return (
    <>
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">What MarketingBrain saw</h2>
        <button onClick={() => analyze.mutate()} disabled={analyze.isPending} className="rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          {analyze.isPending ? "Analyzing…" : "Analyze now"}
        </button>
      </div>
      {analyze.isError && <p className="mt-2 text-sm text-red-600">{analyze.error.message}</p>}
      {q.isPending && <p className="mt-2 text-sm text-neutral-500">Loading…</p>}
      {!q.isPending && !r && <p className="mt-2 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">No report yet. The morning job writes one at 06:00, or press "Analyze now".</p>}
      {r && (
        <div className="mt-2 rounded-md border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <p className="text-xs text-neutral-500">
            {r.kind} report · {r.windowFrom} to {r.windowTo} · {relativeTime(r.createdAt)} <MockBadge show={r.isMock} what="analysis" />
          </p>
          <p className="mt-1 font-medium">{r.analysis.headline}</p>
          {r.findings.length > 0 && (
            <>
              <h3 className="mt-3 text-xs uppercase tracking-wide text-neutral-500">Detectors ({r.findings.length})</h3>
              <ul className="mt-1 space-y-1">
                {r.findings.map((f, i) => (
                  <li key={i}>
                    <span className="mr-1 rounded px-1 font-mono text-[10px] uppercase">{f.severity}</span>
                    {f.text}
                    <Evidence ids={f.evidence} entries={entries} currency={cur} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.findings.length === 0 && <p className="mt-2 text-xs text-neutral-500">Detectors ran and found nothing to flag.</p>}
          <h3 className="mt-3 text-xs uppercase tracking-wide text-neutral-500">Claims ({r.analysis.claims.length})</h3>
          <ul className="mt-1 space-y-1.5">
            {r.analysis.claims.map((c, i) => (
              <li key={i}>
                <span className={`mr-1 rounded px-1 font-mono text-[10px] ${kindStyle[c.kind]}`}>{c.kind}</span>
                {c.text}
                <Evidence ids={c.evidence} entries={entries} currency={cur} />
              </li>
            ))}
          </ul>
          {r.analysis.nextTests.length > 0 && (
            <>
              <h3 className="mt-3 text-xs uppercase tracking-wide text-neutral-500">What to test next</h3>
              <ul className="mt-1 list-disc pl-5">
                {r.analysis.nextTests.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {r.dropped.length > 0 && (
            <details className="mt-3 text-xs text-neutral-500">
              <summary>{r.dropped.length} claim(s) rejected by the validator</summary>
              <ul className="mt-1 space-y-1">
                {r.dropped.map((d, i) => (
                  <li key={i}>
                    “{d.claim.text}” — {d.problems.join("; ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {anyMock && <p className="mt-3 text-xs text-neutral-500">Numbers include mock data.</p>}
        </div>
      )}
    </>
  );
}
