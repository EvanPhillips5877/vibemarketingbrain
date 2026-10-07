import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ASPECT_RATIOS, RATIO_SIZES, type MetaImagePayload } from "./formats.js";

// Image rendering without a model: a handful of fixed layouts, the
// brand's own screenshot where one exists, overlay text from the copy.
// Deterministic (same inputs, same bytes), so a variant can be re-rendered
// and compared. Files land under data/assets/ for now; S3 is the deploy
// phase's job and only this file knows the path.

export interface RenderInput {
  payload: MetaImagePayload;
  brandName: string;
  /** PNG/JPEG bytes of a product screenshot, when the template uses one. */
  screenshot?: Buffer | null;
  /** Hex colours; defaults are neutral. */
  colors?: { background?: string; accent?: string; text?: string };
}

export interface RenderedImage {
  ratio: (typeof ASPECT_RATIOS)[number];
  width: number;
  height: number;
  png: Buffer;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap for SVG text: lines of at most `maxChars`. */
export function wrap(text: string, maxChars: number, maxLines = 4): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.slice(0, maxChars - 1).trimEnd()}…`;
    return kept;
  }
  return lines;
}

function svgFor(input: RenderInput, width: number, height: number, screenshotBox: { x: number; y: number; w: number; h: number } | null): string {
  const bg = input.colors?.background ?? "#0f172a";
  const accent = input.colors?.accent ?? "#f59e0b";
  const fg = input.colors?.text ?? "#ffffff";
  const pad = Math.round(width * 0.07);
  const titleSize = Math.round(width * (input.payload.template === "quote_card" ? 0.07 : 0.085));
  const lineH = Math.round(titleSize * 1.15);
  const maxChars = Math.max(10, Math.floor((width - 2 * pad) / (titleSize * 0.55)));
  const lines = wrap(input.payload.overlayText, maxChars, 4);
  const textTop = screenshotBox ? pad + Math.round(titleSize * 0.9) : Math.round(height * 0.4) - Math.round((lines.length * lineH) / 2);
  const title = lines.map((l, i) => `<text x="${pad}" y="${textTop + i * lineH}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${titleSize}" fill="${fg}">${esc(l)}</text>`).join("");
  const subSize = Math.round(width * 0.035);
  const sub = input.payload.overlaySubtext ? `<text x="${pad}" y="${height - pad}" font-family="Arial, Helvetica, sans-serif" font-size="${subSize}" fill="${fg}" opacity="0.85">${esc(input.payload.overlaySubtext)}</text>` : "";
  const quoteMark = input.payload.template === "quote_card" ? `<text x="${pad}" y="${textTop - Math.round(titleSize * 0.6)}" font-family="Georgia, serif" font-size="${titleSize * 2}" fill="${accent}" opacity="0.6">“</text>` : "";
  const stat = input.payload.template === "stat_card" ? `<rect x="${pad}" y="${textTop - Math.round(titleSize * 1.6)}" width="${Math.round(width * 0.18)}" height="${Math.round(titleSize * 0.18)}" fill="${accent}"/>` : "";
  const frame = screenshotBox ? `<rect x="${screenshotBox.x - 6}" y="${screenshotBox.y - 6}" width="${screenshotBox.w + 12}" height="${screenshotBox.h + 12}" rx="18" fill="${accent}" opacity="0.9"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${bg}"/>${stat}${quoteMark}${title}${sub}${frame}</svg>`;
}

/** Render one aspect ratio. */
export async function renderOne(input: RenderInput, ratio: (typeof ASPECT_RATIOS)[number]): Promise<RenderedImage> {
  const { width, height } = RATIO_SIZES[ratio];
  const wantsShot = input.payload.template === "screenshot_headline" && input.screenshot;
  let box: { x: number; y: number; w: number; h: number } | null = null;
  let shot: Buffer | null = null;
  if (wantsShot) {
    const pad = Math.round(width * 0.07);
    const boxW = width - 2 * pad;
    const boxH = Math.round(height * (ratio === "16:9" ? 0.5 : 0.48));
    box = { x: pad, y: height - pad - boxH - Math.round(height * 0.06), w: boxW, h: boxH };
    shot = await sharp(input.screenshot!).resize(boxW, boxH, { fit: "cover", position: "top" }).png().toBuffer();
  }
  const base = sharp(Buffer.from(svgFor(input, width, height, box))).png();
  const png = box && shot ? await base.composite([{ input: shot, left: box.x, top: box.y }]).png().toBuffer() : await base.toBuffer();
  return { ratio, width, height, png };
}

export async function renderAll(input: RenderInput): Promise<RenderedImage[]> {
  const out: RenderedImage[] = [];
  for (const ratio of ASPECT_RATIOS) out.push(await renderOne(input, ratio));
  return out;
}

export const ASSET_DIR = path.resolve(process.cwd(), "data/assets");

export function storeAsset(id: string, png: Buffer): string {
  mkdirSync(ASSET_DIR, { recursive: true });
  const key = `rendered/${id}.png`;
  mkdirSync(path.join(ASSET_DIR, "rendered"), { recursive: true });
  writeFileSync(path.join(ASSET_DIR, key), png);
  return key;
}

export function readAsset(storageKey: string): Buffer | null {
  const safe = path.normalize(storageKey).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(ASSET_DIR, safe);
  if (!full.startsWith(ASSET_DIR)) return null;
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}
