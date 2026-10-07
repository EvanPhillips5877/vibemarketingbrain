import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const mode = useQuery({ queryKey: ["auth-mode"], queryFn: () => api<{ authMode: "google" | "dev" }>("/api/auth-mode") });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function devLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/auth/dev-login", { method: "POST", body: { email } });
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign-in failed");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MarketingBrain</h1>
        <p className="mt-1 text-sm text-neutral-500">Private. Sign in to continue.</p>
      </div>
      {mode.data?.authMode === "google" && (
        <a
          href="/auth/google"
          className="rounded-md bg-neutral-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
        >
          Sign in with Google
        </a>
      )}
      {mode.data?.authMode === "dev" && (
        <form onSubmit={devLogin} className="flex flex-col gap-3">
          <label className="text-xs uppercase tracking-wide text-neutral-500">Development sign-in (no Google configured)</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900">
            Sign in
          </button>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
