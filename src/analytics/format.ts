// One money formatter for everything that renders micros into prose.
export function moneyText(currency: string, micros: number | null | undefined): string {
  return micros === null || micros === undefined ? "n/a" : `${currency} ${(micros / 1_000_000).toFixed(2)}`;
}

/** YYYY-MM-DD for `daysAgo` days before `now`, as the calendar reads in `timeZone`. */
export function localDay(now: Date, timeZone: string, daysAgo = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
