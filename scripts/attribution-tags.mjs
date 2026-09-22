// Creates Amazon Attribution tags (Brand Referral Bonus links) for a brand
// site's catalog through the Amazon Ads API and records them in
// bronze.attribution_links, one row per (brand, asin, channel).
//
// Usage:
//   node scripts/attribution-tags.mjs --brand=<slug>|all --channel=brand_site|google_ads
//                                      [--dry-run] [--probe] [--force]
//                                      [--advertiser=<id>] [--publisher=<id>]
//   npm run attribution-tags -- --brand=otis-classic --channel=brand_site --dry-run
//
// Env (.env): SUPABASE_URL, SUPABASE_ANON_KEY (catalog reads),
//             SUPABASE_SERVICE_ROLE_KEY (reads public.ads_api_accounts, writes
//             bronze.attribution_links). Never printed, never committed.
//
// Channels:
//   brand_site  Organic site traffic. One NON-macro tag per ASIN with our own
//               identifiers, so the Attribution console and our table share one
//               naming convention (below). brand_site_products.attribution_url
//               picks these up on the next build — every CTA then earns BRB.
//   google_ads  One advertiser-level MACRO tag (Google Ads publisher) applied
//               to every ASIN. It carries ValueTrack placeholders that the
//               site fills client-side on paid landings (Base.astro), so the
//               Attribution report splits by Google campaign / ad group /
//               creative with no per-post tag sprawl.
//
// Naming convention (the one key every report joins on):
//   campaign   fbs-{brand-slug}-{channel with - for _}   e.g. fbs-otis-classic-brand-site
//   ad group   site                                        (organic; Google Ads gets Google's own IDs)
//   creative   {asin}
// bronze.attribution_links.campaign_name stores "campaign/adgroup/creative".
//
// Idempotent: ASINs that already have an active row for the channel are
// skipped (a tag is stable; re-creating it just clutters the console). --force
// re-creates and overwrites. --probe lists the advertisers and publishers the
// profile exposes and exits — run it first for a new store so the
// advertiser/publisher picks (name heuristics + overrides) are verified.
//
// Ads API auth mirrors the dashboard's ads-sync Edge Function: per-store LWA
// refresh token → access token; ClientId + Scope (profile) headers.
import process from 'node:process';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADS_BASE = process.env.ADS_API_BASE ?? 'https://advertising-api.amazon.com';
const LWA_TOKEN_URL = process.env.LWA_TOKEN_URL ?? 'https://api.amazon.com/auth/o2/token';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name) => process.argv.includes(`--${name}`);
const brandArg = arg('brand') ?? process.env.BRAND_SLUG;
const channel = arg('channel') ?? 'brand_site';
const dryRun = flag('dry-run');
const probe = flag('probe');
const force = flag('force');
const advertiserOverride = arg('advertiser');
const publisherOverride = arg('publisher');

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!brandArg) {
  console.error('Pass --brand=<slug> or --brand=all.');
  process.exit(1);
}
if (!['brand_site', 'google_ads'].includes(channel)) {
  console.error(`Unknown --channel=${channel} (brand_site | google_ads).`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Supabase (PostgREST) ---------------------------------------------------
async function rest(pathAndQuery, init = {}) {
  const key = init.service ? SERVICE_KEY : ANON_KEY;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}${init.method ? '' : `${sep}limit=10000`}`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(init.schema ? { 'Accept-Profile': init.schema, 'Content-Profile': init.schema } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { method: init.method ?? 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- Amazon Ads API ---------------------------------------------------------
const tokenCache = new Map();
async function accessToken(acct) {
  if (tokenCache.has(acct.store)) return tokenCache.get(acct.store);
  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: acct.refresh_token,
      client_id: acct.client_id,
      client_secret: acct.client_secret,
    }),
  });
  if (!res.ok) throw new Error(`LWA token refresh ${res.status} for ${acct.store}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  tokenCache.set(acct.store, j.access_token);
  return j.access_token;
}

async function adsFetch(acct, path, init = {}, attempt = 1) {
  const token = await accessToken(acct);
  const res = await fetch(`${ADS_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': acct.client_id,
      'Amazon-Advertising-API-Scope': acct.profile_id,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  // Attribution endpoints throttle aggressively — back off and retry.
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 1000 * 2 ** attempt;
    console.warn(`  ${path} → ${res.status}; retrying in ${wait} ms (${attempt}/5)`);
    await sleep(wait);
    return adsFetch(acct, path, init, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// Response shapes differ slightly between the macro / non-macro tag endpoints
// and have shifted across API versions; find the tag string wherever it is.
function findTag(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string') return /maas=|^https?:\/\//i.test(obj) ? obj : null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const t = findTag(v);
      if (t) return t;
    }
    return null;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (/tag$/i.test(k) && typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(obj)) {
    const t = findTag(v);
    if (t) return t;
  }
  return null;
}

// A tag is either a full landing URL or a query fragment to append to one.
function attributionUrl(asin, tag) {
  if (/^https?:\/\//i.test(tag)) return tag.replace(/\{asin\}|ASIN_PLACEHOLDER/gi, asin);
  const q = tag.replace(/^[?&]/, '');
  return `https://www.amazon.com/dp/${asin}?${q}`;
}

const pickByName = (items, re, label, override) => {
  if (override) {
    const hit = items.find((i) => String(i.id) === String(override));
    if (!hit) throw new Error(`--${label}=${override} not found in this profile's ${label}s.`);
    return hit;
  }
  const hits = items.filter((i) => re.test(i.name ?? ''));
  if (hits.length === 1) return hits[0];
  const list = items.map((i) => `${i.id}: ${i.name}`).join('\n    ');
  throw new Error(
    `${hits.length === 0 ? 'No' : 'Several'} ${label}s match ${re} — pass --${label}=<id>. Available:\n    ${list}`
  );
};

const CAMPAIGN_ID = (slug) => `fbs-${slug}-${channel.replace(/_/g, '-')}`;
const AD_GROUP_ID = 'site';

// ---- Main -------------------------------------------------------------------
const brandRows = await rest(
  brandArg === 'all'
    ? 'brand_sites?is_live=eq.true&select=slug,brand,store&order=slug.asc'
    : `brand_sites?slug=eq.${encodeURIComponent(brandArg)}&select=slug,brand,store`
);
if (brandRows.length === 0) {
  console.error(`No brand_sites row for "${brandArg}".`);
  process.exit(1);
}

const totals = { created: 0, skipped: 0, failed: 0 };
for (const brand of brandRows) {
  console.log(`\n== ${brand.brand} (${brand.slug}) — store "${brand.store}", channel ${channel}${dryRun ? ' [dry run]' : ''}`);

  const accounts = await rest(
    `ads_api_accounts?store=eq.${encodeURIComponent(brand.store)}&approval_status=eq.connected&is_active=eq.true&select=store,profile_id,client_id,client_secret,refresh_token`,
    { service: true }
  );
  const acct = accounts[0];
  if (!acct || !acct.profile_id || !acct.client_id || !acct.client_secret || !acct.refresh_token) {
    console.error(`  no connected Ads API account for store "${brand.store}" — skipped.`);
    totals.failed++;
    continue;
  }

  // Advertisers (one per brand under the profile) and publishers (channels).
  const adv = await adsFetch(acct, '/attribution/advertisers');
  const advertisers = (adv?.advertisers ?? adv ?? []).map((a) => ({ id: a.advertiserId ?? a.id, name: a.advertiserName ?? a.name }));
  const pub = await adsFetch(acct, '/attribution/publishers');
  const publishers = (pub?.publishers ?? pub ?? []).map((p) => ({ id: p.id ?? p.publisherId, name: p.name ?? p.publisherName, macroEnabled: p.macroEnabled }));

  if (probe) {
    console.log('  advertisers:');
    for (const a of advertisers) console.log(`    ${a.id}: ${a.name}`);
    console.log('  publishers:');
    for (const p of publishers) console.log(`    ${p.id}: ${p.name}${p.macroEnabled ? ' (macro)' : ''}`);
    continue;
  }

  let advertiser;
  let publisher;
  try {
    const brandWords = brand.brand.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const brandRe = new RegExp(brandWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i');
    advertiser = pickByName(advertisers, brandRe, 'advertiser', advertiserOverride);
    publisher =
      channel === 'google_ads'
        ? pickByName(publishers.filter((p) => p.macroEnabled !== false), /google/i, 'publisher', publisherOverride)
        : pickByName(publishers, /^(other|custom|website|direct)/i, 'publisher', publisherOverride);
  } catch (e) {
    console.error(`  ${e.message}`);
    totals.failed++;
    continue;
  }
  console.log(`  advertiser ${advertiser.id} "${advertiser.name}", publisher ${publisher.id} "${publisher.name}"`);

  const products = await rest(`brand_site_products?brand_slug=eq.${encodeURIComponent(brand.slug)}&select=asin,display_title&order=asin.asc`);
  const existing = await rest(
    `attribution_links?brand=eq.${encodeURIComponent(brand.brand)}&channel=eq.${channel}&is_active=eq.true&select=asin`,
    { service: true, schema: 'bronze' }
  );
  const have = new Set(existing.map((r) => r.asin));
  const todo = force ? products : products.filter((p) => !have.has(p.asin));
  console.log(`  ${products.length} ASIN(s) in catalog, ${have.size} already tagged, ${todo.length} to create.`);
  if (todo.length === 0) continue;

  // google_ads: one macro tag for the advertiser, reused for every ASIN.
  let macroTag = null;
  if (channel === 'google_ads') {
    if (dryRun) {
      macroTag = '?maas=maas_adg_api_DRYRUN&ref_=aa_maas&tag=maas&aa_campaignid={campaignid}&aa_adgroupid={adgroupid}&aa_creativeid={creative}';
    } else {
      const res = await adsFetch(acct, '/attribution/tags/macroTag', {
        method: 'POST',
        body: JSON.stringify({ publisherIds: [String(publisher.id)], advertiserIds: [String(advertiser.id)] }),
      });
      macroTag = findTag(res);
      if (!macroTag) {
        console.error(`  macroTag response had no tag: ${JSON.stringify(res).slice(0, 500)}`);
        totals.failed++;
        continue;
      }
    }
  }

  const rows = [];
  for (const p of todo) {
    const campaignName = `${CAMPAIGN_ID(brand.slug)}/${AD_GROUP_ID}/${p.asin}`;
    let tag = macroTag;
    if (channel === 'brand_site') {
      if (dryRun) {
        tag = `?maas=maas_adg_api_DRYRUN_static_${p.asin}&ref_=aa_maas&tag=maas`;
      } else {
        try {
          const res = await adsFetch(acct, '/attribution/tags/nonMacroTag', {
            method: 'POST',
            body: JSON.stringify({
              publisherIds: [String(publisher.id)],
              advertiserIds: [String(advertiser.id)],
              campaignId: CAMPAIGN_ID(brand.slug),
              adGroupId: AD_GROUP_ID,
              creativeId: p.asin,
            }),
          });
          tag = findTag(res);
          if (!tag) throw new Error(`no tag in response: ${JSON.stringify(res).slice(0, 300)}`);
        } catch (e) {
          console.error(`  ${p.asin} FAILED: ${e.message}`);
          totals.failed++;
          continue;
        }
        await sleep(300); // stay under the Attribution endpoints' rate limit
      }
    }
    const url = attributionUrl(p.asin, tag);
    rows.push({ brand: brand.brand, asin: p.asin, channel, attribution_url: url, campaign_name: campaignName, is_active: true });
    console.log(`  ${dryRun ? 'would create' : 'created'} ${p.asin}  ${campaignName}\n      ${url}`);
  }

  if (rows.length === 0) continue;
  if (dryRun) {
    totals.skipped += rows.length;
    continue;
  }
  // Upsert on the (brand, asin, channel) unique key so --force overwrites in place.
  await rest('attribution_links?on_conflict=brand,asin,channel', {
    method: 'POST',
    service: true,
    schema: 'bronze',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: rows,
  });
  totals.created += rows.length;
  console.log(`  wrote ${rows.length} row(s) to bronze.attribution_links.`);
}

console.log(
  `\n${probe ? 'probe complete' : dryRun ? `dry run: ${totals.skipped} tag(s) would be created` : `${totals.created} tag(s) created`}, ${totals.failed} failure(s).`
);
if (!probe && !dryRun && totals.created > 0) {
  console.log('Next: rebuild the affected sites (deploy hook / rebuild-all.ps1) so the new attribution_url values ship.');
}
process.exit(totals.failed > 0 ? 2 : 0);
