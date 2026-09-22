// Google Ads campaign generator — one Search campaign per blog post, built
// from the post's search brief (frontmatter) and the brand's own Amazon
// Sponsored Products search-term history. Writes a reviewable campaign spec
// to ads/<brand-slug>/<post-slug>.json; scripts/ads-push.mjs turns a spec
// into live (paused) campaigns through the Google Ads API.
//
// Usage:
//   node scripts/ads-campaigns.mjs --brand=<slug>|all [--post=<slug>] [--days=90]
//                                  [--min-clicks=10] [--out=ads] [--no-mine]
//   npm run ads:campaigns -- --brand=otis-classic
//
// Env (.env): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (the
// search-term RPC public.brand_site_search_terms is service-role only).
//
// Campaign structure (per post):
//   campaign   fbs-{brand-slug}-{post-slug}   Search only, US, English, PAUSED,
//              maximize clicks with a CPC ceiling (stage 1; see `stages`)
//   ad group   guide     the brief's target + secondary keywords (exact + phrase)
//   ad group   product   Amazon search terms that already convert for the post's
//                        ASINs (tier A exact + phrase, tier B exact), relevance-
//                        filtered against the brief's keywords + ads.seeds
//              + every product keyword must contain a product noun (head noun
//              of each ads.seeds phrase, else of the target keyword; override
//              with ads.product_nouns) — keeps "whipping cream" out of a
//              dispenser campaign
//   dedupe     a keyword is dropped when (a) it is live in another campaign in
//              the brand's Google Ads account (an agency's direct-to-Amazon
//              campaign, say) or (b) an earlier post of the same brand already
//              bids on it (pushed specs first, then by post date) — one
//              account never competes with itself. Dropped terms are listed
//              under `excluded` in the spec.
//   policy     keywords with policy-risk terms (N2O, chargers, CBD, …) are
//              never bid on; see lib/ads-spec.mjs
//   negatives  generic list + relevant Amazon terms with clicks and no purchases
//              + ads.negatives; never one that would block one of our keywords
//   RSA        guide: author headlines/descriptions first (ads: block), then
//              copy derived from the brief (keyword, title, summary, FAQ);
//              product: led by the product keywords and the product title.
//              Validated against Google limits/policy; headline 1 pinned.
//   assets     sitelinks (related posts sharing an ASIN family, product page,
//              catalog) + callouts
//   URLs       final = https://www.<domain>/blog/<post>/; suffix carries
//              ValueTrack so the site's paid-landing swap can fill the Amazon
//              Attribution macro tag ({campaignid} {adgroupid} {creative} …)
//
// Naming key (joins Google Ads, GA4, Amazon Attribution and our tables):
//   fbs-{brand-slug}-{post-slug}  — campaign; ad groups "guide" | "product".
import process from 'node:process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listPosts } from './lib/posts.mjs';
import { LIMITS, adText, titleCase, sentenceCase, clauses, sentences, truncateWords, phraseThatFits, dangles, validateAd, keywordIssues } from './lib/ads-copy.mjs';
import { plainText } from './lib/posts.mjs';
import { adsEnv, liveKeywords } from './lib/google-ads.mjs';
import { keywordKey, policyRisk, headNoun, hasProductNoun, negativeConflicts, specHash } from './lib/ads-spec.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name) => process.argv.includes(`--${name}`);
const brandArg = arg('brand') ?? process.env.BRAND_SLUG;
const postArg = arg('post') ?? null;
const DAYS = Number(arg('days') ?? 90);
const MIN_CLICKS = Number(arg('min-clicks') ?? 10);
const OUT_DIR = arg('out') ?? 'ads';
const noMine = flag('no-mine');

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required.');
  process.exit(1);
}
if (!brandArg) {
  console.error('Pass --brand=<slug> or --brand=all.');
  process.exit(1);
}
if (!noMine && !SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required for the search-term miner (or pass --no-mine).');
  process.exit(1);
}

// ---- Tunables ----------------------------------------------------------------
const TIER_A = { purchases: 5, cvr: 0.05 }; // exact + phrase
const TIER_B = { purchases: 2, cvr: 0.03 }; // exact
const NEGATIVE = { clicks: 15, purchases: 0 };
const MAX_PRODUCT_KEYWORDS = 24; // keyword entries (exact + phrase count separately)
const MAX_NEGATIVES = 40;
// Searches with no purchase intent we can serve, or intent already headed
// elsewhere. Deliberately NOT here: diy / homemade / how to make — the posts
// are how-to guides, those searchers are the audience; "amazon" — every CTA
// goes to Amazon, so "… amazon" searchers are ideal; "manual" — people looking
// for instructions are exactly who a how-to post serves.
const GENERIC_NEGATIVES = [
  'free', 'jobs', 'job', 'career', 'careers', 'wholesale', 'alibaba', 'aliexpress', 'walmart', 'ebay',
  'reddit', 'youtube', 'pdf', 'recall', 'lawsuit', 'repair', 'replacement parts', 'coupon', 'promo code',
];
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'how', 'what', 'why', 'when',
  'where', 'which', 'do', 'does', 'is', 'are', 'your', 'my', 'you', 'it', 'its', 'or', 'vs', 'best', 'guide',
  'ideas', 'things', 'make', 'use', 'using', 'besides', 'beyond', 'tips', 'top', 'new',
]);

// ---- Helpers -------------------------------------------------------------------
const stem = (w) => {
  let s = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.length > 4) s = s.replace(/(ing|ers|ies|es|ed|s)$/, '');
  return s;
};
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOPWORDS.has(w)).map(stem).filter(Boolean);
const uniq = (arr) => [...new Set(arr)];
const cleanKeyword = (s) => String(s).toLowerCase().replace(/[^a-z0-9 '&\-]/g, ' ').replace(/\s+/g, ' ').trim();
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function rest(pathAndQuery, init = {}) {
  const key = init.service ? SERVICE_KEY : ANON_KEY;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}${init.method ? '' : `${sep}limit=10000`}`;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- Keyword miner ---------------------------------------------------------------
/**
 * Relevance: a search term is on-topic when it shares >= 60% of some seed
 * phrase's content tokens (stemmed). Seeds = target keyword + secondary
 * keywords + ads.seeds. Keeps "whip cream dispenser" for "whipped cream
 * dispenser", drops "soap dispenser for kitchen sink".
 */
function relevantTo(seeds) {
  const seedSets = seeds.map((s) => uniq(tokens(s))).filter((t) => t.length > 0);
  return (term) => {
    const t = new Set(tokens(term));
    return seedSets.some((seed) => seed.filter((w) => t.has(w)).length / seed.length >= 0.6);
  };
}

async function mineTerms(store, asins, seeds, brandWords, vocabulary) {
  if (noMine) return { rows: [], tierA: [], tierB: [], negatives: [] };
  const rows = await rest('rpc/brand_site_search_terms', {
    method: 'POST',
    service: true,
    body: { p_store: store, p_asins: asins, p_days: DAYS },
  });
  const isRelevant = relevantTo(seeds);
  const isBrand = (term) => brandWords.some((w) => term.includes(w));
  // Every content word of a bid keyword must occur somewhere in the post, its
  // brief or the product titles — that is what keeps competitor brand names
  // ("isi", "grolsch") and off-topic modifiers out of the ad group, and it is
  // also what Google's landing-page relevance rewards.
  const inVocabulary = (term) => tokens(term).every((t) => vocabulary.has(t));
  const scored = rows
    .map((r) => ({
      term: cleanKeyword(r.search_term),
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
      cost: Number(r.cost),
      purchases: Number(r.purchases),
      sales: Number(r.sales),
      cvr: Number(r.clicks) > 0 ? Number(r.purchases) / Number(r.clicks) : 0,
      cpc: Number(r.clicks) > 0 ? Number(r.cost) / Number(r.clicks) : 0,
    }))
    .filter((r) => r.term && keywordIssues(r.term).length === 0 && isRelevant(r.term) && !isBrand(r.term));
  const bidable = scored.filter((r) => inVocabulary(r.term));
  const tierA = bidable.filter((r) => r.clicks >= MIN_CLICKS && r.purchases >= TIER_A.purchases && r.cvr >= TIER_A.cvr);
  const tierB = bidable.filter((r) => r.clicks >= MIN_CLICKS && r.purchases >= TIER_B.purchases && r.cvr >= TIER_B.cvr && !tierA.includes(r));
  const negatives = scored
    .filter((r) => r.clicks >= NEGATIVE.clicks && r.purchases <= NEGATIVE.purchases)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, MAX_NEGATIVES);
  const byValue = (a, b) => b.purchases - a.purchases || b.cvr - a.cvr;
  return { rows: scored, tierA: tierA.sort(byValue), tierB: tierB.sort(byValue), negatives };
}

// ---- Ad copy -----------------------------------------------------------------------
// Candidates are used whole or not at all — no truncation anywhere in ad copy.
function copyCollector() {
  const headlines = [];
  const descriptions = [];
  const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const addH = (h) => {
    const t = adText(h ?? '');
    if (t.length >= 5 && t.length <= LIMITS.headline && !headlines.some((x) => key(x) === key(t))) headlines.push(t);
  };
  const addD = (d) => {
    const t = adText(d ?? '');
    if (t.length <= LIMITS.description && t.length >= 40 && !descriptions.some((x) => key(x) === key(t))) descriptions.push(t);
  };
  return { headlines, descriptions, addH, addD };
}

function buildAd({ post, brand }) {
  const fm = post.fm;
  const ads = fm.ads ?? {};
  const { headlines, descriptions, addH, addD } = copyCollector();

  // 1. Author copy wins and goes first (headline 1 is pinned to position 1).
  for (const h of ads.headlines ?? []) addH(h);
  for (const d of ads.descriptions ?? []) addD(d);

  // 2. Keyword-led headlines. Never a mid-phrase cut: a phrase is used whole
  // or with its lead-in removed, or not at all.
  const kwHead = phraseThatFits(fm.target_keyword, LIMITS.headline);
  if (kwHead) addH(kwHead);
  for (const s of fm.secondary_keywords ?? []) {
    if (policyRisk(s)) continue; // not bid on, so not a headline either
    const h = phraseThatFits(s, LIMITS.headline);
    if (h) addH(h);
  }
  if (fm.title.length <= LIMITS.headline) addH(fm.title);
  for (const c of clauses(fm.title)) if (c.length <= LIMITS.headline && !dangles(c)) addH(titleCase(c));

  // 3. Benefit / answer fragments from the brief and FAQ — only self-contained
  // ones (start with a capital in the source, do not end on a dangling word).
  const selfContained = (c) => /^[A-Z0-9]/.test(c) && c.length <= LIMITS.headline && c.length >= 16 && c.split(' ').length >= 3 && !dangles(c);
  for (const c of clauses(fm.summary ?? '')) if (selfContained(c)) addH(titleCase(c));
  for (const f of fm.faq ?? []) if (f.q.length <= LIMITS.headline) addH(f.q);
  addH(`${brand.brand} Official Guide`);
  addH(`${brand.brand} Guide`);
  addH('Step-by-Step Instructions');
  addH('Read the Full Guide');
  addH('Sold on Amazon');
  addH('Ships From Amazon');

  // Descriptions: whole sentences only (summary, meta description, FAQ answers).
  const sentenceOk = (t) => /^[A-Z0-9]/.test(t) && /[.!?]$/.test(t) && !/^(and|or|but|then|so)\b/i.test(t);
  for (const t of sentences(fm.summary ?? '')) if (sentenceOk(t)) addD(t);
  if (sentenceOk(fm.description)) addD(fm.description);
  for (const t of sentences(fm.description)) if (sentenceOk(t)) addD(t);
  for (const f of fm.faq ?? []) for (const t of sentences(f.a).slice(0, 1)) if (sentenceOk(t)) addD(t);
  addD('Official guide from the brand. Read it, then buy on Amazon with fast shipping and easy returns.');

  const ad = {
    headlines: headlines.slice(0, LIMITS.headlinesMax),
    descriptions: descriptions.slice(0, LIMITS.descriptionsMax),
    pinned: { headline_1: headlines[0] ?? null },
    path1: ads.path1 ?? 'blog',
    path2: ads.path2 ?? (slugify(truncateWords(phraseThatFits(fm.target_keyword, 60) || fm.target_keyword, LIMITS.path)) || undefined),
    callouts: (ads.callouts?.length ? ads.callouts : ['Official Brand Site', 'Sold on Amazon', 'Step-by-Step Guide', 'Prime Shipping']).map(adText).slice(0, LIMITS.calloutsMax),
    sitelinks: [],
  };
  if (ad.path2 && ad.path2.length > LIMITS.path) ad.path2 = ad.path2.slice(0, LIMITS.path).replace(/-+$/, '');
  return ad;
}

/**
 * The product ad group's RSA: shoppers searched a product, so the ad leads
 * with that product (its keywords, then the product title) and falls back on
 * the guide's copy to fill the remaining slots. Headline 1 (pinned) is the
 * top product keyword.
 */
function buildProductAd({ brand, primaryProduct, productKw, productNouns, guideAd }) {
  const { headlines, descriptions, addH, addD } = copyCollector();
  const exact = productKw.filter((k) => k.match === 'EXACT').map((k) => k.text);
  for (const k of exact.slice(0, 6)) addH(phraseThatFits(k, LIMITS.headline));
  addH(`Official ${brand.brand} Site`);
  const brandPrefix = new RegExp(`^${brand.brand.replace(/[^a-z0-9 ]/gi, '')}\\s+`, 'i');
  for (const c of clauses(primaryProduct?.display_title ?? '')) {
    const t = c.replace(brandPrefix, '');
    // Only title fragments that name the product ("Swing Top Glass Bottles,
    // 16 Oz"), not pack details ("Set of 6", "Plastic Caps").
    if (/^[A-Za-z0-9]/.test(t) && t.split(' ').length >= 2 && !dangles(t) && hasProductNoun(t, productNouns)) addH(titleCase(t));
  }
  addH('Sold on Amazon');
  addH('Ships From Amazon');
  for (const h of guideAd.headlines.slice(1)) addH(h);

  const product = exact[0] ?? '';
  addD(`${brand.brand} ${product} from the official brand site. Order on Amazon with Prime shipping.`);
  addD(`${brand.brand} ${product}. Order on Amazon with Prime shipping.`);
  addD(`Compare sizes and styles, read the ${brand.brand} guide, then order on Amazon.`);
  for (const d of guideAd.descriptions) addD(d);

  return {
    ...guideAd,
    headlines: headlines.slice(0, LIMITS.headlinesMax),
    descriptions: descriptions.slice(0, LIMITS.descriptionsMax),
    pinned: { headline_1: headlines[0] ?? null },
  };
}

function sitelinksFor({ siblings, brand, primaryProduct, pdpHref }) {
  const links = [];
  for (const s of siblings.slice(0, 4)) {
    const text = s.fm.ads?.sitelink ?? phraseThatFits(s.fm.target_keyword, LIMITS.sitelinkText) ?? '';
    if (!text) continue; // no honest label fits — the author sets ads.sitelink
    const lines = clauses(s.fm.description).map((c) => sentenceCase(truncateWords(c, LIMITS.sitelinkLine))).filter((c) => c.length >= 10);
    links.push({ text, url: `https://www.${brand.domain}/blog/${s.slug}/`, line1: lines[0] ?? null, line2: lines[1] ?? null });
  }
  if (primaryProduct) {
    const productLine = truncateWords(primaryProduct.display_title, LIMITS.sitelinkLine);
    links.push({ text: 'See the Product', url: `https://www.${brand.domain}${pdpHref}`, line1: productLine || null, line2: productLine ? 'Sold and shipped by Amazon' : null });
  }
  links.push({ text: 'All Products', url: `https://www.${brand.domain}/products/`, line1: truncateWords(`The full ${brand.brand} catalog`, LIMITS.sitelinkLine), line2: 'Every item links to Amazon' });
  return links.slice(0, LIMITS.sitelinksMax).map((l) => ({ ...l, text: adText(l.text), line1: l.line1 && adText(l.line1), line2: l.line2 && adText(l.line2) })).map((l) => (l.line1 && l.line2 ? l : { text: l.text, url: l.url, line1: null, line2: null }));
}

// ---- Main ----------------------------------------------------------------------------
const brandRows = await rest(
  brandArg === 'all'
    ? 'brand_sites?is_live=eq.true&select=slug,brand,domain,store,google_ads_customer_id&order=slug.asc'
    : `brand_sites?slug=eq.${encodeURIComponent(brandArg)}&select=slug,brand,domain,store,google_ads_customer_id`
);
if (brandRows.length === 0) {
  console.error(`No brand_sites row for "${brandArg}".`);
  process.exit(1);
}

let written = 0;
let problems = 0;
for (const brand of brandRows) {
  // Every published post feeds sibling sitelinks; --post only limits which specs are written.
  const allPosts = listPosts({ brand: brand.slug }).filter((p) => p.fm);
  const posts = allPosts.filter((p) => !postArg || p.slug === postArg);
  if (posts.length === 0) {
    console.log(`\n== ${brand.brand}: no published posts — nothing to generate.`);
    continue;
  }
  console.log(`\n== ${brand.brand} (${brand.slug}) — ${posts.length} post(s), store "${brand.store}"`);
  const products = await rest(`brand_site_products?brand_slug=eq.${encodeURIComponent(brand.slug)}&select=asin,parent_asin,display_title,item_price`);
  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const familyOf = (asin) => {
    const p = byAsin.get(asin);
    if (!p) return [asin];
    const key = p.parent_asin && !['#N/A', 'N/A', ''].includes(p.parent_asin) ? p.parent_asin : p.asin;
    return products.filter((x) => (x.parent_asin && !['#N/A', 'N/A', ''].includes(x.parent_asin) ? x.parent_asin : x.asin) === key).map((x) => x.asin);
  };
  const brandWords = brand.brand.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

  // Keywords already live elsewhere in the brand's Google Ads account (an
  // agency's campaigns, other brand-site campaigns). Bidding on the same query
  // twice in one account only splits the auction against ourselves.
  let accountKeywords = null;
  const customerId = brand.google_ads_customer_id;
  if (customerId && adsEnv().missing.length === 0) {
    try {
      accountKeywords = await liveKeywords(customerId);
    } catch (err) {
      console.warn(`  warning: could not read live keywords from Google Ads (${String(err.message).split('\n')[0]}) — account overlap not checked; ads:review will.`);
    }
  } else {
    console.warn(`  warning: ${customerId ? 'GOOGLE_ADS_* credentials missing' : 'no google_ads_customer_id'} — account overlap not checked; ads:review will.`);
  }

  // Pass 1: candidates for every post (all posts, so --post still dedupes
  // against its siblings).
  const drafts = [];
  for (const post of allPosts) {
    const fm = post.fm;
    if (!fm.target_keyword) {
      if (posts.includes(post)) {
        console.error(`  ${post.slug}: no target_keyword — run npm run check:blog.`);
        problems++;
      }
      continue;
    }
    const ads = fm.ads ?? {};
    const asins = uniq((fm.related_asins ?? []).flatMap(familyOf));
    const primaryAsin = fm.primary_asin ?? fm.related_asins?.[0] ?? null;
    const primaryProduct = primaryAsin ? byAsin.get(primaryAsin) ?? null : null;
    const seeds = uniq([fm.target_keyword, ...(fm.secondary_keywords ?? []), ...(ads.seeds ?? [])].map(cleanKeyword));
    const vocabulary = new Set(
      tokens(
        [
          fm.title, fm.description, fm.summary ?? '', plainText(post.body), ...seeds,
          ...(fm.faq ?? []).map((f) => `${f.q} ${f.a}`),
          ...asins.map((a) => byAsin.get(a)?.display_title ?? ''),
        ].join(' ')
      )
    );
    const productNouns = uniq(
      (ads.product_nouns?.length ? ads.product_nouns : ads.seeds?.length ? ads.seeds : [fm.target_keyword]).map((p) => headNoun(p)).filter(Boolean)
    );
    const mined = await mineTerms(brand.store, asins, seeds, brandWords, vocabulary);

    // Brief keywords are the "guide" ad group; seeds + mined winners the
    // "product" ad group. Anything the brief already names is not duplicated.
    const excluded = [];
    const exclude = (e) => excluded.some((x) => x.text === e.text && x.group === e.group) || excluded.push(e);
    const usable = (k, group) => {
      const risk = policyRisk(k);
      if (risk) exclude({ text: k, group, reason: `policy-risk term "${risk}"` });
      else if (group === 'product' && !hasProductNoun(k, productNouns)) exclude({ text: k, group, reason: `no product noun (${productNouns.join(', ')})` });
      return !risk && (group !== 'product' || hasProductNoun(k, productNouns));
    };
    const guideKw = uniq([fm.target_keyword, ...(fm.secondary_keywords ?? [])].map(cleanKeyword)).filter((k) => keywordIssues(k).length === 0 && usable(k, 'guide'));
    const seedKw = uniq((ads.seeds ?? []).map(cleanKeyword)).filter((k) => keywordIssues(k).length === 0 && !guideKw.includes(k) && usable(k, 'product'));
    const productCandidates = [
      ...seedKw.map((k) => ({ text: k, tier: 'seed', source: 'brief-seed' })),
      ...mined.tierA.filter((r) => usable(r.term, 'product')).map((r) => ({ text: r.term, tier: 'A', source: 'amazon-tier-a', purchases: r.purchases, cvr: +r.cvr.toFixed(3) })),
      ...mined.tierB.filter((r) => usable(r.term, 'product')).map((r) => ({ text: r.term, tier: 'B', source: 'amazon-tier-b', purchases: r.purchases, cvr: +r.cvr.toFixed(3) })),
    ];

    const dir = join(OUT_DIR, brand.slug);
    const file = join(dir, `${post.slug}.json`);
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    drafts.push({ post, fm, ads, asins, primaryAsin, primaryProduct, productNouns, mined, guideKw, productCandidates, excluded, exclude, file, dir, prev });
  }

  // Pass 2: a keyword belongs to one post. Pushed campaigns keep theirs; then
  // older posts win; ties by slug.
  drafts.sort((a, b) => Number(Boolean(b.prev?.google?.campaign)) - Number(Boolean(a.prev?.google?.campaign)) || String(a.fm.date).localeCompare(String(b.fm.date)) || a.post.slug.localeCompare(b.post.slug));
  const claimed = new Map(); // keywordKey → post slug
  for (const d of drafts) {
    const campaignName = `fbs-${brand.slug}-${d.post.slug}`;
    const liveElsewhere = new Map(
      (accountKeywords ?? []).filter((k) => k.campaign !== campaignName).map((k) => [keywordKey(k.text), k.campaign])
    );
    const mine = new Set();
    const free = (text, group) => {
      const key = keywordKey(text);
      if (mine.has(key)) return false; // same query already in this campaign (seed + mined term)
      if (liveElsewhere.has(key)) {
        d.exclude({ text, group, reason: `live in campaign "${liveElsewhere.get(key)}"` });
        return false;
      }
      if (claimed.has(key) && claimed.get(key) !== d.post.slug) {
        d.exclude({ text, group, reason: `already bid on by post "${claimed.get(key)}"` });
        return false;
      }
      claimed.set(key, d.post.slug);
      mine.add(key);
      return true;
    };
    // Phrase match only for terms specific enough to stay on topic (3+ words);
    // one- and two-word terms ("cat scratch", "glass bottles") run exact-only.
    const withPhrase = (k) => k.split(' ').length >= 3;
    const pair = (text, extra = {}) => (withPhrase(text) ? [{ text, match: 'EXACT', ...extra }, { text, match: 'PHRASE', ...extra }] : [{ text, match: 'EXACT', ...extra }]);
    d.guide = d.guideKw.filter((k) => free(k, 'guide')).flatMap((k) => pair(k, { source: 'brief' }));
    d.productKw = [];
    for (const c of d.productCandidates) {
      if (!free(c.text, 'product')) continue;
      const { tier, text, ...extra } = c;
      if (tier === 'B') {
        if (d.productKw.length < MAX_PRODUCT_KEYWORDS) d.productKw.push({ text, match: 'EXACT', ...extra });
      } else d.productKw.push(...pair(text, extra));
    }
  }

  // Pass 3: negatives, ads, spec — written for the requested posts only.
  for (const d of drafts) {
    if (!posts.includes(d.post)) continue;
    const { post, fm, ads, asins, primaryAsin, primaryProduct, mined, guide, productKw, excluded, file, dir, prev } = d;
    if (guide.length === 0) {
      console.error(`  ${post.slug}: every guide keyword was excluded (${excluded.filter((e) => e.group === 'guide').map((e) => `${e.text}: ${e.reason}`).join('; ')}) — revise the brief.`);
      problems++;
      continue;
    }
    const keywords = [...guide, ...productKw];
    const negativeTexts = uniq([
      ...GENERIC_NEGATIVES,
      ...mined.negatives.map((r) => r.term),
      ...(ads.negatives ?? []).map(cleanKeyword),
    ]).filter((n) => n && keywordIssues(n).length === 0);
    const negatives = negativeTexts
      .map((text) => ({ text, match: 'PHRASE' }))
      .filter((n) => negativeConflicts([n], keywords).length === 0);

    // Ad + assets.
    const ad = buildAd({ post, brand });
    const siblingFamilies = new Set(asins);
    const related = allPosts.filter((p) => p.slug !== post.slug && (p.fm.related_asins ?? []).flatMap(familyOf).some((a) => siblingFamilies.has(a)));
    const pdpHref = primaryProduct ? `/products/${primaryProduct.asin}/` : null;
    ad.sitelinks = sitelinksFor({ siblings: related, brand, primaryProduct, pdpHref });
    const productAd = productKw.length > 0 ? buildProductAd({ brand, primaryProduct, productKw, productNouns: d.productNouns, guideAd: ad }) : null;
    const copyProblems = [...validateAd(ad), ...(productAd ? validateAd(productAd).map((c) => ({ ...c, where: `product ${c.where}` })) : [])];
    if (copyProblems.length > 0) {
      console.error(`  ${post.slug}: ad copy problems:`);
      for (const c of copyProblems) console.error(`    ${c.where} "${c.text}": ${c.issues.join(', ')}`);
      problems++;
      continue;
    }

    const campaignName = `fbs-${brand.slug}-${post.slug}`;
    const finalUrl = `https://www.${brand.domain}/blog/${post.slug}/`;
    const spec = {
      version: 1,
      generated: localDate(),
      brand: { slug: brand.slug, name: brand.brand, domain: brand.domain, store: brand.store },
      google: { customer_id: brand.google_ads_customer_id ?? null, campaign: null, ad_groups: {}, pushed: null },
      source: { post: post.path, target_keyword: fm.target_keyword, search_intent: fm.search_intent ?? 'informational', asins, primary_asin: primaryAsin, days: DAYS, min_clicks: MIN_CLICKS },
      campaign: {
        name: campaignName,
        status: 'PAUSED', // a human flips it live after reviewing the spec
        channel: 'SEARCH',
        networks: { google_search: true, search_partners: false, display: false },
        geo: [{ id: 2840, name: 'United States' }],
        languages: [{ id: 1000, name: 'English' }],
        budget_daily_usd: ads.budget_daily ?? 10,
        bidding: { stage: 'maximize_clicks', cpc_ceiling_usd: ads.max_cpc ?? 1.5 },
        // Planned progression (applied with ads-push.mjs --stage=…):
        stages: [
          { stage: 'maximize_clicks', when: 'launch', note: 'CPC ceiling; gathers click data for 2 weeks' },
          { stage: 'maximize_conversions', when: '>= 30 amazon_click conversions in 30 days', note: 'GA4 amazon_click imported as a conversion' },
          { stage: 'target_roas', when: 'Attribution purchase upload live and >= 15 purchases in 30 days', note: 'value = attributed Amazon sales' },
        ],
        final_url_suffix:
          'utm_source=google&utm_medium=cpc&utm_campaign={_campaign}&utm_content={adgroupid}&utm_term={keyword}&campaignid={campaignid}&adgroupid={adgroupid}&creative={creative}&keyword={keyword}&matchtype={matchtype}&targetid={targetid}&device={device}&network={network}',
        custom_parameters: { campaign: campaignName },
        negatives,
      },
      ad_groups: [
        { name: 'guide', keywords: guide, ad: { ...ad, final_url: finalUrl } },
        ...(productAd ? [{ name: 'product', keywords: productKw, ad: { ...productAd, final_url: finalUrl } }] : []),
      ],
      excluded,
      mined: {
        relevant_terms: mined.rows.length,
        tier_a: mined.tierA.map((r) => ({ term: r.term, clicks: r.clicks, purchases: r.purchases, cvr: +r.cvr.toFixed(3), cpc: +r.cpc.toFixed(2) })),
        tier_b: mined.tierB.map((r) => ({ term: r.term, clicks: r.clicks, purchases: r.purchases, cvr: +r.cvr.toFixed(3), cpc: +r.cpc.toFixed(2) })),
        negatives: mined.negatives.map((r) => ({ term: r.term, clicks: r.clicks, cost: +r.cost.toFixed(2) })),
      },
    };

    mkdirSync(dir, { recursive: true });
    // A pushed spec keeps its Google resource names and live status/bidding
    // (ads-push.mjs owns those) so a regenerate never orphans the campaign; a
    // review survives only if the reviewed content is unchanged.
    if (prev?.google?.campaign) {
      spec.google = { ...prev.google, customer_id: prev.google.customer_id ?? spec.google.customer_id };
      spec.campaign.status = prev.campaign?.status ?? spec.campaign.status;
      spec.campaign.bidding = prev.campaign?.bidding ?? spec.campaign.bidding;
    }
    if (prev?.review && prev.review.hash === specHash(spec)) spec.review = prev.review;
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    written++;
    console.log(
      `  ${post.slug}\n    campaign ${campaignName}\n    guide ${guide.length} keyword(s), product ${productKw.length} keyword(s) from ${mined.rows.length} relevant Amazon term(s), ${negatives.length} negative(s), ${excluded.length} excluded\n    ${ad.headlines.length} headlines, ${ad.descriptions.length} descriptions, ${ad.sitelinks.length} sitelinks → ${file}`
    );
    for (const e of excluded) console.log(`      excluded ${e.group} "${e.text}": ${e.reason}`);
  }
}

console.log(`\n${written} spec(s) written, ${problems} problem(s).`);
process.exit(problems > 0 ? 2 : 0);
