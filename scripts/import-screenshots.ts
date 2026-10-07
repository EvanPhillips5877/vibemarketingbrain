import { readdirSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { brandAssets, brands } from "../src/db/schema.js";
import { loadDotEnv } from "../src/env.js";
import { ASSET_DIR } from "../src/creative/render.js";

// pnpm run assets:import [brand-slug]
// Drop product screenshots (PNG/JPG) in data/screenshots/ and run this:
// each becomes an approved brand asset the renderer can put on an ad.
// Re-running skips files already imported (by name tag).
loadDotEnv();
const config = loadConfig();
const handle = createDb(config.databaseUrl);
try {
  const slug = process.argv[2] ?? "tryoutbrain";
  const [brand] = await handle.db.select().from(brands).where(eq(brands.slug, slug));
  if (!brand) throw new Error(`no brand ${slug}`);
  const src = path.resolve(process.cwd(), "data/screenshots");
  mkdirSync(path.join(ASSET_DIR, "screenshots"), { recursive: true });
  let n = 0;
  for (const file of readdirSync(src).filter((f) => /\.(png|jpe?g)$/i.test(f))) {
    const existing = await handle.db.select({ id: brandAssets.id }).from(brandAssets).where(and(eq(brandAssets.brandId, brand.id), eq(brandAssets.kind, "screenshot")));
    const tagged = await handle.db.select({ tags: brandAssets.tags }).from(brandAssets).where(and(eq(brandAssets.brandId, brand.id), eq(brandAssets.kind, "screenshot")));
    if (tagged.some((t) => t.tags.includes(`file:${file}`))) continue;
    void existing;
    const bytes = readFileSync(path.join(src, file));
    const meta = await sharp(bytes).metadata(); // also proves it decodes as an image
    const [asset] = await handle.db.insert(brandAssets).values({ brandId: brand.id, kind: "screenshot", storageKey: "pending", tags: [`file:${file}`], width: meta.width ?? null, height: meta.height ?? null, approved: true }).returning();
    const key = `screenshots/${asset!.id}${path.extname(file).toLowerCase()}`;
    copyFileSync(path.join(src, file), path.join(ASSET_DIR, key));
    await handle.db.update(brandAssets).set({ storageKey: key }).where(eq(brandAssets.id, asset!.id));
    n++;
    console.log(`imported ${file} → ${key} (${meta.width}×${meta.height})`);
  }
  console.log(`${n} screenshot(s) imported for ${slug}`);
} finally {
  await handle.close();
}
