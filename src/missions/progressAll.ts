import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brands } from "../db/schema.js";
import { progressBrand, type ProgressReport } from "./progress.js";

/** Every active brand gets its daily pass; one failure is recorded, not propagated. */
export async function progressAllBrands(db: Db): Promise<(ProgressReport | { brandId: string; error: string })[]> {
  const all = await db.select().from(brands).where(eq(brands.status, "active"));
  const out: (ProgressReport | { brandId: string; error: string })[] = [];
  for (const b of all) {
    try {
      out.push(await progressBrand(db, b.id));
    } catch (err) {
      out.push({ brandId: b.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
