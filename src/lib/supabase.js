// Build-time-only data layer. Fetches run in Astro frontmatter / config during
// `astro build`; nothing here ever executes in the browser and the anon key is
// never referenced from client scripts.
//
// Known PostgREST quirks handled here (see BRAND_SITES_SCOPE_v1.md §4.3):
// - 1,000-row default cap → every fetch appends &limit=10000
// - numeric columns arrive as strings → parseFloat

const SUPABASE_URL = import.meta.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.SUPABASE_ANON_KEY;
const BRAND_SLUG = import.meta.env.BRAND_SLUG;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !BRAND_SLUG) {
  throw new Error('[supabase.js] SUPABASE_URL, SUPABASE_ANON_KEY and BRAND_SLUG must all be set.');
}

async function rest(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}${sep}limit=10000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`[supabase.js] ${res.status} ${res.statusText} fetching ${pathAndQuery}`);
  }
  return res.json();
}

const num = (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v));

// Module-level caches: Astro builds all pages in one process, so each dataset
// is fetched exactly once per build.
let brandPromise;
let productsPromise;
let affiliatesPromise;
let imagesPromise;
let reviewStatsPromise;

/** The brand row for BRAND_SLUG. Build fails loudly if it doesn't exist. */
export function getBrand() {
  brandPromise ??= rest(`brand_sites?slug=eq.${encodeURIComponent(BRAND_SLUG)}`).then((rows) => {
    if (rows.length === 0) {
      throw new Error(`[supabase.js] BRAND_SLUG "${BRAND_SLUG}" not found in public.brand_sites.`);
    }
    return rows[0];
  });
  return brandPromise;
}

/**
 * All visible products for the brand (hide_from_site rows are already
 * filtered out by the view), prices parsed, bullets normalized to string[].
 */
export function getProducts() {
  productsPromise ??= rest(
    `brand_site_products?brand_slug=eq.${encodeURIComponent(BRAND_SLUG)}&order=sort_weight.desc,asin.asc`
  ).then((rows) => {
    const products = rows.map((p) => ({
      ...p,
      item_price: num(p.item_price),
      bullets: Array.isArray(p.bullets_json)
        ? p.bullets_json.map((b) => (typeof b === 'string' ? b : b?.value)).filter(Boolean)
        : [],
      amazon_url: p.attribution_url || p.plain_amazon_url,
    }));
    // Attribution-miss report: these CTAs earn no Brand Referral Bonus until
    // bronze.attribution_links rows exist for (brand, asin, 'brand_site').
    const missing = products.filter((p) => !p.attribution_url);
    if (missing.length > 0) {
      console.warn(
        `[supabase.js] ${missing.length}/${products.length} ASINs have no attribution link (plain Amazon fallback): ${missing.map((p) => p.asin).join(', ')}`
      );
    }
    return products;
  });
  return productsPromise;
}

/**
 * Affiliate-brand listings for this site (public.brand_site_affiliate_products
 * ← bronze.brand_site_affiliates): items sold under a sibling brand (e.g.
 * Grizzly Power on tapeking.com) that render as standalone listing pages.
 * Price and attribution sync from bronze exactly like the main catalog.
 * Empty array for brands with no affiliate rows.
 */
export function getAffiliateProducts() {
  affiliatesPromise ??= rest(`brand_site_affiliate_products?site_slug=eq.${encodeURIComponent(BRAND_SLUG)}`).then(
    (rows) =>
      rows.map((p) => ({
        ...p,
        item_price: num(p.item_price),
        amazon_url: p.attribution_url || p.plain_amazon_url,
      }))
  );
  return affiliatesPromise;
}

/**
 * Mirrored image URLs by ASIN: Map<asin, string[]> ordered by position.
 * Only the brand-site-images bucket ever appears here (mirror script output).
 * ASINs with no mirrored images are simply absent — callers render text-only.
 */
/**
 * Latest Keepa review stats for this brand's ASINs:
 * Map<asin, { rating, review_count, as_of }>. Fails soft (empty Map + warning)
 * so a broken stats view degrades to "no review UI", never a failed build.
 * Aggregation semantics live in src/lib/content.js — family figures are the
 * MAX across children (Amazon pools reviews per listing), never the sum.
 */
export function getReviewStats() {
  reviewStatsPromise ??= getProducts().then(async (products) => {
    const map = new Map();
    if (products.length === 0) return map;
    try {
      const asins = products.map((p) => p.asin).join(',');
      const rows = await rest(`brand_site_review_stats?asin=in.(${asins})`);
      for (const r of rows) {
        map.set(r.asin, {
          rating: num(r.rating),
          review_count: r.review_count == null ? null : Number(r.review_count),
          as_of: r.as_of,
        });
      }
    } catch (err) {
      console.warn(`[supabase.js] review stats unavailable (${err.message}) — review UI will be omitted.`);
    }
    return map;
  });
  return reviewStatsPromise;
}

export function getImagesByAsin() {
  imagesPromise ??= Promise.all([
    getProducts(),
    getAffiliateProducts(),
    rest('brand_site_images?order=asin.asc,position.asc'),
  ]).then(
    ([products, affiliates, rows]) => {
      const wanted = new Set([...products, ...affiliates].map((p) => p.asin));
      const map = new Map();
      for (const r of rows) {
        if (!wanted.has(r.asin)) continue;
        if (!map.has(r.asin)) map.set(r.asin, []);
        map.get(r.asin).push(r.storage_url);
      }
      return map;
    }
  );
  return imagesPromise;
}
