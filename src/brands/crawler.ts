import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { brandPages, type Brand } from "../db/schema.js";

// Reads the brand's own public site: sitemap first, robots.txt respected,
// same host only, a page cap and a byte cap. What comes back is text for
// the extractor to quote from; it is never executed and never trusted.

export interface CrawledPage {
  url: string;
  status: number;
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
}

export interface CrawlOptions {
  maxPages?: number;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const UA = "MarketingBrain/0.1 (+internal; reads only the brand's own site)";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Pure: pull title, description, headings and readable text out of HTML. */
export function extractPage(url: string, status: number, html: string, maxChars = 20_000): CrawledPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1];
  const headings: string[] = [];
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const h = clean(m[2] ?? "");
    if (h && !headings.includes(h)) headings.push(h.slice(0, 200));
  }
  const body =
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, " ") || "";
  const main = /<main[\s\S]*?<\/main>/i.exec(body)?.[0] ?? body;
  return {
    url,
    status,
    title: title ? clean(title).slice(0, 300) : null,
    description: description ? clean(description).slice(0, 500) : null,
    headings: headings.slice(0, 40),
    text: clean(main).slice(0, maxChars),
  };
}

/** Pure: the paths robots.txt disallows for everyone. */
export function parseRobots(txt: string): string[] {
  const out: string[] = [];
  let applies = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    if (k?.toLowerCase() === "user-agent") applies = v === "*";
    else if (applies && k?.toLowerCase() === "disallow" && v) out.push(v);
  }
  return out;
}

export function isAllowed(url: URL, disallowed: string[]): boolean {
  return !disallowed.some((p) => url.pathname.startsWith(p));
}

export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));
}

/** Read at most maxBytes of a body, then stop; the rest is never downloaded. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = maxBytes - total;
      chunks.push(value.length > room ? value.subarray(0, room) : value);
      total += Math.min(value.length, room);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/**
 * Fetch with redirects handled by hand: every hop must pass `allowed`
 * (same host, not disallowed by robots), so a page cannot bounce the
 * crawler to another site or to an internal address.
 */
async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  maxBytes: number,
  allowed: (u: URL) => boolean,
): Promise<{ status: number; text: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, { headers: { "user-agent": UA, accept: "text/html,application/xml,text/plain" }, redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) return { status: res.status, text: "", finalUrl: current };
        const next = new URL(loc, current);
        next.hash = "";
        if (!allowed(next)) return { status: 0, text: "", finalUrl: next.toString() }; // refused: off-site or disallowed
        current = next.toString();
        continue;
      }
      return { status: res.status, text: await readCapped(res, maxBytes), finalUrl: current };
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: 0, text: "", finalUrl: current }; // too many redirects
}

/** Crawl the brand's site into brand_pages. Returns what was fetched. */
export async function crawlBrandSite(db: Db, brand: Brand, opts: CrawlOptions = {}): Promise<CrawledPage[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 30;
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const origin = new URL(brand.website);
  const sameHost = (u: URL) => u.hostname.replace(/^www\./, "") === origin.hostname.replace(/^www\./, "") && /^https?:$/.test(u.protocol);

  let disallowed: string[] = [];
  try {
    const robots = await fetchText(fetchImpl, new URL("/robots.txt", origin).toString(), timeoutMs, 64 * 1024, sameHost);
    if (robots.status === 200) disallowed = parseRobots(robots.text);
  } catch {
    // no robots: nothing disallowed
  }
  const allowed = (u: URL) => sameHost(u) && isAllowed(u, disallowed);

  const candidates: string[] = [origin.toString()];
  try {
    const sm = await fetchText(fetchImpl, new URL("/sitemap.xml", origin).toString(), timeoutMs, maxBytes, allowed);
    if (sm.status === 200) candidates.push(...parseSitemap(sm.text));
  } catch {
    // no sitemap: the homepage alone
  }

  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  for (const raw of candidates) {
    if (pages.length >= maxPages) break;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    u.hash = "";
    const key = u.toString();
    if (seen.has(key) || !allowed(u)) continue;
    seen.add(key);
    try {
      const r = await fetchText(fetchImpl, key, timeoutMs, maxBytes, allowed);
      pages.push(extractPage(key, r.status, r.status === 200 ? r.text : ""));
    } catch (err) {
      pages.push({ url: key, status: 0, title: null, description: null, headings: [], text: "" });
      console.warn(`[crawl] ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const p of pages) {
    await db
      .insert(brandPages)
      .values({ brandId: brand.id, url: p.url, title: p.title, description: p.description, headings: p.headings, text: p.text, httpStatus: p.status })
      .onConflictDoUpdate({
        target: [brandPages.brandId, brandPages.url],
        set: { title: p.title, description: p.description, headings: p.headings, text: p.text, httpStatus: p.status, fetchedAt: sql`now()` },
      });
  }
  // The mirror is this crawl, not every page ever seen: a page the site
  // dropped must not keep feeding the extractor. (Only when the crawl saw
  // the sitemap; a page cap that cut the list short is not a removal.)
  if (pages.length > 0 && pages.length < maxPages) {
    await db.delete(brandPages).where(and(eq(brandPages.brandId, brand.id), notInArray(brandPages.url, pages.map((p) => p.url))));
  }
  return pages;
}
