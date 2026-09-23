// GA4 setup for a brand site through the Google Analytics Admin API —
// idempotent, safe to re-run: finds or creates the property and web stream,
// sets 14-month retention, marks amazon_click as a key event, registers the
// CTA event parameters as custom dimensions, links the brand's Google Ads
// account, and writes the measurement id to bronze.brand_sites so the next
// build ships the gtag snippet (Base.astro).
//
// Usage:
//   node scripts/ga-setup.mjs --brand=<slug> [--account=<GA account id>] [--dry-run]
//   npm run ga:setup -- --brand=otis-classic
//
// Env (.env): GOOGLE_ADS_CLIENT_ID/SECRET + GOOGLE_ADS_REFRESH_TOKEN from
// `npm run ads:auth` (the token must carry the analytics.edit scope — re-run
// ads:auth once if it predates it), SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY (writes bronze.brand_sites). The Cloud project
// needs the "Google Analytics Admin API" enabled, and the signed-in user needs
// Editor on the GA account and admin on the Google Ads account (for the link).
import process from 'node:process';
import { accessToken, digits } from './lib/google-ads.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const TIME_ZONE = 'America/Chicago';
const CURRENCY = 'USD';
// Parameters Base.astro sends with outbound_amazon_click / amazon_click.
const DIMENSIONS = [
  { parameterName: 'asin', displayName: 'ASIN', description: 'Amazon ASIN of the clicked CTA' },
  { parameterName: 'cta_channel', displayName: 'CTA channel', description: 'organic | google_ads (paid-landing swap)' },
  { parameterName: 'cta_position', displayName: 'CTA position', description: 'Where on the page the Amazon CTA sat' },
  { parameterName: 'page_type', displayName: 'Page type', description: 'home | product | blog | …' },
];
const KEY_EVENT = 'amazon_click';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const dryRun = process.argv.includes('--dry-run');
const slug = arg('brand');
if (!slug) {
  console.error('Pass --brand=<slug>.');
  process.exit(1);
}

async function ga(method, path, body) {
  const r = await fetch(`${ADMIN}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    let hint = '';
    if (/SERVICE_DISABLED|has not been used in project/.test(text)) hint = '\n→ Enable the Google Analytics Admin API in the Cloud project, wait a minute, re-run.';
    else if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) hint = '\n→ The refresh token lacks analytics.edit: run npm run ads:auth once more.';
    throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 600)}${hint}`);
  }
  return text ? JSON.parse(text) : {};
}
async function listAll(path, key) {
  const out = [];
  let pageToken;
  do {
    const j = await ga('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
    out.push(...(j[key] ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

async function supabase(path, { method = 'GET', body, service = false } = {}) {
  const key = service ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(service ? { 'Accept-Profile': 'bronze', 'Content-Profile': 'bronze', Prefer: 'return=representation' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

const step = (msg) => console.log(`  ${msg}`);

// ---- Brand -------------------------------------------------------------------------
const [brand] = await supabase(`brand_sites?slug=eq.${encodeURIComponent(slug)}&select=slug,brand,domain,google_ads_customer_id,google_analytics_id`);
if (!brand) {
  console.error(`No brand_sites row for "${slug}".`);
  process.exit(1);
}
const siteUrl = `https://www.${brand.domain}`;
const propertyName = `${brand.brand} (${brand.domain})`;
console.log(`== ${brand.brand} → GA4 "${propertyName}"${dryRun ? ' [dry run]' : ''}`);

// ---- Account + property --------------------------------------------------------------
const summaries = await listAll('accountSummaries', 'accountSummaries');
if (summaries.length === 0) {
  console.error('This Google user has no Google Analytics account. Create one at analytics.google.com (accepting the terms), then re-run.');
  process.exit(1);
}
let property = summaries.flatMap((a) => (a.propertySummaries ?? []).map((p) => ({ ...p, account: a.account }))).find((p) => p.displayName === propertyName);
let account = property?.account;
if (!account) {
  const wanted = arg('account');
  const pick = wanted ? summaries.find((a) => a.account === `accounts/${wanted}`) : summaries.length === 1 ? summaries[0] : null;
  if (!pick) {
    console.error(`Pick the GA account with --account=<id>:\n${summaries.map((a) => `  ${a.account.split('/')[1]}  ${a.displayName}  (${(a.propertySummaries ?? []).length} properties)`).join('\n')}`);
    process.exit(1);
  }
  account = pick.account;
}
step(`account ${account}`);
if (property) step(`property ${property.property} exists`);
else if (dryRun) step(`would create property "${propertyName}" (${TIME_ZONE}, ${CURRENCY})`);
else {
  const p = await ga('POST', 'properties', { parent: account, displayName: propertyName, timeZone: TIME_ZONE, currencyCode: CURRENCY });
  property = { property: p.name };
  step(`created property ${p.name}`);
}
if (!property) process.exit(0);
const P = property.property;

// ---- Web stream ----------------------------------------------------------------------
const streams = await listAll(`${P}/dataStreams`, 'dataStreams');
let stream = streams.find((s) => s.type === 'WEB_DATA_STREAM' && s.webStreamData?.defaultUri?.replace(/\/$/, '') === siteUrl);
if (stream) step(`web stream ${stream.webStreamData.measurementId} exists`);
else if (dryRun) step(`would create web stream ${siteUrl}`);
else {
  stream = await ga('POST', `${P}/dataStreams`, { type: 'WEB_DATA_STREAM', displayName: `www.${brand.domain}`, webStreamData: { defaultUri: siteUrl } });
  step(`created web stream ${stream.webStreamData.measurementId}`);
}
const measurementId = stream?.webStreamData?.measurementId;

// ---- Retention, key event, dimensions ---------------------------------------------------
if (!dryRun) {
  await ga('PATCH', `${P}/dataRetentionSettings?updateMask=eventDataRetention,resetUserDataOnNewActivity`, {
    eventDataRetention: 'FOURTEEN_MONTHS',
    resetUserDataOnNewActivity: true,
  });
  step('data retention 14 months');
}
const keyEvents = await listAll(`${P}/keyEvents`, 'keyEvents');
if (keyEvents.some((k) => k.eventName === KEY_EVENT)) step(`key event ${KEY_EVENT} exists`);
else if (dryRun) step(`would mark ${KEY_EVENT} as a key event`);
else {
  // Once per session: a shopper who clicks three Amazon buttons is one lead,
  // and this is what Google Ads bidding will optimize toward.
  await ga('POST', `${P}/keyEvents`, { eventName: KEY_EVENT, countingMethod: 'ONCE_PER_SESSION' });
  step(`key event ${KEY_EVENT} (once per session)`);
}
const dims = await listAll(`${P}/customDimensions`, 'customDimensions');
for (const d of DIMENSIONS) {
  if (dims.some((x) => x.parameterName === d.parameterName && x.scope === 'EVENT')) continue;
  if (dryRun) step(`would register dimension ${d.parameterName}`);
  else {
    await ga('POST', `${P}/customDimensions`, { ...d, scope: 'EVENT' });
    step(`dimension ${d.parameterName}`);
  }
}

// ---- Google Ads link ---------------------------------------------------------------
const adsId = digits(brand.google_ads_customer_id);
if (!adsId) step('no google_ads_customer_id — skipped the Google Ads link');
else {
  const links = await listAll(`${P}/googleAdsLinks`, 'googleAdsLinks');
  if (links.some((l) => l.customerId === adsId)) step(`Google Ads ${adsId} already linked`);
  else if (dryRun) step(`would link Google Ads ${adsId}`);
  else {
    try {
      await ga('POST', `${P}/googleAdsLinks`, { customerId: adsId });
      step(`linked Google Ads ${adsId}`);
    } catch (err) {
      step(`could not link Google Ads ${adsId}: ${err.message.split('\n')[0]}`);
      step('  → link it in GA4 Admin → Product links → Google Ads links (needs admin on both)');
    }
  }
}

// ---- Brand row ------------------------------------------------------------------------
if (measurementId && brand.google_analytics_id !== measurementId) {
  if (dryRun) step(`would set brand_sites.google_analytics_id = ${measurementId}`);
  else {
    await supabase(`brand_sites?slug=eq.${encodeURIComponent(slug)}`, { method: 'PATCH', body: { google_analytics_id: measurementId }, service: true });
    step(`brand_sites.google_analytics_id = ${measurementId} — rebuild the site to ship it`);
  }
} else if (measurementId) step(`brand_sites.google_analytics_id already ${measurementId}`);
