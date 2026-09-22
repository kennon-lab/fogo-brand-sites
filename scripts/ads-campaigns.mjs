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
//   negatives  generic list + relevant Amazon terms with clicks and no purchases
//              + ads.negatives; never a term that is also a keyword
//   RSA        author headlines/descriptions first (ads: block), then copy
//              derived from the brief (keyword, title, summary, FAQ), validated
//              against Google limits/policy; headline 1 pinned to the keyword
//   assets     sitelinks (sibling posts, product page, catalog) + callouts
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
// are how-to guides, those searchers are the audience.
const GENERIC_NEGATIVES = [
  'free', 'jobs', 'job', 'career', 'careers', 'wholesale', 'alibaba', 'aliexpress', 'walmart', 'ebay', 'amazon',
  'reddit', 'youtube', 'pdf', 'manual', 'recall', 'lawsuit', 'repair', 'replacement parts', 'coupon', 'promo code',
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
function buildAd({ post, brand, primaryProduct }) {
  const fm = post.fm;
  const ads = fm.ads ?? {};
  const kw = titleCase(fm.target_keyword);
  const headlines = [];
  const descriptions = [];
  // Candidates are used whole or not at all — no truncation anywhere in ad copy.
  const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const addH = (h) => {
    const t = adText(h);
    if (t.length >= 5 && t.length <= LIMITS.headline && !headlines.some((x) => key(x) === key(t))) headlines.push(t);
  };
  const addD = (d) => {
    const t = adText(d);
    if (t.length <= LIMITS.description && t.length >= 40 && !descriptions.some((x) => key(x) === key(t))) descriptions.push(t);
  };

  // 1. Author copy wins and goes first (headline 1 is pinned to position 1).
  for (const h of ads.headlines ?? []) addH(h);
  for (const d of ads.descriptions ?? []) addD(d);

  // 2. Keyword-led headlines. Never a mid-phrase cut: a phrase is used whole
  // or with its lead-in removed, or not at all.
  const kwHead = phraseThatFits(fm.target_keyword, LIMITS.headline);
  if (kwHead) addH(kwHead);
  for (const s of fm.secondary_keywords ?? []) {
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

function sitelinksFor({ post, siblings, brand, primaryProduct, pdpHref }) {
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

  for (const post of posts) {
    const fm = post.fm;
    if (!fm.target_keyword) {
      console.error(`  ${post.slug}: no target_keyword — run npm run check:blog.`);
      problems++;
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

    const mined = await mineTerms(brand.store, asins, seeds, brandWords, vocabulary);

    // Keywords. Brief keywords are the "guide" ad group; mined winners the
    // "product" ad group. Anything the brief already names is not duplicated.
    const guideKw = uniq([fm.target_keyword, ...(fm.secondary_keywords ?? [])].map(cleanKeyword)).filter((k) => keywordIssues(k).length === 0);
    const seedKw = uniq((ads.seeds ?? []).map(cleanKeyword)).filter((k) => keywordIssues(k).length === 0 && !guideKw.includes(k));
    // Phrase match only for terms specific enough to stay on topic (3+ words);
    // one- and two-word terms ("cat scratch", "glass bottles") run exact-only.
    const withPhrase = (k) => k.split(' ').length >= 3;
    const pair = (text, extra = {}) => (withPhrase(text) ? [{ text, match: 'EXACT', ...extra }, { text, match: 'PHRASE', ...extra }] : [{ text, match: 'EXACT', ...extra }]);
    const guide = guideKw.flatMap((k) => pair(k, { source: 'brief' }));
    const taken = new Set(guideKw);
    const productKw = [];
    for (const k of seedKw) {
      productKw.push(...pair(k, { source: 'brief-seed' }));
      taken.add(k);
    }
    for (const r of mined.tierA) if (!taken.has(r.term)) productKw.push(...pair(r.term, { source: 'amazon-tier-a', purchases: r.purchases, cvr: +r.cvr.toFixed(3) }));
    for (const r of mined.tierB) if (!taken.has(r.term) && productKw.length < MAX_PRODUCT_KEYWORDS) productKw.push({ text: r.term, match: 'EXACT', source: 'amazon-tier-b', purchases: r.purchases, cvr: +r.cvr.toFixed(3) });
    const keywordTexts = new Set([...guide, ...productKw].map((k) => k.text));

    const negatives = uniq([
      ...GENERIC_NEGATIVES,
      ...mined.negatives.map((r) => r.term),
      ...(ads.negatives ?? []).map(cleanKeyword),
    ]).filter((n) => n && !keywordTexts.has(n) && keywordIssues(n).length === 0);

    // Ad + assets.
    const ad = buildAd({ post, brand, primaryProduct });
    const siblings = allPosts.filter((p) => p.slug !== post.slug);
    const pdpHref = primaryProduct ? `/products/${primaryProduct.asin}/` : null;
    ad.sitelinks = sitelinksFor({ post, siblings, brand, primaryProduct, pdpHref });
    const copyProblems = validateAd(ad);
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
      source: { post: post.path, target_keyword: fm.target_keyword, search_intent: fm.search_intent ?? 'informational', asins, days: DAYS, min_clicks: MIN_CLICKS },
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
        negatives: negatives.map((text) => ({ text, match: 'PHRASE' })),
      },
      ad_groups: [
        { name: 'guide', keywords: guide, ad: { ...ad, final_url: finalUrl } },
        ...(productKw.length > 0 ? [{ name: 'product', keywords: productKw, ad: { ...ad, final_url: finalUrl } }] : []),
      ],
      mined: {
        relevant_terms: mined.rows.length,
        tier_a: mined.tierA.map((r) => ({ term: r.term, clicks: r.clicks, purchases: r.purchases, cvr: +r.cvr.toFixed(3), cpc: +r.cpc.toFixed(2) })),
        tier_b: mined.tierB.map((r) => ({ term: r.term, clicks: r.clicks, purchases: r.purchases, cvr: +r.cvr.toFixed(3), cpc: +r.cpc.toFixed(2) })),
        negatives: mined.negatives.map((r) => ({ term: r.term, clicks: r.clicks, cost: +r.cost.toFixed(2) })),
      },
    };

    const dir = join(OUT_DIR, brand.slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${post.slug}.json`);
    // A pushed spec keeps its Google resource names and live status/bidding
    // (ads-push.mjs owns those) so a regenerate never orphans the campaign.
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (prev?.google?.campaign) {
      spec.google = { ...prev.google, customer_id: prev.google.customer_id ?? spec.google.customer_id };
      spec.campaign.status = prev.campaign?.status ?? spec.campaign.status;
      spec.campaign.bidding = prev.campaign?.bidding ?? spec.campaign.bidding;
    }
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    written++;
    console.log(
      `  ${post.slug}\n    campaign ${campaignName}\n    guide ${guide.length} keyword(s), product ${productKw.length} keyword(s) from ${mined.rows.length} relevant Amazon term(s), ${negatives.length} negative(s)\n    ${ad.headlines.length} headlines, ${ad.descriptions.length} descriptions, ${ad.sitelinks.length} sitelinks → ${file}`
    );
  }
}

console.log(`\n${written} spec(s) written, ${problems} problem(s).`);
process.exit(problems > 0 ? 2 : 0);
