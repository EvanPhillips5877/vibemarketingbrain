import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { MockBadge, StatTile, WindowPicker } from "../components/StatTile";
import { useCurrentBrand } from "../lib/brand";
import { int, money, pct, relativeTime, untilTime } from "../lib/format";

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
    mutationFn: () => api<{ accounts: { channel: string; isMock: boolean; objects: number; metricRows: number }[] }>(`/api/brands/${brand!.slug}/sync`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const syncNote = sync.isError ? sync.error.message : sync.data ? (sync.data.accounts.length === 0 ? "No ad accounts are connected yet, so there was nothing to sync." : `Synced ${sync.data.accounts.map((a) => `${a.channel}: ${a.objects} objects, ${a.metricRows} metric rows`).join("; ")}.`) : null;

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
          {syncNote && <span className={`text-xs ${sync.isError ? "text-red-600" : "text-neutral-500"}`}>{syncNote}</span>}
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

      <Proposals slug={brand.slug} currency={cur} />
    </section>
  );
}

interface Proposal {
  id: string;
  type: string;
  status: string;
  reason: string;
  source: string;
  expectedOutcome: string | null;
  payload: Record<string, unknown>;
  policyResult: { violations: { rule: string; detail: string; effect: string }[]; mode: string } | null;
  evidence: { entries?: { id: string; label: string; value: number | null; unit?: string }[] };
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function describePayload(p: Record<string, unknown>, currency: string): string {
  const t = p["type"];
  if (t === "PAUSE_AD" || t === "ACTIVATE") return `${t === "PAUSE_AD" ? "Pause" : "Activate"} ${p["kind"]} ${p["externalId"]}`;
  if (t === "CHANGE_BUDGET") return `Set ${p["kind"]} ${p["externalId"]} daily budget to ${money(p["dailyBudgetMicros"] as number, currency, { cents: true })}`;
  if (t === "CREATE_CAMPAIGN") return `Create campaign "${p["name"]}" at ${money(p["dailyBudgetMicros"] as number, currency, { cents: true })}/day in ${(p["geos"] as string[]).join(", ")}`;
  if (t === "ROTATE_AD") return `Rotate: pause ${(p["pause"] as { externalId: string }).externalId}, activate ${(p["activate"] as { externalId: string }).externalId}`;
  if (t === "REALLOCATE_BUDGET") return `Move budget from ${(p["from"] as { externalId: string }).externalId} to ${(p["to"] as { externalId: string }).externalId}`;
  return String(t);
}

function Proposals({ slug, currency }: { slug: string; currency: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["proposals", slug], queryFn: () => api<{ open: Proposal[]; done: Proposal[] }>(`/api/brands/${slug}/proposals`) });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" | "rollback" }) => api(`/api/brands/${slug}/proposals/${id}`, { method: "PATCH", body: { action } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["proposals", slug] }),
  });
  const execute = useMutation({
    mutationFn: () => api(`/api/brands/${slug}/execute`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const btn = "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
  const open = q.data?.open ?? [];
  const waiting = open.filter((p) => p.status === "awaiting_approval");
  const inFlight = open.filter((p) => p.status !== "awaiting_approval");
  const done = (q.data?.done ?? []).slice(0, 10);
  return (
    <>
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Needs approval ({waiting.length})</h2>
        <button onClick={() => execute.mutate()} disabled={execute.isPending || !open.some((p) => p.status !== "awaiting_approval")} className={btn} title="Run approved proposals now; the scheduler does this every 5 minutes">
          {execute.isPending ? "Running…" : "Run approved now"}
        </button>
      </div>
      {(decide.isError || execute.isError) && <p className="mt-2 text-sm text-red-600">{(decide.error ?? execute.error)?.message}</p>}
      {q.isPending && <p className="mt-2 text-sm text-neutral-500">Loading…</p>}
      {!q.isPending && waiting.length === 0 && <p className="mt-2 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">Nothing waiting for you.</p>}
      <ul className="mt-2 space-y-2">
        {waiting.map((p) => (
          <li key={p.id} className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="font-medium">{describePayload(p.payload, currency)}</div>
            <p className="mt-1 text-neutral-600 dark:text-neutral-300">{p.reason}</p>
            {p.expectedOutcome && <p className="text-xs text-neutral-500">Expected: {p.expectedOutcome}</p>}
            {p.evidence?.entries && (
              <p className="mt-1 flex flex-wrap gap-1">
                {p.evidence.entries.map((e) => (
                  <span key={e.id} className="rounded border border-neutral-300 px-1 font-mono text-[10px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                    {e.label}: {e.value === null ? "n/a" : e.unit === "micros" ? money(e.value, currency, { cents: true }) : e.unit === "pct" ? `${e.value}%` : int(e.value)}
                  </span>
                ))}
              </p>
            )}
            {p.policyResult && p.policyResult.violations.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Policy: {p.policyResult.violations.map((v) => v.detail).join("; ")}</p>}
            <p className="mt-1 font-mono text-[11px] text-neutral-500">
              {p.type} · {p.source} · expires {untilTime(p.expiresAt)}
            </p>
            <div className="mt-2 flex gap-2">
              <button className={btn} disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: "approve" })}>
                Approve
              </button>
              <button className={btn} disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: "reject" })}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
      {inFlight.length > 0 && (
        <p className="mt-2 text-xs text-neutral-500">
          In flight: {inFlight.map((p) => `${describePayload(p.payload, currency)} (${p.status})`).join(" · ")}
        </p>
      )}
      <h2 className="mt-8 text-xs uppercase tracking-wide text-neutral-500">What MarketingBrain did</h2>
      {done.length === 0 && <p className="mt-2 text-sm text-neutral-500">Nothing executed yet.</p>}
      <ul className="mt-2 space-y-1 text-sm">
        {done.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-neutral-200 px-1 font-mono text-[10px] uppercase dark:bg-neutral-700">{p.status}</span>
            <span>{describePayload(p.payload, currency)}</span>
            <span className="text-xs text-neutral-500">
              {p.source} · {relativeTime(p.updatedAt)}
            </span>
            {p.status === "executed" && (
              <button className={btn} disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, action: "rollback" })}>
                Undo (propose rollback)
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
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
