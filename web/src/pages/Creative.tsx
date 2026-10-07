import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { MockBadge } from "../components/StatTile";
import { useCurrentBrand } from "../lib/brand";

interface Hypothesis {
  id: string;
  statement: string;
  dimensions: Record<string, string>;
  status: string;
}
interface Creative {
  id: string;
  hypothesisId: string | null;
  hookId: string | null;
  concept: string;
}
interface Variant {
  id: string;
  creativeId: string;
  channel: string;
  format: string;
  status: string;
  tags: Record<string, string>;
  renderedAssetIds: string[];
  payload: Record<string, unknown> & { compliance?: { ok: boolean; violations: { rule: string; match: string }[] } };
}
interface Tree {
  hypotheses: Hypothesis[];
  creatives: Creative[];
  hooks: { id: string; text: string; hookType: string }[];
  variants: Variant[];
  aiIsMock: boolean;
  formats: string[];
}

const btn = "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function VariantCard({ v, slug, selected, onSelect }: { v: Variant; slug: string; selected: boolean; onSelect: (id: string, on: boolean) => void }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (body: { action: "approve" | "reject" }) => api(`/api/brands/${slug}/creative/variants/${v.id}`, { method: "PATCH", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["creative", slug] }),
  });
  const p = v.payload;
  const bad = p.compliance && !p.compliance.ok;
  return (
    <li className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-neutral-500">
          {v.format} · {v.status} · {Object.entries(v.tags).filter(([k]) => !k.startsWith("hyp_")).map(([k, val]) => `${k}=${val}`).join(" ")}
        </span>
        {v.status === "approved" && <input type="checkbox" checked={selected} onChange={(e) => onSelect(v.id, e.target.checked)} aria-label="select for shipping" />}
      </div>
      {v.format === "meta_image" ? (
        <div className="mt-2 grid gap-2 md:grid-cols-[160px_1fr]">
          {v.renderedAssetIds[0] && <img src={`/api/assets/${v.renderedAssetIds[0]}`} alt={String(p["overlayText"])} className="w-40 rounded border border-neutral-200 dark:border-neutral-800" />}
          <div>
            <p className="font-medium">{String(p["headline"])}</p>
            <p>{String(p["primaryText"])}</p>
            <p className="text-xs text-neutral-500">
              {String(p["description"])} · {String(p["cta"])} · {v.renderedAssetIds.length} sizes
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <p className="font-medium">{(p["headlines"] as string[]).join(" | ")}</p>
          <p>{(p["descriptions"] as string[]).join(" ")}</p>
          <p className="text-xs text-neutral-500">keywords: {(p["keywords"] as { text: string; matchType: string }[]).map((k) => `${k.text} [${k.matchType}]`).join(", ")}</p>
        </div>
      )}
      {bad && <p className="mt-1 text-xs text-red-600">Breaks a brand rule: {p.compliance!.violations.map((x) => `${x.rule} (“${x.match}”)`).join("; ")}. Edit before approving.</p>}
      {v.status === "draft" && (
        <div className="mt-2 flex gap-2">
          <button className={btn} disabled={act.isPending || !!bad} onClick={() => act.mutate({ action: "approve" })}>
            Approve
          </button>
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "reject" })}>
            Reject
          </button>
          {act.isError && <span className="text-xs text-red-600">{act.error.message}</span>}
        </div>
      )}
    </li>
  );
}

export function Creative() {
  const { brand, isPending } = useCurrentBrand();
  const qc = useQueryClient();
  const slug = brand?.slug ?? "";
  const tree = useQuery({ queryKey: ["creative", slug], enabled: !!brand, queryFn: () => api<Tree>(`/api/brands/${slug}/creative`) });
  const accounts = useQuery({ queryKey: ["campaigns", slug, 7], enabled: !!brand, queryFn: () => api<{ campaigns: { channel: string; externalId: string; name: string | null }[] }>(`/api/brands/${slug}/campaigns?days=7`) });
  const [statement, setStatement] = useState("");
  const [sport, setSport] = useState("volleyball");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adGroup, setAdGroup] = useState("");
  const [landing, setLanding] = useState(brand?.slug === "tryoutbrain" ? "https://tryoutbrain.com/for/volleyball" : "");
  const create = useMutation({
    mutationFn: () => api<{ hypothesis: Hypothesis }>(`/api/brands/${slug}/creative/hypotheses`, { method: "POST", body: { statement, dimensions: { sport } } }),
    onSuccess: () => {
      setStatement("");
      void qc.invalidateQueries({ queryKey: ["creative", slug] });
    },
  });
  const generate = useMutation({
    mutationFn: (id: string) => api<{ variants: number; nonCompliant: number; isMock: boolean }>(`/api/brands/${slug}/creative/hypotheses/${id}/generate`, { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["creative", slug] }),
  });
  const ship = useMutation({
    mutationFn: (input: { variantIds: string[]; channelAccountId: string; adGroupExternalId: string; landingUrl: string }) => api<{ proposals: unknown[] }>(`/api/brands/${slug}/creative/ship`, { method: "POST", body: input }),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries();
    },
  });

  if (isPending || (brand && tree.isPending)) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!brand) return <p className="text-sm text-neutral-500">No brand yet.</p>;
  if (tree.isError) return <p className="text-sm text-red-600">{tree.error.message}</p>;
  const t = tree.data!;

  return (
    <section className="max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Creative</h1>
        <MockBadge show={t.aiIsMock} what="AI" />
      </div>
      <p className="mt-1 text-sm text-neutral-500">A hypothesis becomes hooks, each hook becomes ads per channel. You approve copy here; shipping creates paused ads through the approvals inbox.</p>

      <div className="mt-4 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
        <label className="text-xs uppercase tracking-wide text-neutral-500">New hypothesis</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input value={statement} onChange={(e) => setStatement(e.target.value)} placeholder='e.g. "Fairness messaging with a real Room screenshot works for volleyball clubs"' className="min-w-[280px] flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          <input value={sport} onChange={(e) => setSport(e.target.value)} placeholder="sport" className="w-32 rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          <button className={btn} disabled={create.isPending || statement.length < 5} onClick={() => create.mutate()}>
            Add
          </button>
        </div>
        {create.isError && <p className="mt-1 text-xs text-red-600">{create.error.message}</p>}
      </div>

      {t.hypotheses.map((h) => {
        const crs = t.creatives.filter((c) => c.hypothesisId === h.id);
        const vs = t.variants.filter((v) => crs.some((c) => c.id === v.creativeId));
        return (
          <div key={h.id} className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-medium">{h.statement}</h2>
                <p className="font-mono text-[11px] text-neutral-500">
                  {h.status} · {Object.entries(h.dimensions).map(([k, v]) => `${k}=${v}`).join(" ")} · {crs.length} hooks · {vs.length} variants
                </p>
              </div>
              <button className={btn} disabled={generate.isPending} onClick={() => generate.mutate(h.id)}>
                {generate.isPending ? "Generating…" : vs.length ? "Generate more" : "Generate hooks & ads"}
              </button>
            </div>
            {generate.isError && <p className="mt-1 text-xs text-red-600">{generate.error.message}</p>}
            {crs.map((c) => {
              const mine = vs.filter((v) => v.creativeId === c.id);
              return (
                <div key={c.id} className="mt-3">
                  <h3 className="text-sm">{c.concept}</h3>
                  <ul className="mt-1 space-y-2">
                    {mine.map((v) => (
                      <VariantCard key={v.id} v={v} slug={slug} selected={selected.has(v.id)} onSelect={(id, on) => setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; })} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        );
      })}
      {t.hypotheses.length === 0 && <p className="mt-4 text-sm text-neutral-500">No hypotheses yet. Add one above.</p>}

      {selected.size > 0 && (
        <div className="sticky bottom-0 mt-6 rounded-md border border-neutral-300 bg-white p-3 text-sm shadow dark:border-neutral-700 dark:bg-neutral-900">
          <p className="font-medium">Ship {selected.size} approved variant(s) as paused ads</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select value={adGroup} onChange={(e) => setAdGroup(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="">Ad group…</option>
              {(accounts.data?.campaigns ?? []).map((c) => (
                <option key={c.externalId} value={`${c.externalId}`}>
                  {c.channel}: {c.name ?? c.externalId} (campaign; ad group picked by id below)
                </option>
              ))}
            </select>
            <input value={adGroup} onChange={(e) => setAdGroup(e.target.value)} placeholder="ad group external id" className="rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900" />
            <input value={landing} onChange={(e) => setLanding(e.target.value)} placeholder="landing URL" className="min-w-[260px] rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
            <ShipButton slug={slug} channels={[...selected].map((id) => t.variants.find((v) => v.id === id)?.channel ?? "")} disabled={ship.isPending || !adGroup || !landing} onShip={(channelAccountId) => ship.mutate({ variantIds: [...selected], channelAccountId, adGroupExternalId: adGroup, landingUrl: landing })} />
          </div>
          {ship.isError && <p className="mt-1 text-xs text-red-600">{ship.error.message}</p>}
          {ship.isSuccess && <p className="mt-1 text-xs text-neutral-500">{ship.data.proposals.length} proposal(s) created; approve them on Today.</p>}
        </div>
      )}
    </section>
  );
}

function ShipButton({ slug, channels, disabled, onShip }: { slug: string; channels: string[]; disabled: boolean; onShip: (channelAccountId: string) => void }) {
  const q = useQuery({ queryKey: ["channel-accounts", slug], queryFn: () => api<{ accounts: { id: string; channel: string; externalAccountId: string }[] }>(`/api/brands/${slug}/accounts`) });
  const [accountId, setAccountId] = useState("");
  const distinct = [...new Set(channels)];
  const accounts = q.data?.accounts ?? [];
  // Only accounts on the selected variants' channel qualify; a mock account takes anything.
  const eligible = distinct.length === 1 ? accounts.filter((a) => a.channel === distinct[0] || a.channel === "mock") : [];
  const chosen = eligible.find((a) => a.id === accountId) ?? eligible[0];
  if (distinct.length > 1) return <span className="text-xs text-red-600">Select variants from one channel at a time.</span>;
  return (
    <>
      <select value={chosen?.id ?? ""} onChange={(e) => setAccountId(e.target.value)} className="rounded-md border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" aria-label="ad account">
        {eligible.map((a) => (
          <option key={a.id} value={a.id}>
            {a.channel} · {a.externalAccountId}
          </option>
        ))}
        {eligible.length === 0 && <option value="">no {distinct[0]} account</option>}
      </select>
      <button className={btn} disabled={disabled || !chosen} onClick={() => chosen && onShip(chosen.id)}>
        Ship
      </button>
    </>
  );
}
