// Pulls the Amazon Attribution PERFORMANCE / PRODUCTS reports for a brand's
// store (last 90 days) and syncs every campaign the advertiser has traffic for
// into bronze.attribution_campaigns — the record of Attribution activity that
// does NOT run through the brand site (Google Ads → Amazon listing ads, creator
// links, console-made tags). The site's own tags live in
// bronze.attribution_links; both show up in the same console.
//
// Usage:
//   node scripts/attribution-report.mjs --brand=<slug>|all [--days=90] [--dry-run]
//   npm run attribution-report -- --brand=otis-classic
//
// Env (.env): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (reads
// public.ads_api_accounts, writes bronze.attribution_campaigns).
//
// Report API notes (verified 2026-09-21; the docs page is a JS app):
//   POST /attribution/report  body { reportType: PERFORMANCE|PRODUCTS,
//     advertiserIds: "<comma list>" (a STRING), startDate/endDate: YYYYMMDD,
//     groupBy: CAMPAIGN|ADGROUP|CREATIVE (PERFORMANCE only), metrics: "<comma
//     list>", count: 1..5000, cursorId: "" first, then the previous response's }
//   brb_bonus_amount is only allowed with groupBy CAMPAIGN|ADGROUP.
//   Google Ads macro-tag rows carry Google's own ids: campaignId/adGroupId are
//   Google's, creativeId is "ad-{creative}_{targetid}" where targetid is
//   dsa-… (Dynamic Search Ads) or kwd-…_<keyword text>.
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
const days = Number(arg('days') ?? 90);
const dryRun = flag('dry-run');
const ACTIVE_WINDOW_DAYS = 14;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!brandArg) {
  console.error('Pass --brand=<slug> or --brand=all.');
  process.exit(1);
}

// ---- dates (local; never toISOString) ---------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const isoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const today = new Date();
const startDate = new Date(today);
startDate.setDate(today.getDate() - (days - 1));
const activeCutoff = new Date(today);
activeCutoff.setDate(today.getDate() - ACTIVE_WINDOW_DAYS);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/** All rows of one report, following cursorId pagination. */
async function report(acct, advertiserId, reportType, metrics, groupBy) {
  const rows = [];
  let cursorId = '';
  for (let page = 0; page < 50; page++) {
    const body = {
      reportType,
      advertiserIds: String(advertiserId),
      startDate: ymd(startDate),
      endDate: ymd(today),
      metrics,
      count: 5000,
      cursorId,
      ...(groupBy ? { groupBy } : {}),
    };
    const res = await adsFetch(acct, '/attribution/report', { method: 'POST', body: JSON.stringify(body) });
    const batch = res?.reports ?? [];
    rows.push(...batch);
    if (!res?.cursorId || batch.length === 0) break;
    cursorId = res.cursorId;
  }
  return rows;
}

const num = (v) => Number(v ?? 0) || 0;

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

let failures = 0;
let written = 0;
for (const brand of brandRows) {
  console.log(`\n== ${brand.brand} (${brand.slug}) — store "${brand.store}", last ${days} days${dryRun ? ' [dry run]' : ''}`);
  const accounts = await rest(
    `ads_api_accounts?store=eq.${encodeURIComponent(brand.store)}&approval_status=eq.connected&is_active=eq.true&select=store,profile_id,client_id,client_secret,refresh_token`,
    { service: true }
  );
  const acct = accounts[0];
  if (!acct?.profile_id || !acct.client_id || !acct.client_secret || !acct.refresh_token) {
    console.error(`  no connected Ads API account for store "${brand.store}" — skipped.`);
    failures++;
    continue;
  }

  let advertisers;
  try {
    const adv = await adsFetch(acct, '/attribution/advertisers');
    advertisers = (adv?.advertisers ?? adv ?? []).map((a) => ({ id: String(a.advertiserId ?? a.id), name: a.advertiserName ?? a.name }));
  } catch (e) {
    console.error(`  ${e.message}`);
    failures++;
    continue;
  }

  for (const advertiser of advertisers) {
    console.log(`  advertiser ${advertiser.id} "${advertiser.name}"`);
    let byAdGroup, creatives, products;
    try {
      byAdGroup = await report(acct, advertiser.id, 'PERFORMANCE', 'Click-throughs,attributedPurchases14d,attributedSales14d,brb_bonus_amount', 'ADGROUP');
      creatives = await report(acct, advertiser.id, 'PERFORMANCE', 'Click-throughs', 'CREATIVE');
      products = await report(acct, advertiser.id, 'PRODUCTS', 'attributedDetailPageViewsClicks14d');
    } catch (e) {
      console.error(`  ${e.message}`);
      failures++;
      continue;
    }

    // Aggregate per (campaign, ad group).
    const key = (r) => `${r.campaignId} ${r.adGroupId}`;
    const camps = new Map();
    for (const r of byAdGroup) {
      const k = key(r);
      const c = camps.get(k) ?? {
        campaign_id: String(r.campaignId),
        ad_group_id: String(r.adGroupId),
        publisher: r.publisher ?? null,
        first: r.date,
        last: r.date,
        clicks: 0,
        purchases: 0,
        sales: 0,
        brb: 0,
        kinds: new Set(),
        keywords: new Set(),
        asinViews: new Map(),
      };
      c.clicks += num(r['Click-throughs']);
      c.purchases += num(r.attributedPurchases14d);
      c.sales += num(r.attributedSales14d);
      c.brb += num(r.brb_bonus_amount);
      if (r.date < c.first) c.first = r.date;
      if (r.date > c.last) c.last = r.date;
      camps.set(k, c);
    }
    for (const r of creatives) {
      const c = camps.get(key(r));
      if (!c) continue;
      c.publisher ??= r.publisher ?? null;
      const id = String(r.creativeId ?? '');
      if (/_dsa-/.test(id)) c.kinds.add('dsa');
      else if (/_kwd-/.test(id)) {
        c.kinds.add('keyword');
        const kw = id.replace(/^.*_kwd-\d+_/, '').trim();
        if (kw) c.keywords.add(kw);
      } else c.kinds.add('other');
    }
    for (const r of products) {
      const c = camps.get(key(r));
      if (!c) continue;
      c.publisher ??= r.publisher ?? null;
      const asin = r.productAsin ?? r.asin;
      if (asin) c.asinViews.set(asin, (c.asinViews.get(asin) ?? 0) + num(r.attributedDetailPageViewsClicks14d));
    }

    const rows = [...camps.values()].map((c) => {
      const kind = c.kinds.has('keyword') ? 'keyword' : c.kinds.has('dsa') ? 'dsa' : 'other';
      const primary = [...c.asinViews].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        brand: brand.brand,
        store: brand.store,
        advertiser_id: advertiser.id,
        publisher: c.publisher ?? 'unknown',
        campaign_id: c.campaign_id,
        ad_group_id: c.ad_group_id,
        campaign_kind: kind,
        primary_asin: primary,
        keywords: [...c.keywords].sort(),
        first_seen: isoDate(c.first),
        last_seen: isoDate(c.last),
        clicks_90d: c.clicks,
        purchases_90d: c.purchases,
        sales_90d: Math.round(c.sales * 100) / 100,
        brb_90d: Math.round(c.brb * 100) / 100,
        is_active: isoDate(c.last) >= `${activeCutoff.getFullYear()}-${pad(activeCutoff.getMonth() + 1)}-${pad(activeCutoff.getDate())}`,
        synced_at: new Date().toISOString(),
      };
    });
    rows.sort((a, b) => b.clicks_90d - a.clicks_90d);
    for (const r of rows) {
      console.log(
        `    ${r.is_active ? 'LIVE ' : 'idle '} ${r.publisher.padEnd(16)} ${r.campaign_id}/${r.ad_group_id}  ${r.campaign_kind.padEnd(7)} ${(r.primary_asin ?? '-').padEnd(10)} clicks ${String(r.clicks_90d).padStart(5)}  purch ${String(r.purchases_90d).padStart(3)}  sales $${r.sales_90d.toFixed(2).padStart(8)}  BRB $${r.brb_90d.toFixed(2).padStart(7)}  ${r.first_seen}→${r.last_seen}${r.keywords.length ? `  [${r.keywords.join(', ')}]` : ''}`
      );
    }
    if (rows.length === 0) {
      console.log('    no Attribution traffic in window.');
      continue;
    }
    if (dryRun) continue;
    await rest('attribution_campaigns?on_conflict=advertiser_id,campaign_id,ad_group_id', {
      method: 'POST',
      service: true,
      schema: 'bronze',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: rows,
    });
    written += rows.length;
    console.log(`    wrote ${rows.length} row(s) to bronze.attribution_campaigns.`);
  }
}

console.log(`\n${dryRun ? 'dry run' : `${written} campaign row(s) synced`}, ${failures} failure(s).`);
process.exit(failures > 0 ? 2 : 0);
