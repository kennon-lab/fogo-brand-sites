// Pushes a campaign spec (ads/<brand>/<post>.json from ads-campaigns.mjs) to
// Google Ads through the REST API, in one atomic mutate request: budget →
// campaign (PAUSED) → geo/language/negatives → ad groups → keywords →
// responsive search ad → sitelink + callout assets. Google resource names are
// written back into the spec under `google` so later runs update instead of
// duplicating.
//
// Usage:
//   node scripts/ads-push.mjs --spec=ads/otis-classic/<post>.json [--dry-run] [--validate-only]
//   node scripts/ads-push.mjs --spec=… --sync [--dry-run|--validate-only]
//                             (bring a pushed campaign in line with its spec)
//   node scripts/ads-push.mjs --spec=… --stage=maximize_conversions|target_roas [--target-roas=3]
//   node scripts/ads-push.mjs --spec=… --enable [--ack-warnings] | --pause
//   node scripts/ads-push.mjs --spec=… --settings   (re-apply EXCLUDED_PARENT_ASSETS to a pushed campaign)
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
// request with validateOnly=true so Google checks it without changing anything.
// New campaigns are always created PAUSED. Creating, syncing and enabling all
// require a passing `npm run ads:review` of the spec exactly as it is now
// (spec.review.hash); --enable additionally requires every ad to be approved
// by Google, the live campaign to match the spec, and --ack-warnings when the
// review raised warnings.
//
// Account-level assets (a client account's call/phone asset, etc.) are
// inherited by every campaign unless excluded; brand-site campaigns never show
// a phone number, so each one opts out of EXCLUDED_PARENT_ASSETS.
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { adsEnv, search, mutate, digits, failureLines } from './lib/google-ads.mjs';
import { specHash } from './lib/ads-spec.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name) => process.argv.includes(`--${name}`);
const specPath = arg('spec');
const dryRun = flag('dry-run');
const validateOnly = flag('validate-only');
const stageArg = arg('stage');
const enable = flag('enable');
const pause = flag('pause');
const settings = flag('settings');
const sync = flag('sync');
const EXCLUDED_PARENT_ASSETS = ['CALL'];

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!specPath) fail('Pass --spec=ads/<brand>/<post>.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const customerId = digits(arg('customer') ?? spec.google?.customer_id ?? '');
if (!customerId && !dryRun) fail('No Google Ads customer id: set brand_sites.google_ads_customer_id (then regenerate) or pass --customer=<id>.');
if (!dryRun && adsEnv().missing.length > 0) fail(`Missing ${adsEnv().missing.join(', ')}.`);

const micros = (usd) => String(Math.round(Number(usd) * 1_000_000));
const cid = customerId || '0000000000';
const res = (kind, id) => `customers/${cid}/${kind}/${id}`;

// ---- Review gate --------------------------------------------------------------------
function requireReview(action) {
  const r = spec.review;
  if (!r) fail(`Refusing to ${action}: spec has no review. Run npm run ads:review -- --spec=${specPath}`);
  if (r.hash !== specHash(spec)) fail(`Refusing to ${action}: the spec changed since it was reviewed on ${r.date}. Re-run npm run ads:review -- --spec=${specPath}`);
  if (r.status === 'fail') fail(`Refusing to ${action}: the review failed:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
}

// ---- Operation builders -----------------------------------------------------------
// Temporary ids are negative and unique within one request; Google resolves
// references between operations in order.
let tmp = 0;
const nextTmp = () => String(--tmp);

const keywordCreate = (adGroup, k) => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.match } } } });
const negativeCreate = (campaign, n) => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: n.text, matchType: n.match } } } });

function adCreate(adGroup, ad) {
  return {
    adGroupAdOperation: {
      create: {
        adGroup,
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
  };
}

function adGroupOperations(g, campaignRes) {
  const agRes = res('adGroups', nextTmp());
  return [
    {
      adGroupOperation: {
        create: { resourceName: agRes, name: g.name, campaign: campaignRes, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: micros(spec.campaign.bidding.cpc_ceiling_usd) },
      },
    },
    ...g.keywords.map((k) => keywordCreate(agRes, k)),
    adCreate(agRes, g.ad),
  ];
}

function sitelinkOperations(campaignRes, s) {
  const assetRes = res('assets', nextTmp());
  return [
    {
      assetOperation: {
        create: {
          resourceName: assetRes,
          finalUrls: [s.url],
          sitelinkAsset: { linkText: s.text, ...(s.line1 && s.line2 ? { description1: s.line1, description2: s.line2 } : {}) },
        },
      },
    },
    { campaignAssetOperation: { create: { campaign: campaignRes, asset: assetRes, fieldType: 'SITELINK' } } },
  ];
}

function calloutOperations(campaignRes, text) {
  const assetRes = res('assets', nextTmp());
  return [
    { assetOperation: { create: { resourceName: assetRes, calloutAsset: { calloutText: text } } } },
    { campaignAssetOperation: { create: { campaign: campaignRes, asset: assetRes, fieldType: 'CALLOUT' } } },
  ];
}

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
        excludedParentAssetFieldTypes: EXCLUDED_PARENT_ASSETS,
      },
    },
  });
  for (const g of c.geo) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, location: { geoTargetConstant: `geoTargetConstants/${g.id}` } } } });
  for (const l of c.languages) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, language: { languageConstant: `languageConstants/${l.id}` } } } });
  for (const n of c.negatives) ops.push(negativeCreate(campaignRes, n));
  for (const g of spec.ad_groups) ops.push(...adGroupOperations(g, campaignRes));

  // Campaign-level assets: sitelinks + callouts (shared by every ad group).
  const firstAd = spec.ad_groups[0]?.ad ?? {};
  for (const s of firstAd.sitelinks ?? []) ops.push(...sitelinkOperations(campaignRes, s));
  for (const text of firstAd.callouts ?? []) ops.push(...calloutOperations(campaignRes, text));
  return ops;
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

// ---- Sync: make the live campaign match the spec ------------------------------------------
const kwKey = (text, match) => `${String(text).toLowerCase()}|${match}`;
const rsaKey = (ad) =>
  JSON.stringify({
    h: ad.headlines.map((t, i) => [t, i === 0 && ad.pinned?.headline_1 ? 'HEADLINE_1' : null]),
    d: ad.descriptions,
    p1: ad.path1 ?? null,
    p2: ad.path2 ?? null,
    u: ad.final_url,
  });
const liveRsaKey = (a) => {
  const rsa = a.responsiveSearchAd ?? {};
  return JSON.stringify({
    h: (rsa.headlines ?? []).map((h) => [h.text, h.pinnedField && h.pinnedField !== 'UNSPECIFIED' ? h.pinnedField : null]),
    d: (rsa.descriptions ?? []).map((d) => d.text),
    p1: rsa.path1 ?? null,
    p2: rsa.path2 ?? null,
    u: a.finalUrls?.[0],
  });
};
const sitelinkKey = (s) => JSON.stringify([s.text, s.url, s.line1 && s.line2 ? s.line1 : null, s.line1 && s.line2 ? s.line2 : null]);

/** Operations that bring the live campaign in line with the spec, and a readable list of them. */
async function syncOperations() {
  const campaignRes = spec.google?.campaign;
  if (!campaignRes) throw new Error('spec has no google.campaign resource name — create it first.');
  const where = `campaign.id = ${campaignRes.split('/').pop()}`;
  const [camp] = await search(cid, `SELECT campaign.id, campaign.campaign_budget, campaign_budget.amount_micros, campaign.excluded_parent_asset_field_types FROM campaign WHERE ${where}`);
  if (!camp) throw new Error(`${campaignRes} not found in Google Ads.`);
  const groups = await search(cid, `SELECT campaign.id, ad_group.resource_name, ad_group.name, ad_group.cpc_bid_micros FROM ad_group WHERE ${where} AND ad_group.status != 'REMOVED'`);
  const keywords = await search(
    cid,
    `SELECT campaign.id, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ${where} AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'`
  );
  const negatives = await search(
    cid,
    `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE ${where} AND campaign_criterion.type = KEYWORD AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED'`
  );
  const ads = await search(
    cid,
    `SELECT campaign.id, ad_group.name, ad_group_ad.resource_name, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad WHERE ${where} AND ad_group_ad.status != 'REMOVED'`
  );
  const assets = await search(
    cid,
    `SELECT campaign.id, campaign_asset.resource_name, campaign_asset.field_type, asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text FROM campaign_asset WHERE ${where} AND campaign_asset.status != 'REMOVED' AND campaign_asset.field_type IN ('SITELINK', 'CALLOUT')`
  );

  const ops = [];
  const changes = [];
  const add = (change, ...operations) => {
    changes.push(change);
    ops.push(...operations);
  };
  const c = spec.campaign;

  // Budget, parent-asset exclusion.
  if (camp.campaignBudget?.amountMicros !== micros(c.budget_daily_usd)) {
    add(`budget → $${c.budget_daily_usd}/day`, { campaignBudgetOperation: { updateMask: 'amount_micros', update: { resourceName: camp.campaign.campaignBudget, amountMicros: micros(c.budget_daily_usd) } } });
  }
  const excluded = camp.campaign.excludedParentAssetFieldTypes ?? [];
  if (EXCLUDED_PARENT_ASSETS.some((t) => !excluded.includes(t))) {
    add(`exclude account-level ${EXCLUDED_PARENT_ASSETS.join(', ')} assets`, {
      campaignOperation: { updateMask: 'excluded_parent_asset_field_types', update: { resourceName: campaignRes, excludedParentAssetFieldTypes: EXCLUDED_PARENT_ASSETS } },
    });
  }

  // Negatives.
  const wantNeg = new Map(c.negatives.map((n) => [kwKey(n.text, n.match), n]));
  const haveNeg = new Map(negatives.map((r) => [kwKey(r.campaignCriterion.keyword.text, r.campaignCriterion.keyword.matchType), r.campaignCriterion.resourceName]));
  for (const [k, rn] of haveNeg) if (!wantNeg.has(k)) add(`- negative ${k}`, { campaignCriterionOperation: { remove: rn } });
  for (const [k, n] of wantNeg) if (!haveNeg.has(k)) add(`+ negative ${k}`, negativeCreate(campaignRes, n));

  // Ad groups, keywords, ads.
  const liveGroups = new Map(groups.map((g) => [g.adGroup.name, g.adGroup]));
  for (const [name, g] of liveGroups) if (!spec.ad_groups.some((sg) => sg.name === name)) add(`- ad group ${name}`, { adGroupOperation: { remove: g.resourceName } });
  for (const sg of spec.ad_groups) {
    const live = liveGroups.get(sg.name);
    if (!live) {
      add(`+ ad group ${sg.name} (${sg.keywords.length} keywords + ad)`, ...adGroupOperations(sg, campaignRes));
      continue;
    }
    if (live.cpcBidMicros !== micros(c.bidding.cpc_ceiling_usd)) {
      add(`${sg.name}: CPC bid → $${c.bidding.cpc_ceiling_usd}`, { adGroupOperation: { updateMask: 'cpc_bid_micros', update: { resourceName: live.resourceName, cpcBidMicros: micros(c.bidding.cpc_ceiling_usd) } } });
    }
    const want = new Map(sg.keywords.map((k) => [kwKey(k.text, k.match), k]));
    const have = new Map(keywords.filter((r) => r.adGroup.name === sg.name).map((r) => [kwKey(r.adGroupCriterion.keyword.text, r.adGroupCriterion.keyword.matchType), r.adGroupCriterion.resourceName]));
    for (const [k, rn] of have) if (!want.has(k)) add(`${sg.name}: - ${k}`, { adGroupCriterionOperation: { remove: rn } });
    for (const [k, kw] of want) if (!have.has(k)) add(`${sg.name}: + ${k}`, keywordCreate(live.resourceName, kw));
    // RSA text can't be edited in place: replace the ad when it differs.
    const liveAds = ads.filter((r) => r.adGroup.name === sg.name).map((r) => r.adGroupAd);
    if (liveAds.length !== 1 || liveRsaKey(liveAds[0].ad) !== rsaKey(sg.ad)) {
      add(`${sg.name}: replace responsive search ad`, ...liveAds.map((a) => ({ adGroupAdOperation: { remove: a.resourceName } })), adCreate(live.resourceName, sg.ad));
    }
  }

  // Sitelinks + callouts (campaign level).
  const firstAd = spec.ad_groups[0]?.ad ?? {};
  const wantSl = new Map((firstAd.sitelinks ?? []).map((s) => [sitelinkKey(s), s]));
  const wantCo = new Set(firstAd.callouts ?? []);
  const haveSl = new Map();
  const haveCo = new Map();
  for (const r of assets) {
    if (r.campaignAsset.fieldType === 'SITELINK') {
      const s = r.asset.sitelinkAsset ?? {};
      haveSl.set(sitelinkKey({ text: s.linkText, url: r.asset.finalUrls?.[0], line1: s.description1 ?? null, line2: s.description2 ?? null }), r.campaignAsset.resourceName);
    } else haveCo.set(r.asset.calloutAsset?.calloutText, r.campaignAsset.resourceName);
  }
  for (const [k, rn] of haveSl) if (!wantSl.has(k)) add(`- sitelink ${JSON.parse(k)[0]}`, { campaignAssetOperation: { remove: rn } });
  for (const [k, s] of wantSl) if (!haveSl.has(k)) add(`+ sitelink ${s.text}`, ...sitelinkOperations(campaignRes, s));
  for (const [t, rn] of haveCo) if (!wantCo.has(t)) add(`- callout ${t}`, { campaignAssetOperation: { remove: rn } });
  for (const t of wantCo) if (!haveCo.has(t)) add(`+ callout ${t}`, ...calloutOperations(campaignRes, t));

  return { ops, changes };
}

// ---- Status / stage / settings updates ------------------------------------------------
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
  if (settings) {
    ops.push({ campaignOperation: { updateMask: 'excluded_parent_asset_field_types', update: { resourceName: spec.google.campaign, excludedParentAssetFieldTypes: EXCLUDED_PARENT_ASSETS } } });
  }
  if (enable || pause) {
    const status = enable ? 'ENABLED' : 'PAUSED';
    ops.push({ campaignOperation: { updateMask: 'status', update: { resourceName: spec.google.campaign, status } } });
    spec.campaign.status = status;
  }
  return ops;
}

/** --enable preconditions beyond the review: live state matches, ads approved, warnings acknowledged. */
async function enableChecks() {
  const { changes } = await syncOperations();
  if (changes.length > 0) fail(`Refusing to enable: the live campaign differs from the spec. Run --sync first:\n${changes.map((c) => `  ${c}`).join('\n')}`);
  const rows = await search(
    cid,
    `SELECT campaign.id, ad_group.name, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status FROM ad_group_ad WHERE campaign.id = ${spec.google.campaign.split('/').pop()} AND ad_group_ad.status = 'ENABLED'`
  );
  const notApproved = rows.filter((r) => !['APPROVED', 'APPROVED_LIMITED'].includes(r.adGroupAd.policySummary?.approvalStatus));
  if (notApproved.length > 0) {
    fail(`Refusing to enable: ${notApproved.length} ad(s) not approved yet — ${notApproved.map((r) => `${r.adGroup.name}: ${r.adGroupAd.policySummary?.approvalStatus ?? 'UNKNOWN'} (${r.adGroupAd.policySummary?.reviewStatus ?? '?'})`).join('; ')}.`);
  }
  if (spec.review.warnings?.length && !flag('ack-warnings')) {
    fail(`Refusing to enable until the review warnings are acknowledged with --ack-warnings:\n${spec.review.warnings.map((w) => `  - ${w}`).join('\n')}`);
  }
}

// ---- Main ---------------------------------------------------------------------------
const isUpdate = Boolean(stageArg || enable || pause || settings);
if (!isUpdate && !sync && spec.google?.campaign && !flag('force')) {
  fail(`Spec already carries a campaign (${spec.google.campaign}). Use --sync to update it, --enable / --pause / --stage=… to change it, or --force to create another.`);
}
const writes = !dryRun && !validateOnly;
try {
  if (writes && (sync || enable || !isUpdate)) requireReview(sync ? 'sync' : enable ? 'enable' : 'create');
  if (writes && enable) await enableChecks();
} catch (err) {
  fail(failureLines(err).join('\n'));
}

let ops;
let changes = [];
try {
  if (sync) {
    if (!customerId) fail('--sync needs the customer id.');
    ({ ops, changes } = await syncOperations());
  } else ops = isUpdate ? updateOperations() : createOperations();
} catch (err) {
  fail(failureLines(err).join('\n'));
}

console.log(`${spec.campaign.name} → customer ${cid}: ${ops.length} operation(s)${sync ? ' [sync]' : ''}${validateOnly ? ' [validate only]' : ''}${dryRun ? ' [dry run]' : ''}`);
for (const c of changes) console.log(`  ${c}`);
if (dryRun) {
  if (!sync) console.log(JSON.stringify({ mutateOperations: ops }, null, 2));
  process.exit(0);
}
if (ops.length === 0) {
  console.log('Nothing to change — the live campaign matches the spec.');
  process.exit(0);
}

let result;
try {
  result = await mutate(cid, ops, { validate: validateOnly });
} catch (err) {
  fail(`Google rejected the request:\n${failureLines(err).map((l) => `  ${l}`).join('\n')}`);
}
if (validateOnly) {
  console.log('Google accepted the request (validateOnly) — nothing was changed.');
  process.exit(0);
}

const names = (result.mutateOperationResponses ?? []).map((r) => Object.values(r)[0]?.resourceName).filter(Boolean);
if (sync) {
  const groups = await search(cid, `SELECT campaign.id, ad_group.resource_name, ad_group.name FROM ad_group WHERE campaign.id = ${spec.google.campaign.split('/').pop()} AND ad_group.status != 'REMOVED'`);
  spec.google.ad_groups = Object.fromEntries(groups.map((g) => [g.adGroup.name, g.adGroup.resourceName]));
  spec.google.synced = new Date().toLocaleString('en-US');
  console.log(`synced ${spec.google.campaign}: ${changes.length} change(s).`);
} else if (!isUpdate) {
  spec.google = spec.google ?? {};
  spec.google.customer_id = cid;
  spec.google.campaign = names.find((n) => /\/campaigns\//.test(n)) ?? null;
  const agNames = names.filter((n) => /\/adGroups\//.test(n));
  spec.google.ad_groups = Object.fromEntries(spec.ad_groups.map((g, i) => [g.name, agNames[i] ?? null]));
  spec.google.pushed = new Date().toLocaleString('en-US');
  console.log(`created ${spec.google.campaign} (PAUSED) with ${Object.keys(spec.google.ad_groups).length} ad group(s), ${names.length} resources.`);
} else {
  console.log(`updated ${spec.google.campaign}: ${[stageArg && `stage=${stageArg}`, settings && `excluded parent assets=${EXCLUDED_PARENT_ASSETS.join(',')}`, enable && 'ENABLED', pause && 'PAUSED'].filter(Boolean).join(', ')}`);
}
writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`spec updated: ${specPath}`);
