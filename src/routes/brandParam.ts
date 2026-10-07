import type { Response } from "express";
import { z } from "zod";
import { getBrand, type BrandDetail } from "../brands/queries.js";
import type { Db } from "../db/client.js";

// Shared by every /api/brands/:slug/* route: validate the slug, load the
// brand, answer 404 once. A malformed slug and a missing brand look the same.
export const slugSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export async function brandOr404(db: Db, slugRaw: unknown, res: Response): Promise<BrandDetail | null> {
  const slug = slugSchema.safeParse(slugRaw);
  const detail = slug.success ? await getBrand(db, slug.data) : null;
  if (!detail) res.status(404).json({ error: "not found" });
  return detail;
}
