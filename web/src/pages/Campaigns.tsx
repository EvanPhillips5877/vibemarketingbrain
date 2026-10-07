import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { MockBadge, WindowPicker } from "../components/StatTile";
import { useCurrentBrand } from "../lib/brand";
import { int, money } from "../lib/format";

interface CampaignRow {
  extObjectId: string;
  channel: string;
  isMock: boolean;
  externalId: string;
  name: string | null;
  status: string | null;
  dailyBudgetMicros: number | null;
  spendMicros: number;
  impressions: number;
  clicks: number;
  platformConversions: number;
  registered: number;
  paid: number;
  cpaMicros: number | null;
  cacMicros: number | null;
}

export function Campaigns() {
  const { brand, isPending: brandPending } = useCurrentBrand();
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["campaigns", brand?.slug, days],
    enabled: !!brand,
    queryFn: () => api<{ window: { from: string; to: string }; currency: string; campaigns: CampaignRow[] }>(`/api/brands/${brand!.slug}/campaigns?days=${days}`),
  });

  if (brandPending) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!brand) return <p className="text-sm text-neutral-500">No brand yet.</p>;
  if (q.isError) return <p className="text-sm text-red-600">{q.error.message}</p>;
  if (!q.data) return <p className="text-sm text-neutral-500">Loading…</p>;

  const cur = q.data.currency;
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-xs text-neutral-500">
            {q.data.window.from} to {q.data.window.to} · every channel in one table
          </p>
        </div>
        <WindowPicker days={days} onChange={setDays} />
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[800px] text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Campaign</th>
              <th className="py-1 font-normal">Channel</th>
              <th className="py-1 font-normal">Status</th>
              <th className="py-1 text-right font-normal">Daily budget</th>
              <th className="py-1 text-right font-normal">Spent</th>
              <th className="py-1 text-right font-normal">Clicks</th>
              <th className="py-1 text-right font-normal">Platform conv.</th>
              <th className="py-1 text-right font-normal">Registrations</th>
              <th className="py-1 text-right font-normal">Paid</th>
              <th className="py-1 text-right font-normal">CPA</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {q.data.campaigns.map((c) => (
              <tr key={c.extObjectId} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-1.5">
                  <div>{c.name ?? c.externalId}</div>
                  <div className="font-mono text-[11px] text-neutral-500">{c.externalId}</div>
                </td>
                <td className="py-1.5">
                  {c.channel} <MockBadge show={c.isMock} what="ads" />
                </td>
                <td className="py-1.5 font-mono text-xs">{c.status ?? "—"}</td>
                <td className="py-1.5 text-right">{money(c.dailyBudgetMicros, cur, { cents: true })}</td>
                <td className="py-1.5 text-right">{money(c.spendMicros, cur)}</td>
                <td className="py-1.5 text-right">{int(c.clicks)}</td>
                <td className="py-1.5 text-right">{int(c.platformConversions)}</td>
                <td className="py-1.5 text-right">{int(c.registered)}</td>
                <td className="py-1.5 text-right">{int(c.paid)}</td>
                <td className="py-1.5 text-right">{money(c.cpaMicros, cur, { cents: true })}</td>
              </tr>
            ))}
            {q.data.campaigns.length === 0 && (
              <tr>
                <td colSpan={10} className="py-3 text-neutral-500">
                  No campaigns mirrored yet. Press "Sync now" on Today.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-neutral-500">"Platform conv." is what the ad platform claims; "Registrations" are clubs that actually signed up and were traced back to this campaign.</p>
    </section>
  );
}
