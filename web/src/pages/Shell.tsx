import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api, type Me } from "../api";
import { CommandBar } from "../components/CommandBar";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Today" },
  { href: "/missions", label: "Missions" },
  { href: "/creative", label: "Creative" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/learnings", label: "Learnings" },
  { href: "/brands", label: "Brands" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const [location] = useLocation();
  const queryClient = useQueryClient();

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex items-center gap-2 overflow-x-auto border-b border-neutral-200 px-4 py-3 md:w-52 md:flex-col md:items-stretch md:border-b-0 md:border-r dark:border-neutral-800">
        <div className="mr-4 text-sm font-semibold tracking-tight md:mb-4 md:mr-0">MarketingBrain</div>
        <nav className="flex gap-1 md:flex-col">
          {NAV.map((item) => {
            const active = item.href === "/" ? location === "/" : location.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500 md:mt-auto md:ml-0 md:flex-col md:items-start">
          <span className="truncate">{me.user.email}</span>
          <button onClick={() => void logout()} className="underline hover:text-neutral-900 dark:hover:text-white">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 px-4 py-6 md:px-8">
        <CommandBar />
        {children}
      </main>
    </div>
  );
}
