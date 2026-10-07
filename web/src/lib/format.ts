// Money arrives as integer micros in the brand's currency.
export function money(micros: number | null | undefined, currency: string, opts: { cents?: boolean } = {}): string {
  if (micros === null || micros === undefined) return "—";
  const v = micros / 1_000_000;
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: opts.cents ? 2 : 0 }).format(v);
}

export function int(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : new Intl.NumberFormat().format(n);
}

export function pct(num: number, den: number): string {
  return den > 0 ? `${((100 * num) / den).toFixed(1)}%` : "—";
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "in 3 h", "in 2 d", or "overdue" for a future instant. */
export function untilTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return "overdue";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}
