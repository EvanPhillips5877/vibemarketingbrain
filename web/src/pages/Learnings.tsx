import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { useCurrentBrand } from "../lib/brand";
import { money, relativeTime } from "../lib/format";

interface Learning {
  id: string;
  statement: string;
  kind: "observation" | "hypothesis" | "validated" | "refuted";
  scope: string;
  dimensions: Record<string, string>;
  evidence: Record<string, unknown> & { groups?: { value: string; registered: number; spendMicros: number; cpaMicros: number | null; ads: number }[]; window?: { from: string; to: string }; experimentId?: string; ledger?: { spendMicros: number; registered: number; cpaMicros: number | null } };
  confidence: number | null;
  status: "active" | "retired";
  supersedesId: string | null;
  createdBy: string;
  createdAt: string;
}

const KIND: Record<Learning["kind"], string> = {
  validated: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  refuted: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  observation: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  hypothesis: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
};
const btn = "rounded-md border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function Evidence({ l, currency }: { l: Learning; currency: string }) {
  const e = l.evidence;
  if (e.groups) {
    return (
      <table className="mt-1 text-xs">
        <tbody>
          {e.groups.map((g) => (
            <tr key={g.value}>
              <td className="pr-3 font-mono">{g.value}</td>
              <td className="pr-3 text-right">{g.cpaMicros === null ? "—" : money(g.cpaMicros, currency, { cents: true })} CPA</td>
              <td className="pr-3 text-right">{g.registered} reg.</td>
              <td className="pr-3 text-right">{money(g.spendMicros, currency)}</td>
              <td className="text-neutral-500">{g.ads} ads</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (e.ledger) return <p className="mt-1 text-xs text-neutral-500">Experiment ledger: {money(e.ledger.spendMicros, currency)} spent, {e.ledger.registered} registrations, CPA {e.ledger.cpaMicros === null ? "—" : money(e.ledger.cpaMicros, currency, { cents: true })}.</p>;
  if (e["source"] === "manual") return <p className="mt-1 text-xs text-neutral-500">Entered by hand; no metric evidence.</p>;
  return null;
}

function Row({ l, slug, currency }: { l: Learning; slug: string; currency: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.statement);
  const act = useMutation({
    mutationFn: (body: { action: "edit" | "retire" | "restore"; fields?: unknown }) => api(`/api/brands/${slug}/learnings/${l.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["learnings", slug] });
    },
  });
  return (
    <li className={`rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800 ${l.status === "retired" ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span className={`rounded px-1 font-mono text-[10px] uppercase ${KIND[l.kind]}`}>{l.kind}</span>
        <span>{l.scope}</span>
        {Object.entries(l.dimensions).map(([k, v]) => (
          <span key={k} className="rounded border border-neutral-300 px-1 font-mono text-[10px] dark:border-neutral-700">
            {k.replace(/^hyp_/, "")}={v}
          </span>
        ))}
        {l.confidence !== null && <span>confidence {Math.round(l.confidence * 100)}%</span>}
        <span>· {l.createdBy.replace(/^manual:/, "")}</span>
        <span>· {relativeTime(l.createdAt)}</span>
        {l.status === "retired" && <span className="font-medium">retired</span>}
        {l.supersedesId && <span>· supersedes an earlier one</span>}
      </div>
      {editing ? (
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ action: "edit", fields: { statement: text } });
          }}
        >
          <textarea className="w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="mt-1 flex gap-2">
            <button className={btn} type="submit" disabled={act.isPending || text.trim().length < 5}>
              Save
            </button>
            <button className={btn} type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-1">{l.statement}</p>
      )}
      <Evidence l={l} currency={currency} />
      <div className="mt-2 flex gap-2">
        {l.status === "active" && !editing && (
          <button className={btn} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {l.status === "active" ? (
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "retire" })}>
            Retire
          </button>
        ) : (
          <button className={btn} disabled={act.isPending} onClick={() => act.mutate({ action: "restore" })}>
            Restore
          </button>
        )}
        {act.isError && <span className="text-xs text-red-600">{act.error.message}</span>}
      </div>
    </li>
  );
}

function NewLearning({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [statement, setStatement] = useState("");
  const [kind, setKind] = useState<"observation" | "hypothesis">("observation");
  const [scope, setScope] = useState("creative");
  const [dims, setDims] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const dimensions = Object.fromEntries(
        dims
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.includes("="))
          .map((p) => p.split("=").map((s) => s.trim()) as [string, string]),
      );
      return api(`/api/brands/${slug}/learnings`, { method: "POST", body: { statement, kind, scope, dimensions } });
    },
    onSuccess: () => {
      setStatement("");
      setDims("");
      void qc.invalidateQueries({ queryKey: ["learnings", slug] });
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
      <label className="block text-xs font-medium text-neutral-500" htmlFor="learning-text">
        Add what you know (observation or hypothesis; validated and refuted come only from experiments)
      </label>
      <textarea id="learning-text" className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent p-2 dark:border-neutral-700" rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Club directors reply to emails on Sunday evenings." />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" value={kind} onChange={(e) => setKind(e.target.value as "observation" | "hypothesis")}>
          <option value="observation">observation</option>
          <option value="hypothesis">hypothesis</option>
        </select>
        <select className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" value={scope} onChange={(e) => setScope(e.target.value)}>
          {["audience", "creative", "channel", "geo", "funnel"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="min-w-48 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" placeholder="dimensions: sport=volleyball, angle=fairness" value={dims} onChange={(e) => setDims(e.target.value)} />
        <button className={btn} type="submit" disabled={create.isPending || statement.trim().length < 5}>
          Add
        </button>
        {create.isError && <span className="text-red-600">{create.error.message}</span>}
      </div>
    </form>
  );
}

export function Learnings() {
  const { brand } = useCurrentBrand();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const slug = brand?.slug ?? null;
  const q = useQuery({ queryKey: ["learnings", slug, all], queryFn: () => api<{ learnings: Learning[] }>(`/api/brands/${slug}/learnings${all ? "?all=1" : ""}`), enabled: slug !== null });
  const distill = useMutation({
    mutationFn: () => api<{ written: unknown[]; skipped: string[] }>(`/api/brands/${slug}/learnings/distill`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["learnings", slug] }),
  });
  if (!brand) return <p className="text-sm text-neutral-500">No brand yet.</p>;
  const list = q.data?.learnings ?? [];
  const groups: [string, Learning[]][] = [
    ["From experiments", list.filter((l) => l.kind === "validated" || l.kind === "refuted")],
    ["Observed", list.filter((l) => l.kind === "observation")],
    ["Hypotheses", list.filter((l) => l.kind === "hypothesis")],
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Learnings</h1>
        <button className={btn} disabled={distill.isPending} onClick={() => distill.mutate()} title="Compare the last 28 days of ads by creative element; runs every Monday">
          {distill.isPending ? "Distilling…" : "Distill now"}
        </button>
        <label className="flex items-center gap-1 text-xs text-neutral-500">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show retired
        </label>
        {distill.data && <span className="text-xs text-neutral-500">{distill.data.written.length} written; nothing to say on {distill.data.skipped.join(", ") || "none"}</span>}
      </div>
      <p className="text-sm text-neutral-500">What MarketingBrain has learned, each with its evidence. Experiments write the validated and refuted ones; the weekly pass writes observations from ads that cleared the minimum sample; you can add and correct the rest. The strategist and the creative factory read the active ones.</p>
      <NewLearning slug={brand.slug} />
      {q.isError && <p className="text-sm text-red-600">{q.error.message}</p>}
      {groups.map(([title, items]) => (
        <section key={title}>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            {title} ({items.length})
          </h2>
          {items.length === 0 ? <p className="text-sm text-neutral-500">None yet.</p> : <ul className="space-y-2">{items.map((l) => <Row key={l.id} l={l} slug={brand.slug} currency={brand.defaultCurrency} />)}</ul>}
        </section>
      ))}
    </div>
  );
}
