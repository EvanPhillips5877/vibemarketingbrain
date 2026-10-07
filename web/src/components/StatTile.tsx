// A hero number: label in muted ink, the value large, one line of context.
// No colour carries meaning here; the text does.
export function StatTile({ label, value, context }: { label: string; value: string; context?: string }) {
  return (
    <div className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {context && <div className="mt-1 text-xs text-neutral-500">{context}</div>}
    </div>
  );
}

export function WindowPicker({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <div className="flex gap-1 text-sm" role="group" aria-label="Period">
      {[7, 30, 90].map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          aria-pressed={days === d}
          className={`rounded-md px-3 py-1 ${days === d ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

export function MockBadge({ show, what }: { show: boolean; what: string }) {
  if (!show) return null;
  return (
    <span className="rounded border border-amber-400 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-700 dark:text-amber-300" title={`${what} is pretend data until credentials are configured`}>
      mock {what}
    </span>
  );
}
