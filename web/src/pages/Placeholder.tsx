export function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-prose text-sm text-neutral-500">{blurb}</p>
      <p className="mt-6 rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
        Nothing here yet. This screen arrives in a later phase.
      </p>
    </section>
  );
}
