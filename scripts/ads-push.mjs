// Pushes a campaign spec (ads/<brand>/<post>.json from ads-campaigns.mjs) to
// Google Ads through the REST API, in one atomic mutate request: budget →
// campaign (PAUSED) → geo/language/negatives → ad groups → keywords →
// responsive search ad → sitelink + callout assets. Google resource names are
// written back into the spec under `google` so later runs update instead of
// duplicating.
//
// Usage:
//   node scripts/ads-push.mjs --spec=ads/otis-classic/<post>.json [--dry-run] [--validate-only]
//   node scripts/ads-push.mjs --spec=… --stage=maximize_conversions|target_roas [--target-roas=3]
//   node scripts/ads-push.mjs --spec=… --enable | --pause
//   npm run ads:push -- --spec=ads/otis-classic/<post>.json --validate-only
//
// Env (.env):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN (OAuth for a user on the manager account),
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (the manager account, digits only).
//   The client account comes from the spec (brand_sites.google_ads_customer_id)
//   or --customer=<id>.
//
// Safety: --dry-run prints the operations and exits; --validate-only sends the
// request with validateOnly=true so Google checks it without creating anything.
// New campaigns are always created PAUSED — go live with --enable after review.
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? 'v20';
const API_BASE = process.env.GOOGLE_ADS_API_BASE ?? 'https://googleads.googleapis.com';
const OAUTH_TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name) => process.argv.includes(`--${name}`);
const specPath = arg('spec');
const dryRun = flag('dry-run');
const validateOnly = flag('validate-only');
const stageArg = arg('stage');
const enable = flag('enable');
const pause = flag('pause');

if (!specPath) {
  console.error('Pass --spec=ads/<brand>/<post>.json');
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const customerId = (arg('customer') ?? spec.google?.customer_id ?? '').replace(/-/g, '');
if (!customerId && !dryRun) {
  console.error('No Google Ads customer id: set brand_sites.google_ads_customer_id (then regenerate) or pass --customer=<id>.');
  process.exit(1);
}

const env = {
  devToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  clientId: process.env.GOOGLE_ADS_CLIENT_ID,
  clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  loginCustomerId: (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? '').replace(/-/g, ''),
};
if (!dryRun && Object.values(env).some((v) => !v)) {
  console.error('GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN and GOOGLE_ADS_LOGIN_CUSTOMER_ID are required.');
  process.exit(1);
}

const micros = (usd) => String(Math.round(Number(usd) * 1_000_000));
const cid = customerId || '0000000000';
const res = (kind, id) => `customers/${cid}/${kind}/${id}`;

// ---- Google Ads REST ------------------------------------------------------------
async function accessToken() {
  const r = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.refreshToken, client_id: env.clientId, client_secret: env.clientSecret }),
  });
  if (!r.ok) throw new Error(`OAuth token refresh ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).access_token;
}

async function mutate(operations, { validate = false } = {}) {
  const token = await accessToken();
  const r = await fetch(`${API_BASE}/${API_VERSION}/customers/${cid}/googleAds:mutate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'developer-token': env.devToken,
      'login-customer-id': env.loginCustomerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mutateOperations: operations, partialFailure: false, validateOnly: validate }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`googleAds:mutate ${r.status}\n${text.slice(0, 4000)}`);
  return text ? JSON.parse(text) : {};
}

// ---- Operation builders -----------------------------------------------------------
// Temporary ids are negative and unique within one request; Google resolves
// references between operations in order.
let tmp = 0;
const nextTmp = () => String(--tmp);

function createOperations() {
  const c = spec.campaign;
  const ops = [];
  const budgetRes = res('campaignBudgets', nextTmp());
  ops.push({
    campaignBudgetOperation: {
      create: { resourceName: budgetRes, name: `${c.name} budget`, amountMicros: micros(c.budget_daily_usd), deliveryMethod: 'STANDARD', explicitlyShared: false },
    },
  });
  const campaignRes = res('campaigns', nextTmp());
  ops.push({
    campaignOperation: {
      create: {
        resourceName: campaignRes,
        name: c.name,
        status: c.status ?? 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetRes,
        networkSettings: {
          targetGoogleSearch: c.networks.google_search,
          targetSearchNetwork: c.networks.search_partners,
          targetContentNetwork: c.networks.display,
          targetPartnerSearchNetwork: false,
        },
        ...biddingFor(c.bidding),
        geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
        finalUrlSuffix: c.final_url_suffix,
        urlCustomParameters: Object.entries(c.custom_parameters ?? {}).map(([key, value]) => ({ key, value })),
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    },
  });
  for (const g of c.geo) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, location: { geoTargetConstant: `geoTargetConstants/${g.id}` } } } });
  for (const l of c.languages) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, language: { languageConstant: `languageConstants/${l.id}` } } } });
  for (const n of c.negatives) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, keyword: { text: n.text, matchType: n.match } } } });

  const adGroupRes = {};
  for (const g of spec.ad_groups) {
    const agRes = res('adGroups', nextTmp());
    adGroupRes[g.name] = agRes;
    ops.push({
      adGroupOperation: {
        create: { resourceName: agRes, name: g.name, campaign: campaignRes, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: micros(c.bidding.cpc_ceiling_usd) },
      },
    });
    for (const k of g.keywords) {
      ops.push({ adGroupCriterionOperation: { create: { adGroup: agRes, status: 'ENABLED', keyword: { text: k.text, matchType: k.match } } } });
    }
    const ad = g.ad;
    ops.push({
      adGroupAdOperation: {
        create: {
          adGroup: agRes,
          status: 'ENABLED',
          ad: {
            finalUrls: [ad.final_url],
            responsiveSearchAd: {
              headlines: ad.headlines.map((text, i) => (i === 0 && ad.pinned?.headline_1 ? { text, pinnedField: 'HEADLINE_1' } : { text })),
              descriptions: ad.descriptions.map((text) => ({ text })),
              ...(ad.path1 ? { path1: ad.path1 } : {}),
              ...(ad.path2 ? { path2: ad.path2 } : {}),
            },
          },
        },
      },
    });
  }

  // Campaign-level assets: sitelinks + callouts (shared by every ad group).
  const firstAd = spec.ad_groups[0]?.ad ?? {};
  for (const s of firstAd.sitelinks ?? []) {
    const assetRes = res('assets', nextTmp());
    ops.push({
      assetOperation: {
        create: {
          resourceName: assetRes,
          finalUrls: [s.url],
          sitelinkAsset: { linkText: s.text, ...(s.line1 && s.line2 ? { description1: s.line1, description2: s.line2 } : {}) },
        },
      },
    });
    ops.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: assetRes, fieldType: 'SITELINK' } } });
  }
  for (const text of firstAd.callouts ?? []) {
    const assetRes = res('assets', nextTmp());
    ops.push({ assetOperation: { create: { resourceName: assetRes, calloutAsset: { calloutText: text } } } });
    ops.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: assetRes, fieldType: 'CALLOUT' } } });
  }
  return { ops, campaignRes, adGroupRes };
}

function biddingFor(b) {
  switch (b.stage) {
    case 'maximize_clicks':
      return { targetSpend: { cpcBidCeilingMicros: micros(b.cpc_ceiling_usd) } };
    case 'maximize_conversions':
      return { maximizeConversions: {} };
    case 'target_roas':
      return { maximizeConversionValue: { targetRoas: Number(b.target_roas ?? 3) } };
    default:
      throw new Error(`unknown bidding stage ${b.stage}`);
  }
}

function updateOperations() {
  if (!spec.google?.campaign) throw new Error('spec has no google.campaign resource name — create it first.');
  const ops = [];
  if (stageArg) {
    const bidding = { stage: stageArg, cpc_ceiling_usd: spec.campaign.bidding.cpc_ceiling_usd, target_roas: Number(arg('target-roas') ?? spec.campaign.bidding.target_roas ?? 3) };
    const field = { maximize_clicks: 'target_spend', maximize_conversions: 'maximize_conversions', target_roas: 'maximize_conversion_value' }[stageArg];
    if (!field) throw new Error(`unknown --stage=${stageArg}`);
    ops.push({ campaignOperation: { updateMask: field, update: { resourceName: spec.google.campaign, ...biddingFor(bidding) } } });
    spec.campaign.bidding = bidding;
  }
  if (enable || pause) {
    const status = enable ? 'ENABLED' : 'PAUSED';
    ops.push({ campaignOperation: { updateMask: 'status', update: { resourceName: spec.google.campaign, status } } });
    spec.campaign.status = status;
  }
  return ops;
}

// ---- Main ---------------------------------------------------------------------------
const isUpdate = Boolean(stageArg || enable || pause);
const { ops, campaignRes, adGroupRes } = isUpdate ? { ops: updateOperations(), campaignRes: null, adGroupRes: {} } : createOperations();

if (!isUpdate && spec.google?.campaign && !flag('force')) {
  console.error(`Spec already carries a campaign (${spec.google.campaign}). Use --enable / --pause / --stage=… to change it, or --force to create another.`);
  process.exit(1);
}

console.log(`${spec.campaign.name} → customer ${cid}: ${ops.length} operation(s)${validateOnly ? ' [validate only]' : ''}${dryRun ? ' [dry run]' : ''}`);
if (dryRun) {
  console.log(JSON.stringify({ mutateOperations: ops }, null, 2));
  process.exit(0);
}

const result = await mutate(ops, { validate: validateOnly });
if (validateOnly) {
  console.log('Google accepted the request (validateOnly) — nothing was created.');
  process.exit(0);
}

const names = (result.mutateOperationResponses ?? []).map((r) => Object.values(r)[0]?.resourceName).filter(Boolean);
if (!isUpdate) {
  spec.google = spec.google ?? {};
  spec.google.customer_id = cid;
  spec.google.campaign = names.find((n) => /\/campaigns\//.test(n)) ?? null;
  const agNames = names.filter((n) => /\/adGroups\//.test(n));
  spec.google.ad_groups = Object.fromEntries(Object.keys(adGroupRes).map((name, i) => [name, agNames[i] ?? null]));
  spec.google.pushed = new Date().toLocaleString('en-US');
  console.log(`created ${spec.google.campaign} (PAUSED) with ${Object.keys(spec.google.ad_groups).length} ad group(s), ${names.length} resources.`);
} else {
  console.log(`updated ${spec.google.campaign}: ${[stageArg && `stage=${stageArg}`, enable && 'ENABLED', pause && 'PAUSED'].filter(Boolean).join(', ')}`);
}
writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`spec updated: ${specPath}`);
