// Tape King catalog assembly (TAPEKING_SITE_SCOPE.md §6).
//
// Merges the curated line/SKU model (src/content/brands/<slug>/catalog.yaml)
// with the live Supabase catalog (public.brand_site_products) at build time:
// the yaml owns identity (display names, lines, formats, pack counts, roll
// specs), bronze owns money (price, attribution URL). Per-roll and per-yard
// figures are DERIVED here — never authored, never hardcoded in templates.
//
// Per-yard is comparable within a width only (scope §4) — callers must never
// cross-compare per-yard between widths in UI copy.

import { getCollection } from 'astro:content';
import { getProducts, getReviewStats } from './supabase.js';

const BRAND_SLUG = import.meta.env.BRAND_SLUG;

const round2 = (v) => Math.round(v * 100) / 100;

/** `2` → `2"`, `1.88` → `1.88"` */
export function formatInches(widthIn) {
  return widthIn == null ? null : `${widthIn}"`;
}

/** Mono card/chip spec derived from SKU fields, e.g. `2.7 MIL · 2" × 60 YD`. */
export function specLine({ mil, width_in, roll_yards }) {
  const parts = [];
  if (mil != null) parts.push(`${mil} MIL`);
  if (width_in != null && roll_yards != null) parts.push(`${formatInches(width_in)} × ${roll_yards} YD`);
  return parts.length ? parts.join(' · ') : null;
}

export function formatMoney(value) {
  return value == null ? null : `$${value.toFixed(2)}`;
}

/** Per-yard in cents with one decimal, e.g. `4.7¢/yd`. */
export function formatPerYard(perYard) {
  return perYard == null ? null : `${(perYard * 100).toFixed(1)}¢/yd`;
}

let catalogPromise;

/**
 * The assembled catalog:
 *   { lines: [...], skus: [...], skuByAsin: Map }
 *
 * Each sku: yaml fields + { price, amazon_url, attribution_url, live,
 *   per_roll, per_yard, total_yards, save_pct }
 * - live=false → the ASIN is not in brand_site_products (hidden upstream via
 *   hide_from_site, or delisted): price/math are null and a build warning
 *   names it. amazon_url still resolves (plain /dp/ fallback) so cards can
 *   link out.
 * - save_pct: per-roll saving vs the smallest priced pack in the same
 *   (line, format_key) ladder, only when it's an actual saving (≥1%).
 *
 * Each line: yaml fields + { skus, visibleSkus, spec, reviews }
 * - spec: spec_override, else derived from the representative SKU
 * - reviews: { rating, count } — MAX across the line's ASINs (Amazon pools
 *   reviews per listing; summing overcounts), null when stats are missing.
 */
export function getTapeCatalog() {
  catalogPromise ??= (async () => {
    const entries = await getCollection('catalog');
    const entry = entries.find((e) => e.id === `${BRAND_SLUG}/catalog`);
    if (!entry) {
      throw new Error(`[tapeking.js] no catalog.yaml for brand "${BRAND_SLUG}".`);
    }
    const { lines, skus } = entry.data;

    // Structural validation — bad authoring fails the build loudly.
    const problems = [];
    const lineSlugs = new Set(lines.map((l) => l.slug));
    if (lineSlugs.size !== lines.length) problems.push('duplicate line slugs');
    const seen = new Set();
    for (const s of skus) {
      if (seen.has(s.asin)) problems.push(`duplicate SKU ${s.asin}`);
      seen.add(s.asin);
      if (!lineSlugs.has(s.line)) problems.push(`${s.asin}: unknown line "${s.line}"`);
    }
    for (const l of lines) {
      if (!seen.has(l.representative_asin)) problems.push(`line "${l.slug}": representative ${l.representative_asin} has no SKU entry`);
      if (l.spec_override == null && !skus.some((s) => s.asin === l.representative_asin && specLine(s))) {
        problems.push(`line "${l.slug}": no spec_override and representative SKU derives no spec`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`[tapeking.js] invalid catalog.yaml:\n  ${problems.join('\n  ')}`);
    }

    const [products, stats] = await Promise.all([getProducts(), getReviewStats()]);
    const liveByAsin = new Map(products.map((p) => [p.asin, p]));

    const missingLive = skus.filter((s) => !liveByAsin.has(s.asin));
    if (missingLive.length > 0) {
      console.warn(
        `[tapeking.js] ${missingLive.length} curated SKU(s) not in brand_site_products (hide_from_site or delisted) — no price/math for: ${missingLive.map((s) => s.asin).join(', ')}`
      );
    }
    const uncurated = products.filter((p) => !seen.has(p.asin));
    if (uncurated.length > 0) {
      console.warn(
        `[tapeking.js] ${uncurated.length} live product(s) missing from catalog.yaml (will not appear on curated surfaces): ${uncurated.map((p) => p.asin).join(', ')}`
      );
    }

    const mergedSkus = skus.map((s) => {
      const live = liveByAsin.get(s.asin) ?? null;
      const price = live?.item_price ?? null;
      const per_roll = price != null ? round2(price / s.pack_count) : null;
      const total_yards = s.roll_yards != null ? s.roll_yards * s.pack_count : null;
      const per_yard = price != null && total_yards != null ? price / total_yards : null;
      return {
        ...s,
        live: live != null,
        price,
        per_roll,
        per_yard,
        total_yards,
        attribution_url: live?.attribution_url ?? null,
        amazon_url: live?.amazon_url ?? `https://www.amazon.com/dp/${s.asin}`,
      };
    });

    // Savings badge: within each (line, format_key) ladder, vs the smallest
    // priced pack's per-roll figure.
    const ladders = new Map();
    for (const s of mergedSkus) {
      const key = `${s.line}/${s.format_key}`;
      if (!ladders.has(key)) ladders.set(key, []);
      ladders.get(key).push(s);
    }
    for (const rungs of ladders.values()) {
      rungs.sort((a, b) => a.pack_count - b.pack_count);
      const base = rungs.find((r) => r.per_roll != null) ?? null;
      for (const r of rungs) {
        const pct = base && r !== base && r.per_roll != null ? Math.round((1 - r.per_roll / base.per_roll) * 100) : null;
        r.save_pct = pct != null && pct >= 1 ? pct : null;
      }
    }

    const skuByAsin = new Map(mergedSkus.map((s) => [s.asin, s]));

    const mergedLines = lines.map((l) => {
      const lineSkus = mergedSkus.filter((s) => s.line === l.slug);
      const rep = skuByAsin.get(l.representative_asin);
      // Family review aggregate: MAX across the line's children, never the sum
      // (same rule as content.js familyReviewStats).
      let reviews = null;
      for (const s of lineSkus) {
        const r = stats.get(s.asin);
        if (r?.review_count != null && (reviews === null || r.review_count > reviews.count)) {
          reviews = { rating: r.rating, count: r.review_count };
        }
      }
      return {
        ...l,
        skus: lineSkus,
        visibleSkus: lineSkus.filter((s) => !s.hidden && s.live),
        spec: l.spec_override ?? specLine(rep),
        reviews,
      };
    });

    return { lines: mergedLines, skus: mergedSkus, skuByAsin };
  })();
  return catalogPromise;
}
