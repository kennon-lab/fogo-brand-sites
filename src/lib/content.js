// Merges the authored presentation layer (src/content/brands/<slug>/, see
// src/content.config.ts) onto the Supabase catalog at build time. Brands with
// zero authored product entries are "unauthored" and must render exactly as
// v1 — callers gate every v2 surface on isAuthoredBrand().
import { getCollection } from 'astro:content';
import { getProducts, getReviewStats } from './supabase.js';
import { groupByParent } from './catalog.js';

const BRAND_SLUG = import.meta.env.BRAND_SLUG;

// Review aggregates older than this are omitted rather than rendered stale
// (the homepage claim must stay defensible; see plan §D4).
const REVIEW_MAX_AGE_DAYS = 90;

let authoredPromise;
/** Authored product-family entries for this brand: [{ slug, ...yaml data }]. */
export function getAuthoredProducts() {
  authoredPromise ??= getCollection('products').then((entries) =>
    entries
      .filter((e) => e.id.startsWith(`${BRAND_SLUG}/`))
      .map((e) => ({ slug: e.id.split('/').pop(), ...e.data }))
  );
  return authoredPromise;
}

/** True when this brand has at least one authored product family. */
export async function isAuthoredBrand() {
  return (await getAuthoredProducts()).length > 0;
}

let sitePromise;
/** site.yaml data for this brand, or null. */
export function getSiteContent() {
  sitePromise ??= getCollection('site').then(
    (entries) => entries.find((e) => e.id === `${BRAND_SLUG}/site`)?.data ?? null
  );
  return sitePromise;
}

let needsPromise;
/** The brand's controlled needs taxonomy: [{ slug, display, short, intro }]. */
export function getNeeds() {
  needsPromise ??= getCollection('needs').then(
    (entries) => entries.find((e) => e.id === `${BRAND_SLUG}/needs`)?.data.needs ?? []
  );
  return needsPromise;
}

let categoriesPromise;
/** Category collection-page entries: [{ slug, display, intro }]. */
export function getCategories() {
  categoriesPromise ??= getCollection('needs').then(
    (entries) => entries.find((e) => e.id === `${BRAND_SLUG}/needs`)?.data.categories ?? []
  );
  return categoriesPromise;
}

function isStale(asOf) {
  return Date.now() - new Date(asOf).getTime() > REVIEW_MAX_AGE_DAYS * 86400000;
}

let warnedStale = false;
/**
 * Family-level review aggregate. Amazon pools reviews at the listing level —
 * each child ASIN typically reports the family's shared total — so the family
 * figure is the MAX across children, never the sum (summing overcounts ~5x).
 */
function familyReviewStats(children, statsByAsin) {
  let best = null;
  for (const c of children) {
    const s = statsByAsin.get(c.asin);
    if (s?.review_count != null && (best === null || s.review_count > best.review_count)) {
      best = s;
    }
  }
  if (!best) return null;
  if (isStale(best.as_of)) {
    if (!warnedStale) {
      warnedStale = true;
      console.warn(
        `[content.js] review stats are older than ${REVIEW_MAX_AGE_DAYS} days (as_of ${best.as_of}) — omitting review UI rather than rendering stale claims.`
      );
    }
    return null;
  }
  return { rating: best.rating, count: best.review_count, as_of: best.as_of };
}

let mergedPromise;
/**
 * groupByParent() groups extended with the presentation layer:
 *   { key, representative, children, authored, slug, labels, reviews }
 * - authored: the family's yaml data, or null (unauthored family)
 * - slug:     authored family slug (PDP route), or null
 * - labels:   Map<asin, human label> from authored variants
 * - reviews:  { rating, count, as_of } family aggregate, or null
 * Throws on authoring errors (unknown family_key / need slug, duplicate keys)
 * so bad content fails the build loudly instead of shipping.
 */
export function getMergedCatalog() {
  mergedPromise ??= (async () => {
    const [products, authored, needs, stats] = await Promise.all([
      getProducts(),
      getAuthoredProducts(),
      getNeeds(),
      getReviewStats(),
    ]);
    const groups = groupByParent(products);
    const groupKeys = new Set(groups.map((g) => g.key));
    const needSlugs = new Set(needs.map((n) => n.slug));

    const problems = [];
    const seenKeys = new Set();
    for (const a of authored) {
      if (seenKeys.has(a.family_key)) problems.push(`"${a.slug}": duplicate family_key ${a.family_key}`);
      seenKeys.add(a.family_key);
      if (!groupKeys.has(a.family_key)) problems.push(`"${a.slug}": family_key ${a.family_key} not in catalog`);
      for (const n of a.needs) {
        if (!needSlugs.has(n)) problems.push(`"${a.slug}": unknown need "${n}" (define it in needs.yaml)`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`[content.js] invalid authored content:\n  ${problems.join('\n  ')}`);
    }

    const byKey = new Map(authored.map((a) => [a.family_key, a]));

    // Adoption: an authored family's variants may claim an ASIN stranded in
    // its own single-ASIN unauthored group (Amazon variation-family artifact —
    // e.g. the slim King pillow lives outside the flagship family on Amazon
    // but belongs with it on the site). The stranded child moves into the
    // authored group: it joins the price range, review MAX aggregation, and
    // redirect-stub generation, and its orphan group disappears from grids.
    for (const a of authored) {
      const home = groups.find((g) => g.key === a.family_key);
      if (!home) continue;
      for (const v of a.variants) {
        if (home.children.some((c) => c.asin === v.asin)) continue;
        const donorIdx = groups.findIndex(
          (g) => g.key !== a.family_key && !byKey.has(g.key) && g.children.length === 1 && g.children[0].asin === v.asin
        );
        if (donorIdx !== -1) {
          home.children.push(groups[donorIdx].children[0]);
          groups.splice(donorIdx, 1);
        }
      }
    }

    return groups.map((g) => {
      const a = byKey.get(g.key) ?? null;
      const labels = new Map();
      if (a) {
        const childAsins = new Set(g.children.map((c) => c.asin));
        for (const v of a.variants) {
          if (!childAsins.has(v.asin)) {
            console.warn(`[content.js] "${a.slug}": variant ${v.asin} is not in family ${g.key} (delisted or hidden?)`);
          }
          labels.set(v.asin, v.label);
        }
      }
      return { ...g, authored: a, slug: a?.slug ?? null, labels, reviews: familyReviewStats(g.children, stats) };
    });
  })();
  return mergedPromise;
}

/**
 * Brand-level review aggregate for the trust strip: sum of family maxes (never
 * the raw per-ASIN sum), weighted average rating, oldest contributing as_of.
 * Returns null when no fresh stats exist — callers omit the claim.
 */
export async function getBrandReviewAggregate() {
  const merged = await getMergedCatalog();
  const fams = merged.map((g) => g.reviews).filter(Boolean);
  if (fams.length === 0) return null;
  const count = fams.reduce((t, f) => t + f.count, 0);
  const rated = fams.filter((f) => f.rating != null);
  const rating = rated.length
    ? Math.round((rated.reduce((t, f) => t + f.rating * f.count, 0) / rated.reduce((t, f) => t + f.count, 0)) * 10) / 10
    : null;
  const as_of = fams.reduce((min, f) => (f.as_of < min ? f.as_of : min), fams[0].as_of);
  console.log(`[content.js] brand review aggregate: ${count.toLocaleString()} reviews (family-max sum), rating ${rating}, as_of ${as_of}`);
  return { count, rating, as_of };
}
