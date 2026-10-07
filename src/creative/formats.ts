import { z } from "zod/v4";
import type { CreativeFormatSpec } from "../channels/adapter.js";

// Channel-native formats and the hard limits each platform enforces. The
// zod schemas are the gate: a variant that does not parse is not stored.
// Limits here are the platforms' documented maxima as of 2026-10.

export const META_CTAS = ["LEARN_MORE", "SIGN_UP", "GET_STARTED", "BOOK_NOW", "CONTACT_US"] as const;
export const IMAGE_TEMPLATES = ["screenshot_headline", "stat_card", "quote_card", "plain_headline"] as const;
export const ASPECT_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;

export const metaImagePayloadSchema = z
  .object({
    primaryText: z.string().min(1).max(125),
    headline: z.string().min(1).max(40),
    description: z.string().max(30).default(""),
    cta: z.enum(META_CTAS),
    template: z.enum(IMAGE_TEMPLATES),
    overlayText: z.string().min(1).max(60),
    overlaySubtext: z.string().max(80).default(""),
  })
  .strict();
export type MetaImagePayload = z.infer<typeof metaImagePayloadSchema>;

export const googleRsaPayloadSchema = z
  .object({
    headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
    descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
    keywords: z.array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(["exact", "phrase", "broad"]) })).min(5).max(20),
    path1: z.string().max(15).default(""),
    path2: z.string().max(15).default(""),
  })
  .strict()
  .refine((p) => new Set(p.headlines.map((h) => h.toLowerCase())).size === p.headlines.length, { message: "headlines must be distinct" });
export type GoogleRsaPayload = z.infer<typeof googleRsaPayloadSchema>;

export const FORMATS = ["meta_image", "google_rsa"] as const;
export type Format = (typeof FORMATS)[number];

export const FORMAT_SPECS: Record<Format, CreativeFormatSpec> = {
  meta_image: {
    format: "meta_image",
    textFields: [
      { name: "primaryText", maxChars: 125 },
      { name: "headline", maxChars: 40 },
      { name: "description", maxChars: 30 },
      { name: "overlayText", maxChars: 60 },
    ],
    imageAspectRatios: [...ASPECT_RATIOS],
    landingUrlMacro: "utm_content={{ad.id}}",
  },
  google_rsa: {
    format: "google_rsa",
    textFields: [
      { name: "headlines", maxChars: 30, min: 3, max: 15 },
      { name: "descriptions", maxChars: 90, min: 2, max: 4 },
    ],
    imageAspectRatios: [],
    landingUrlMacro: "utm_content={creative}&utm_term={keyword}",
  },
};

export const channelOf: Record<Format, "meta" | "google"> = { meta_image: "meta", google_rsa: "google" };

/** The copy alone: a stored variant also carries its compliance verdict, which is not part of the format. */
export function stripCompliance(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { compliance: _c, ...rest } = payload as Record<string, unknown>;
  return rest;
}

export function parsePayload(format: Format, payload: unknown): MetaImagePayload | GoogleRsaPayload {
  const p = stripCompliance(payload);
  return format === "meta_image" ? metaImagePayloadSchema.parse(p) : googleRsaPayloadSchema.parse(p);
}

/** Every piece of copy in a payload, for the compliance check. */
export function copyOf(format: Format, payload: MetaImagePayload | GoogleRsaPayload): string[] {
  if (format === "meta_image") {
    const p = payload as MetaImagePayload;
    return [p.primaryText, p.headline, p.description, p.overlayText, p.overlaySubtext].filter(Boolean);
  }
  const p = payload as GoogleRsaPayload;
  return [...p.headlines, ...p.descriptions];
}

/** Pixel sizes per aspect ratio, at the platforms' recommended resolutions. */
export const RATIO_SIZES: Record<(typeof ASPECT_RATIOS)[number], { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1200, height: 675 },
};
