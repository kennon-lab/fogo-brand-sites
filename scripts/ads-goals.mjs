// Conversion goals for brand-site campaigns in a (possibly shared) Google Ads
// account. Turns on the GA4-imported amazon_click action that the GA4 ↔ Ads
// link creates (hidden), files it under its own category (OUTBOUND_CLICK) as
// a primary action (secondary first, so it never bids by accident), keeps
// that category OUT of the account-default goals (so
// other campaigns in the account — e.g. an agency's direct-to-Amazon
// campaigns — keep bidding only on their own goals), and gives every
// fbs-{brand}-* campaign a campaign-level goal of amazon_click only.
//
// Usage:
//   node scripts/ads-goals.mjs --brand=<slug>            validate only (default)
//   node scripts/ads-goals.mjs --brand=<slug> --apply    make the changes
//   npm run ads:goals -- --brand=otis-classic --apply
//
// Env (.env): GOOGLE_ADS_* (see ads-push.mjs), SUPABASE_URL, SUPABASE_ANON_KEY.
import process from 'node:process';
import { search, mutate, digits, failureLines } from './lib/google-ads.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const CATEGORY = 'OUTBOUND_CLICK';
const ORIGIN = 'WEBSITE';
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const apply = process.argv.includes('--apply');
const slug = arg('brand');
if (!slug) {
  console.error('Pass --brand=<slug>.');
  process.exit(1);
}

const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/brand_sites?slug=eq.${encodeURIComponent(slug)}&select=slug,brand,google_ads_customer_id`, {
  headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` },
});
const [brand] = await r.json();
const cid = digits(brand?.google_ads_customer_id);
if (!cid) {
  console.error(`No google_ads_customer_id for "${slug}".`);
  process.exit(1);
}
const C = `customers/${cid}`;
console.log(`== ${brand.brand} → Google Ads ${cid}${apply ? '' : ' [validate only]'}`);

const run = async (label, ops) => {
  if (ops.length === 0) return console.log(`  ${label}: nothing to change`);
  try {
    await mutate(cid, ops, { validate: !apply });
    console.log(`  ${label}: ${apply ? 'done' : 'Google accepts'} (${ops.length} operation(s))`);
  } catch (err) {
    console.error(`  ${label}: Google rejected it\n${failureLines(err).map((l) => `    ${l}`).join('\n')}`);
    process.exit(1);
  }
};

// 1. The GA4 amazon_click action. Counting is GA4's (once per session, set by
// ga-setup) — Google Ads treats it as immutable for GA4 imports.
const loadAction = async () =>
  (
    await search(
      cid,
      "SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.type = 'GOOGLE_ANALYTICS_4_CUSTOM' AND conversion_action.status != 'REMOVED'"
    )
  )
    .map((a) => a.conversionAction)
    .find((a) => /\bamazon_click$/.test(a.name));
let action = await loadAction();
if (!action) {
  console.error('  No GA4 amazon_click conversion action — link GA4 first (npm run ga:setup) and wait for Google to list it.');
  process.exit(1);
}
console.log(`  action "${action.name}": ${action.status}, ${action.category}, ${action.primaryForGoal ? 'primary' : 'secondary'}`);

// The OUTBOUND_CLICK account goal only exists once an action in that category
// is enabled, and a new category can become an account default on its own.
// So the order is: enable as SECONDARY (never used for bidding) → take the
// category out of the account defaults → only then make it primary → check
// the defaults again.
const goalRes = `${C}/customerConversionGoals/${CATEGORY}~${ORIGIN}`;
const keepOutOfDefaults = async (label) => {
  const [goal] = await search(cid, `SELECT customer_conversion_goal.biddable FROM customer_conversion_goal WHERE customer_conversion_goal.category = '${CATEGORY}' AND customer_conversion_goal.origin = '${ORIGIN}'`);
  if (!goal) return console.log(`  ${label}: no ${CATEGORY} account goal yet`);
  await run(label, goal.customerConversionGoal.biddable ? [{ customerConversionGoalOperation: { updateMask: 'biddable', update: { resourceName: goalRes, biddable: false } } }] : []);
};

if (action.status !== 'ENABLED' || action.category !== CATEGORY) {
  await run('enable amazon_click as a secondary Outbound click action', [
    { conversionActionOperation: { updateMask: 'status,category,primary_for_goal', update: { resourceName: action.resourceName, status: 'ENABLED', category: CATEGORY, primaryForGoal: false } } },
  ]);
  if (!apply) {
    console.log('  (the remaining steps depend on that one — run with --apply to continue)');
    process.exit(0);
  }
  action = await loadAction();
}
await keepOutOfDefaults('keep Outbound click out of account-default goals');
if (!action.primaryForGoal) {
  await run('make amazon_click primary', [{ conversionActionOperation: { updateMask: 'primary_for_goal', update: { resourceName: action.resourceName, primaryForGoal: true } } }]);
  if (apply) await keepOutOfDefaults('re-check account-default goals');
}

// 2. Brand-site campaigns: campaign-level goal = OUTBOUND_CLICK only.
const campaignGoals = await search(
  cid,
  `SELECT campaign.id, campaign.name, campaign_conversion_goal.resource_name, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.name LIKE 'fbs-${slug}-%' AND campaign.status != 'REMOVED'`
);
const ops = [];
const campaigns = [...new Set(campaignGoals.map((g) => g.campaign.name))];
const isTarget = (g) => g.campaignConversionGoal.category === CATEGORY && g.campaignConversionGoal.origin === ORIGIN;
const missing = campaigns.filter((name) => !campaignGoals.some((g) => g.campaign.name === name && isTarget(g)));
for (const g of campaignGoals) {
  // Never switch a campaign's current goals off before its Outbound click goal
  // exists — that would leave it with no goal at all.
  if (missing.includes(g.campaign.name)) continue;
  const want = isTarget(g);
  if (g.campaignConversionGoal.biddable !== want) ops.push({ campaignConversionGoalOperation: { updateMask: 'biddable', update: { resourceName: g.campaignConversionGoal.resourceName, biddable: want } } });
}
if (missing.length && !apply) console.log(`  campaign goals: the ${CATEGORY} goal appears on campaigns once step 1 is applied — re-run with --apply to set them`);
else if (missing.length) console.log(`  campaign goals: ${CATEGORY} not yet listed on ${missing.join(', ')} — re-run in a minute`);
await run(`campaign goals (${campaigns.join(', ') || 'no fbs campaigns'})`, ops);

// Report: which goals every live campaign bids on.
if (apply) {
  const rows = await search(cid, "SELECT campaign.name, campaign_conversion_goal.category FROM campaign_conversion_goal WHERE campaign.status = 'ENABLED' AND campaign_conversion_goal.biddable = TRUE");
  const by = {};
  for (const row of rows) (by[row.campaign.name] ??= []).push(row.campaignConversionGoal.category);
  for (const [name, cats] of Object.entries(by)) console.log(`  live campaign ${name} bids on: ${cats.join(', ')}`);
}
