import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface BrandRow {
  brand: { slug: string; name: string; defaultCurrency: string };
}

/** V1 runs one brand; the first one listed is "the" brand until a switcher exists. */
export function useCurrentBrand() {
  const q = useQuery({ queryKey: ["brands"], queryFn: () => api<{ brands: BrandRow[] }>("/api/brands") });
  return { ...q, brand: q.data?.brands[0]?.brand ?? null };
}
