import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { api } from "../api";
import { useCurrentBrand } from "../lib/brand";
import { money } from "../lib/format";

interface Claim {
  kind: "FACT" | "OBSERVATION" | "HYPOTHESIS" | "RECOMMENDATION" | "ACTION";
  text: string;
  evidence: string[];
}
interface Entry {
  id: string;
  label: string;
  value: number | null;
  unit: "micros" | "count" | "ratio" | "pct";
  window: string;
  insufficient?: boolean;
  note?: string;
}
interface Outcome {
  action: { tool: "propose_action" | "propose_mission" | "generate_creatives" } & Record<string, unknown>;
  ok: boolean;
  detail: string;
  proposal?: { id: string; status: string; policyResult: { violations: { rule: string; detail: string }[] } | null };
  missionId?: string;
  generated?: { variants: number };
}
interface Result {
  runId: string;
  isMock: boolean;
  model: string;
  answer: string;
  claims: Claim[];
  dropped: { claim: Claim; problems: string[] }[];
  cannot: string | null;
  actions: Outcome[];
  evidence: Entry[];
  currency: string;
}

const KIND: Record<Claim["kind"], string> = {
  FACT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  OBSERVATION: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  HYPOTHESIS: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  RECOMMENDATION: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  ACTION: "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100",
};

const EXAMPLES = ["How did we do this week?", "Why is CPA up?", "What have we learned?", "Is the mission on track?", "Pause Volleyball - abstract art", "Set Spring tryouts - CA budget to $25/day", "Get 50 new coaches under $20 each with $500", "Make ads about fairness for volleyball clubs"];

function Evidence({ ids, entries, currency }: { ids: string[]; entries: Map<string, Entry>; currency: string }) {
  const show = (e: Entry) => (e.value === null ? (e.note ?? "") : e.unit === "micros" ? money(e.value, currency, { cents: true }) : e.unit === "pct" ? `${e.value}%` : String(e.value));
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => {
        const e = entries.get(id);
        const text = e ? `${e.label.length > 28 ? `${e.label.slice(0, 27)}…` : e.label}${show(e) ? `: ${show(e).slice(0, 60)}` : ""}` : id;
        return (
          <span key={id} title={e ? `${e.label} · ${e.window}${e.insufficient ? " · insufficient data" : ""}${e.note ? ` · ${e.note}` : ""}` : id} className="rounded border border-neutral-300 px-1 font-mono text-[10px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
            {text}
          </span>
        );
      })}
    </span>
  );
}

function OutcomeLine({ o }: { o: Outcome }) {
  const a = o.action;
  const label = a.tool === "propose_action" ? `${String(a["type"]).replace("_", " ").toLowerCase()}` : a.tool === "propose_mission" ? "draft mission" : "generate creatives";
  const where = o.proposal ? <Link href="/" className="underline">Today</Link> : o.missionId ? <Link href="/missions" className="underline">Missions</Link> : o.generated ? <Link href="/creative" className="underline">Creative</Link> : null;
  const v = o.proposal?.policyResult?.violations ?? [];
  return (
    <li className={`text-xs ${o.ok ? "" : "text-red-600"}`}>
      <span className="font-medium">{label}</span> · {o.detail}
      {v.length > 0 && <span className="text-red-600"> · blocked: {v.map((x) => x.rule).join(", ")}</span>}
      {where && <> · see {where}</>}
    </li>
  );
}

export function CommandBar() {
  const { brand } = useCurrentBrand();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [history, setHistory] = useState<{ text: string; result: Result }[]>([]);
  const run = useMutation({
    mutationFn: (t: string) => api<Result>(`/api/brands/${brand!.slug}/command`, { method: "POST", body: { text: t } }),
    onSuccess: (result, t) => {
      setHistory((h) => [{ text: t, result }, ...h].slice(0, 5));
      setText("");
      for (const key of ["proposals", "missions", "creative"]) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!brand) return null;
  return (
    <section className="mb-6">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (run.isPending) return; // one run at a time: Enter twice must not spend twice
          if (text.trim().length >= 2) run.mutate(text.trim());
        }}
      >
        <input
          aria-label="Command"
          className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
          placeholder="Ask or instruct: “Why is CPA up?”, “Pause Volleyball - abstract art”, “Get 50 coaches under $20 with $500”"
          value={text}
          onChange={(e) => setText(e.target.value)}
          list="command-examples"
        />
        <datalist id="command-examples">
          {EXAMPLES.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <button type="submit" disabled={run.isPending || text.trim().length < 2} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
          {run.isPending ? "Thinking…" : "Ask"}
        </button>
      </form>
      {run.isError && <p className="mt-1 text-xs text-red-600">{run.error.message}</p>}
      {history.map(({ text: t, result }, i) => {
        const entries = new Map(result.evidence.map((e) => [e.id, e]));
        return (
          <div key={result.runId} className={`mt-3 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800 ${i > 0 ? "opacity-70" : ""}`}>
            <p className="text-xs text-neutral-500">
              “{t}” · {result.model}
              {result.isMock && <span className="ml-1 rounded border border-amber-400 px-1 font-mono text-[10px] uppercase text-amber-700">mock</span>}
            </p>
            <p className="mt-1">{result.answer}</p>
            {result.cannot && <p className="mt-1 text-xs text-amber-700">Cannot: {result.cannot}</p>}
            {result.claims.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.claims.map((c, j) => (
                  <li key={j} className="text-sm">
                    <span className={`mr-1 rounded px-1 font-mono text-[10px] ${KIND[c.kind]}`}>{c.kind}</span>
                    {c.text}
                    {c.evidence.length > 0 && <Evidence ids={c.evidence} entries={entries} currency={result.currency} />}
                  </li>
                ))}
              </ul>
            )}
            {result.actions.length > 0 && <ul className="mt-2 space-y-0.5">{result.actions.map((o, j) => <OutcomeLine key={j} o={o} />)}</ul>}
            {result.dropped.length > 0 && (
              <p className="mt-1 text-xs text-neutral-500">
                {result.dropped.length} claim{result.dropped.length === 1 ? "" : "s"} dropped: {result.dropped.map((d) => d.problems[0]).join("; ")}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
