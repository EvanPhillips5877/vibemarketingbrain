import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { MockBadge } from "../components/StatTile";
import { useCurrentBrand } from "../lib/brand";
import { int, money } from "../lib/format";

interface Mission {
  id: string;
  objectiveText: string;
  goal: { metric: string; target: number };
  targetCacMicros: number | null;
  budgetMicros: number;
  markets: string[];
  channels: string[];
  status: "draft" | "planned" | "active" | "paused" | "done";
  startsAt: string | null;
  endsAt: string | null;
  plan: { durationDays?: number; assumptions?: string[]; isMock?: boolean; strategist?: Plan } | null;
}
interface Plan {
  summary: string;
  channelSplit: { channel: string; share: number }[];
  hypotheses: { statement: string; channel: string; budgetShare: number; primaryMetric: string; targetValue: number | null; killRule: string; scaleRule: string; priority: number }[];
  risks: string[];
}
interface Ledger {
  spendMicros: number;
  impressions: number;
  clicks: number;
  registered: number;
  paid: number;
  cpaMicros: number | null;
  cacMicros: number | null;
  objects: number;
}
interface Progress {
  ledger: Ledger;
  goalMetric: string;
  goalTarget: number;
  goalReached: number;
  goalPct: number;
  budgetPct: number;
  daysElapsed: number;
  daysTotal: number;
  onPace: boolean | null;
  cacVsTargetPct: number | null;
}
interface Experiment {
  id: string;
  name: string;
  channel: string;
  status: "planned" | "running" | "ended";
  primaryMetric: string;
  targetValue: number | null;
  budgetMicros: number;
  conclusion: string | null;
  result: { killRule?: string; scaleRule?: string; verdict?: { reason: string } } | null;
}

const btn = "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const metricText = (metric: string, value: number | null, currency: string) => (value === null ? "no target" : metric === "cpa" || metric === "paid_cac" ? money(value, currency) : `${Math.round(value * 1000) / 10}%`);

function NewMission({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ mission: Mission; isMock: boolean }>(`/api/brands/${slug}/missions`, { method: "POST", body: { text } }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["missions", slug] });
    },
  });
  return (
    <form
      className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <label className="block text-xs font-medium text-neutral-500" htmlFor="mission-text">
        New mission, in plain words
      </label>
      <textarea id="mission-text" className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent p-2 dark:border-neutral-700" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Get 50 new coaches for under $20 each. Budget $1,000. Canada and the US, Meta and Google, 60 days." />
      <div className="mt-2 flex items-center gap-2">
        <button className={btn} type="submit" disabled={text.trim().length < 10 || create.isPending}>
          {create.isPending ? "Reading…" : "Draft mission"}
        </button>
        {create.isError && <span className="text-xs text-red-600">{create.error.message}</span>}
      </div>
    </form>
  );
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="text-xs">
      <div className="flex justify-between text-neutral-500">
        <span>{label}</span>
        <span>{Math.min(999, pct)}%</span>
      </div>
      <div className="mt-0.5 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800">
        <div className="h-1.5 rounded bg-emerald-500" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function MissionCard({ m, progress, slug, currency }: { m: Mission; progress: Progress | null; slug: string; currency: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(m.status !== "done");
  const act = useMutation({
    mutationFn: (action: "plan" | "activate" | "pause") => api(`/api/brands/${slug}/missions/${m.id}`, { method: "PATCH", body: { action } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["missions", slug] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });
  const detail = useQuery({
    queryKey: ["mission", slug, m.id],
    queryFn: () => api<{ experiments: { experiment: Experiment; ledger: Ledger; campaign: { proposalId: string; status: string; violations: string[] } | null }[] }>(`/api/brands/${slug}/missions/${m.id}`),
    enabled: open && (m.status === "active" || m.status === "paused" || m.status === "done"),
  });
  const plan = m.plan?.strategist;
  return (
    <li className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{m.objectiveText}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            {int(m.goal.target)} {m.goal.metric.replace("_", " ")} · budget {money(m.budgetMicros, currency)} · target {m.targetCacMicros ? money(m.targetCacMicros, currency) : "none"} · {m.markets.join(", ")} · {m.channels.join(" + ")} · {m.plan?.durationDays ?? 60} days
          </p>
        </div>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-neutral-800">{m.status}</span>
      </div>
      {m.plan?.assumptions && m.plan.assumptions.length > 0 && m.status === "draft" && <p className="mt-1 text-xs text-amber-700">Assumed: {m.plan.assumptions.join(" ")}</p>}
      {progress && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ProgressBar pct={progress.goalPct} label={`${int(progress.goalReached)} of ${int(progress.goalTarget)} ${progress.goalMetric.replace("_", " ")}`} />
          <ProgressBar pct={progress.budgetPct} label={`spent ${money(progress.ledger.spendMicros, currency)}`} />
          <ProgressBar pct={progress.daysTotal ? Math.round((100 * progress.daysElapsed) / progress.daysTotal) : 0} label={`day ${progress.daysElapsed} of ${progress.daysTotal}${progress.onPace === null ? "" : progress.onPace ? " · on pace" : " · behind pace"}`} />
        </div>
      )}
      {progress && progress.cacVsTargetPct !== null && <p className="mt-1 text-xs text-neutral-500">Cost per {progress.goalMetric === "paid_customers" ? "customer" : "registration"} is {progress.cacVsTargetPct}% of target.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(m.status === "draft" || m.status === "planned") && (
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate("plan")}>
            {act.isPending ? "Planning…" : m.status === "planned" ? "Re-plan" : "Plan it"}
          </button>
        )}
        {m.status === "planned" && (
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate("activate")}>
            Start: create experiments and ask for campaigns
          </button>
        )}
        {m.status === "active" && (
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate("pause")}>
            Pause mission
          </button>
        )}
        {plan && (
          <button className={btn} onClick={() => setOpen(!open)}>
            {open ? "Hide plan" : "Show plan"}
          </button>
        )}
        {act.isError && <span className="text-xs text-red-600">{act.error.message}</span>}
      </div>
      {open && plan && (
        <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <p className="text-xs">
            {plan.summary} <MockBadge show={!!m.plan?.isMock} what="plan" />
          </p>
          <p className="mt-1 text-xs text-neutral-500">Split: {plan.channelSplit.map((c) => `${c.channel} ${Math.round(c.share * 100)}%`).join(", ")}</p>
          <ol className="mt-2 space-y-1">
            {[...plan.hypotheses]
              .sort((a, b) => a.priority - b.priority)
              .map((h) => (
                <li key={h.priority} className="text-xs">
                  <span className="font-medium">
                    {h.priority}. {h.statement}
                  </span>{" "}
                  <span className="text-neutral-500">
                    · {h.channel} · {Math.round(h.budgetShare * 100)}% of budget · {h.primaryMetric} {metricText(h.primaryMetric, h.targetValue, currency)} · kill: {h.killRule} · scale: {h.scaleRule}
                  </span>
                </li>
              ))}
          </ol>
          {plan.risks.length > 0 && <p className="mt-1 text-xs text-neutral-500">Risks: {plan.risks.join(" ")}</p>}
        </div>
      )}
      {open && detail.data && detail.data.experiments.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="py-1 font-normal">Experiment</th>
              <th className="font-normal">Status</th>
              <th className="font-normal">Campaign</th>
              <th className="text-right font-normal">Spend</th>
              <th className="text-right font-normal">Reg.</th>
              <th className="text-right font-normal">CPA</th>
              <th className="font-normal">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {detail.data.experiments.map(({ experiment: e, ledger, campaign }) => (
              <tr key={e.id} className="border-t border-neutral-100 dark:border-neutral-900">
                <td className="py-1">{e.name}</td>
                <td>{e.status}</td>
                <td className={campaign?.status === "blocked" ? "text-red-600" : campaign?.status === "awaiting_approval" ? "text-amber-700" : ""}>
                  {campaign ? `${campaign.status.replace("_", " ")}${campaign.violations.length ? ` (${campaign.violations.join(", ")})` : ""}` : e.status === "running" ? "not asked yet" : "—"}
                </td>
                <td className="text-right">
                  {money(ledger.spendMicros, currency)} / {money(e.budgetMicros, currency)}
                </td>
                <td className="text-right">{int(ledger.registered)}</td>
                <td className="text-right">
                  {ledger.cpaMicros === null ? "—" : money(ledger.cpaMicros, currency)} <span className="text-neutral-500">({metricText(e.primaryMetric, e.targetValue, currency)})</span>
                </td>
                <td>{e.conclusion ? `${e.conclusion}: ${e.result?.verdict?.reason ?? ""}` : e.status === "running" ? e.result?.killRule : "waiting for a slot"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

export function Missions() {
  const { brand } = useCurrentBrand();
  const slug = brand?.slug ?? null;
  const q = useQuery({
    queryKey: ["missions", slug],
    queryFn: () => api<{ missions: { mission: Mission; progress: Progress | null }[]; aiIsMock: boolean }>(`/api/brands/${slug}/missions`),
    enabled: slug !== null,
  });
  if (!brand) return <p className="text-sm text-neutral-500">No brand yet.</p>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Missions</h1>
        <MockBadge show={!!q.data?.aiIsMock} what="strategist" />
      </div>
      <p className="text-sm text-neutral-500">A goal with a budget. MarketingBrain reads it back as fields, plans a few experiments, and asks for each campaign as a proposal on Today. Nothing spends until you approve it there. A blocked ask is asked again each morning until the policy allows it or the experiment ends.</p>
      <NewMission slug={brand.slug} />
      {q.isError && <p className="text-sm text-red-600">{q.error.message}</p>}
      <ul className="space-y-3">{q.data?.missions.map(({ mission, progress }) => <MissionCard key={mission.id} m={mission} progress={progress} slug={brand.slug} currency={brand.defaultCurrency} />)}</ul>
    </div>
  );
}
