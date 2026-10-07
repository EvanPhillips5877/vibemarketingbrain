import type { Me } from "../api";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-neutral-200 py-2 text-sm dark:border-neutral-800">
      <span className="text-neutral-500">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export function Settings({ me }: { me: Me }) {
  return (
    <section className="max-w-lg">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <h2 className="mt-6 text-xs uppercase tracking-wide text-neutral-500">Signed in</h2>
      <Row label="Email" value={me.user.email} />
      <Row label="Name" value={me.user.name ?? "—"} />
      <Row label="Sign-in" value={me.authMode === "google" ? "Google" : "development form"} />
      <h2 className="mt-6 text-xs uppercase tracking-wide text-neutral-500">Integrations</h2>
      <Row label="Environment" value={me.env} />
      <Row label="Claude" value={me.mock.ai ? "mock" : "live"} />
      <Row label="Meta Ads" value={me.mock.meta ? "mock" : "live"} />
      <Row label="Google Ads" value={me.mock.googleAds ? "mock" : "live"} />
      <p className="mt-6 text-sm text-neutral-500">Autonomy rules, brand policies and budgets arrive with the Action Engine.</p>
    </section>
  );
}
