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

      <h2 className="mt-8 text-xs uppercase tracking-wide text-neutral-500">What MarketingBrain did · needs approval</h2>
      <p className="mt-2 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
        Nothing yet. Analysis and proposals arrive with Phases 10 and 11. {anyMock ? "Numbers above include mock data." : ""}
      </p>
    </section>
  );
}
