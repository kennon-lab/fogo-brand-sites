// Tape King catalog assembly (TAPEKING_SITE_SCOPE.md §6).
//
// Merges the curated line/SKU model (src/content/brands/<slug>/catalog.yaml)
// with the live Supabase catalog (public.brand_site_products) at build time:
// the yaml owns identity (display names, lines, formats, pack counts, roll
// specs), bronze owns money (price, attribution URL). Per-roll and per-yard
// figures are DERIVED here — never authored, never hardcoded in templates.
//
// Per-yard is comparable within a width only (scope §4) — callers must never
// cross-compare per-yard between widths in UI copy. Savings badges follow the
// same spirit: they are computed within one (line, format) ladder and only
// for tape rungs (roll_yards set), so a $18 gun is never compared to a $50
// two-pack of a different gun.

import { getCollection } from 'astro:content';
import { getAffiliateProducts, getProducts, getReviewStats } from './supabase.js';

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

/** Ladder pack-size label, e.g. `6 rolls`, `Case · 24 rolls`, `Full case · 36 rolls`. */
function packLabel(sku) {
  if (sku.rung_label) return sku.rung_label;
  if (sku.pack_count === 1) return 'Single';
  if (sku.pack_count >= 36) return `Full case · ${sku.pack_count} rolls`;
  if (sku.pack_count >= 24) return `Case · ${sku.pack_count} rolls`;
  return `${sku.pack_count} rolls`;
}

/** Route for a line: its PDP, or the interim v1 ASIN page while pdp: false. */
export function lineHref(line) {
  if (line.pdp !== false) return `/products/${line.slug}/`;
  const rep = line.skus.find((s) => s.asin === line.representative_asin);
  return rep?.live ? `/products/${rep.asin}/` : `https://www.amazon.com/dp/${line.representative_asin}`;
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
 *   names it. amazon_url still resolves (plain /dp/ fallback).
 * - save_pct: per-roll saving vs the smallest priced tape pack in the same
 *   (line, format_key) ladder — tape rungs only, ≥1% only.
 *
 * Each line: yaml fields + { skus, visibleSkus, spec, reviews, formats }
 * - spec: spec_override, else derived from the representative SKU
 * - reviews: { rating, count } — MAX across the line's ASINs (Amazon pools
 *   reviews per listing; summing overcounts), null when stats are missing.
 * - formats: ordered ladder groups for the PDP —
 *   { key, label, note, defaultIndex, rungs: [sku + { pack_label, sub_label,
 *   best_value }] }. Ordered by the line's authored `formats` list (or SKU
 *   encounter order), rungs by pack_count. Hidden or not-live SKUs never
 *   become rungs.
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
      const fmtKeys = new Set(l.formats.map((f) => f.key));
      if (fmtKeys.size !== l.formats.length) problems.push(`line "${l.slug}": duplicate format keys`);
      if (l.formats.length > 0) {
        for (const s of skus.filter((s) => s.line === l.slug)) {
          if (!fmtKeys.has(s.format_key)) problems.push(`${s.asin}: format_key "${s.format_key}" not in line "${l.slug}" formats list`);
        }
      }
      for (const x of l.cross_sell) {
        if (!lineSlugs.has(x)) problems.push(`line "${l.slug}": unknown cross_sell "${x}"`);
      }
      if (l.pdp !== false && l.formats.length === 0) problems.push(`line "${l.slug}": pdp line needs a formats list`);
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
    // priced pack's per-roll figure. Tape rungs only — cross-comparing
    // different physical products (dispenser models) is never a "saving".
    const ladders = new Map();
    for (const s of mergedSkus) {
      const key = `${s.line}/${s.format_key}`;
      if (!ladders.has(key)) ladders.set(key, []);
      ladders.get(key).push(s);
    }
    for (const rungs of ladders.values()) {
      rungs.sort((a, b) => a.pack_count - b.pack_count);
      const base = rungs.find((r) => r.per_roll != null && r.roll_yards != null) ?? null;
      for (const r of rungs) {
        const pct =
          base && r !== base && r.per_roll != null && r.roll_yards != null
            ? Math.round((1 - r.per_roll / base.per_roll) * 100)
            : null;
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

      // Ladder groups: authored format order (else SKU encounter order).
      const fmtDefs = l.formats.length
        ? l.formats
        : [...new Set(lineSkus.map((s) => s.format_key))].map((key) => ({ key }));
      const formats = fmtDefs
        .map((def) => {
          const rungs = lineSkus
            .filter((s) => s.format_key === def.key && !s.hidden && s.live)
            .sort((a, b) => a.pack_count - b.pack_count);
          const bestValue =
            rungs.length > 1
              ? rungs.reduce((best, r) => (r.per_roll != null && (best == null || r.per_roll < best.per_roll) ? r : best), null)
              : null;
          for (const r of rungs) {
            r.pack_label = packLabel(r);
            r.best_value = r === bestValue;
            r.sub_label =
              r.total_yards != null
                ? `${r.total_yards.toLocaleString('en-US')} yards${r.best_value ? ' · best value' : ''}`
                : r.best_value
                  ? 'best value'
                  : null;
          }
          const defaultIndex = Math.max(0, rungs.findIndex((r) => r.asin === def.default_asin));
          return { key: def.key, label: rungs[0]?.format_label ?? def.key, note: def.note ?? null, defaultIndex, rungs };
        })
        .filter((f) => f.rungs.length > 0);

      return {
        ...l,
        skus: lineSkus,
        visibleSkus: lineSkus.filter((s) => !s.hidden && s.live),
        spec: l.spec_override ?? specLine(rep),
        reviews,
        formats,
      };
    });

    return { lines: mergedLines, skus: mergedSkus, skuByAsin };
  })();
  return catalogPromise;
}

/** getTapeCatalog(), or null when this brand has no catalog.yaml. */
export async function getTapeCatalogIfAny() {
  const entries = await getCollection('catalog');
  return entries.some((e) => e.id === `${BRAND_SLUG}/catalog`) ? getTapeCatalog() : null;
}

let affiliatesPromise;

/**
 * Affiliate-brand listings (catalog.yaml `affiliates` merged with the live
 * public.brand_site_affiliate_products rows): yaml owns identity and specs,
 * bronze owns price/attribution. Derived per-roll / per-yard when the yaml
 * carries pack_count / roll_yards. Listings with no live bronze row are
 * dropped with a warning (delisted or missing bronze.brand_site_affiliates
 * mapping) — a listing page must never render without a synced price.
 */
export function getAffiliates() {
  affiliatesPromise ??= (async () => {
    const catalog = await getTapeCatalog();
    void catalog; // ensures catalog.yaml validation ran before affiliates render
    const entries = await getCollection('catalog');
    const entry = entries.find((e) => e.id === `${BRAND_SLUG}/catalog`);
    const authored = entry?.data.affiliates ?? [];
    if (authored.length === 0) return [];

    const live = await getAffiliateProducts();
    const liveByAsin = new Map(live.map((p) => [p.asin, p]));

    const merged = [];
    for (const a of authored) {
      const row = liveByAsin.get(a.asin);
      if (!row || row.item_price == null) {
        console.warn(
          `[tapeking.js] affiliate ${a.asin} ("${a.slug}") has no live row in brand_site_affiliate_products — page skipped.`
        );
        continue;
      }
      const price = row.item_price;
      const per_roll = a.pack_count != null ? round2(price / a.pack_count) : null;
      const total_yards = a.pack_count != null && a.roll_yards != null ? a.pack_count * a.roll_yards : null;
      merged.push({
        ...a,
        price,
        per_roll,
        per_yard: total_yards != null ? price / total_yards : null,
        attribution_url: row.attribution_url ?? null,
        amazon_url: row.amazon_url,
      });
    }
    return merged;
  })();
  return affiliatesPromise;
}
