// Review gate for Google Ads campaign specs — the standard step between
// `ads:campaigns` (generate) and `ads:push` (create / sync / enable). Checks a
// spec against the live Google Ads account, the live site, our data and the
// other specs of the brand, prints a report, and records the result in the
// spec under `review` ({date, hash, status, errors, warnings}). ads-push.mjs
// refuses to create, sync or enable a campaign whose review failed or whose
// content changed since it was reviewed (spec hash).
//
// Usage:
//   node scripts/ads-review.mjs --spec=ads/<brand>/<post>.json
//   node scripts/ads-review.mjs --brand=<slug>          (every spec of the brand)
//   npm run ads:review -- --brand=otis-classic
//
// Errors (block push): account not under the manager; a keyword live in
// another campaign of the account or in another spec of the brand; a negative
// that blocks one of our keywords; policy-risk keywords; ad copy over limits /
// non-ASCII / editorial issues; landing page or sitelink URL not 200 or
// without Amazon CTAs; no active google_ads Attribution tag for the primary
// ASIN; Google's own validate-only check failing.
// Warnings (need --ack-warnings to enable): no GA4 on the brand / no
// amazon_click conversion in the account (Google Ads can't see results);
// other advertisers' campaigns live in the account; account CPCs above our
// ceiling on the same searches; identical ad copy across ad groups; fewer than
// two sitelinks; policy-sensitive or trademark words in ad copy; ads not yet
// approved.
//
// Env (.env): GOOGLE_ADS_* (see ads-push.mjs), SUPABASE_URL, SUPABASE_ANON_KEY.
import process from 'node:process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { adsEnv, search, managedAccounts, liveKeywords, liveCampaigns, conversionActions, digits } from './lib/google-ads.mjs';
import { keywordKey, policyRisk, negativeConflicts, specHash } from './lib/ads-spec.mjs';
import { validateAd } from './lib/ads-copy.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const OUT_DIR = arg('out') ?? 'ads';
const specArg = arg('spec');
const brandArg = arg('brand');
if (!specArg && !brandArg) {
  console.error('Pass --spec=ads/<brand>/<post>.json or --brand=<slug>.');
  process.exit(1);
}
const specFiles = specArg
  ? [specArg]
  : readdirSync(join(OUT_DIR, brandArg))
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(OUT_DIR, brandArg, f));

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function rest(pathAndQuery) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}limit=10000`;
  const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` } });
  if (!r.ok) throw new Error(`GET ${pathAndQuery} → ${r.status} ${await r.text()}`);
  return r.json();
}

// Per-account lookups are shared by every spec of the run.
const accountCache = new Map();
async function account(customerId) {
  if (!accountCache.has(customerId)) {
    accountCache.set(
      customerId,
      (async () => {
        const [keywords, campaigns, conversions, cpcs] = await Promise.all([
          liveKeywords(customerId),
          liveCampaigns(customerId),
          conversionActions(customerId),
          search(
            customerId,
            'SELECT search_term_view.search_term, metrics.clicks, metrics.average_cpc FROM search_term_view WHERE segments.date DURING LAST_30_DAYS AND metrics.clicks > 0'
          ),
        ]);
        return { keywords, campaigns, conversions, cpcs: cpcs.map((r) => ({ term: r.searchTermView.searchTerm, clicks: Number(r.metrics.clicks), cpc: Number(r.metrics.averageCpc ?? 0) / 1e6 })) };
      })()
    );
  }
  return accountCache.get(customerId);
}

let managers = null;
const pageCache = new Map();
function fetchPage(url) {
  if (!pageCache.has(url)) {
    pageCache.set(
      url,
      fetch(url, { redirect: 'follow' })
        .then(async (r) => ({ status: r.status, html: await r.text() }))
        .catch((err) => ({ status: 0, html: '', error: err.message }))
    );
  }
  return pageCache.get(url);
}

async function review(file) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);
  const customerId = digits(spec.google?.customer_id);
  const keywords = spec.ad_groups.flatMap((g) => g.keywords.map((k) => ({ ...k, group: g.name })));
  const ownKeys = new Map(keywords.map((k) => [keywordKey(k.text), k]));
  const googleReady = adsEnv().missing.length === 0;

  // ---- Account ------------------------------------------------------------------
  let acct = null;
  if (!customerId) E('no Google Ads customer id (brand_sites.google_ads_customer_id) — regenerate after setting it');
  else if (!googleReady) E(`cannot check Google Ads: missing ${adsEnv().missing.join(', ')}`);
  else {
    managers ??= await managedAccounts();
    if (!managers.some((m) => String(m.id) === customerId)) E(`account ${customerId} is not linked under the manager account — accept the link in Google Ads first`);
    else {
      acct = await account(customerId);
      // Overlap with campaigns already running in the account.
      const own = spec.campaign.name;
      const clashes = acct.keywords.filter((k) => k.campaign !== own && ownKeys.has(keywordKey(k.text)));
      for (const k of clashes) E(`keyword "${ownKeys.get(keywordKey(k.text)).text}" is live in campaign "${k.campaign}" — same account, same query; drop it (regenerate) or coordinate with that campaign's owner`);
      const others = acct.campaigns.filter((c) => !c.name.startsWith('fbs-'));
      if (others.length) W(`${others.length} other campaign(s) live in this account (${others.map((c) => c.name).join(', ')}) — confirm with their owner (e.g. the agency) before launching`);
      // Conversion measurement.
      if (!acct.conversions.some((c) => /amazon_click/i.test(c.name))) W('no amazon_click conversion action in the account — this campaign will report 0 conversions in Google Ads and cannot move past maximize-clicks bidding; import GA4 amazon_click');
      // CPC reality check on the same searches.
      const same = acct.cpcs.filter((r) => ownKeys.has(keywordKey(r.term)) && r.clicks >= 5);
      const pricey = same.filter((r) => r.cpc > spec.campaign.bidding.cpc_ceiling_usd);
      if (pricey.length) W(`the account pays more than our $${spec.campaign.bidding.cpc_ceiling_usd} CPC ceiling on: ${pricey.map((r) => `"${r.term}" $${r.cpc.toFixed(2)}`).join(', ')} — expect low impression share there`);
      // Pushed campaign: ad approval.
      if (spec.google?.campaign) {
        const rows = await search(
          customerId,
          `SELECT campaign.id, ad_group.name, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.id = ${spec.google.campaign.split('/').pop()} AND ad_group_ad.status = 'ENABLED'`
        );
        const pending = rows.filter((r) => !['APPROVED', 'APPROVED_LIMITED'].includes(r.adGroupAd.policySummary?.approvalStatus));
        if (pending.length) W(`ads not approved yet: ${pending.map((r) => `${r.adGroup.name} ${r.adGroupAd.policySummary?.approvalStatus ?? 'UNKNOWN'}`).join(', ')} (enable is blocked until they are)`);
      }
    }
  }

  // ---- Other specs of the brand -----------------------------------------------------
  const dir = join(OUT_DIR, spec.brand.slug);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const other = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (other.campaign?.name === spec.campaign.name) continue;
    const shared = other.ad_groups.flatMap((g) => g.keywords).filter((k) => ownKeys.has(keywordKey(k.text)));
    const texts = [...new Set(shared.map((k) => k.text))];
    if (texts.length) E(`${texts.length} keyword(s) also in ${f}: ${texts.join(', ')} — regenerate the brand so each keyword belongs to one post`);
  }

  // ---- Keywords, negatives, copy -----------------------------------------------------
  for (const k of keywords) {
    const risk = policyRisk(k.text);
    if (risk) E(`${k.group} keyword "${k.text}" has policy-risk term "${risk}"`);
  }
  for (const c of negativeConflicts(spec.campaign.negatives, keywords)) E(`negative "${c.negative}" blocks our keyword "${c.keyword}"`);
  const adKeys = new Set();
  for (const g of spec.ad_groups) {
    for (const p of validateAd(g.ad)) E(`${g.name} ${p.where} "${p.text}": ${p.issues.join(', ')}`);
    for (const line of [...g.ad.headlines, ...g.ad.descriptions]) {
      const risk = policyRisk(line);
      if (risk) W(`${g.name} ad copy mentions "${risk}" ("${line}") — policy-sensitive; watch the ad review`);
    }
    if ([...g.ad.headlines, ...(g.ad.callouts ?? [])].some((t) => /\bamazon\b/i.test(t))) W(`${g.name} ad copy names Amazon ("Sold on Amazon", …) — trademark use Google may limit; drop those lines if the ad is flagged`);
    adKeys.add(JSON.stringify([g.ad.headlines, g.ad.descriptions]));
  }
  if (spec.ad_groups.length > 1 && adKeys.size < spec.ad_groups.length) W('two ad groups carry identical ad copy — each should speak to its own searchers');
  const sitelinks = spec.ad_groups[0]?.ad?.sitelinks ?? [];
  if (sitelinks.length < 2) W(`${sitelinks.length} sitelink(s) — Google shows sitelinks only when a campaign has at least 2`);

  // ---- Site + attribution ---------------------------------------------------------------
  const finalUrls = [...new Set(spec.ad_groups.map((g) => g.ad.final_url))];
  for (const url of finalUrls) {
    const page = await fetchPage(url);
    if (page.status !== 200) E(`landing page ${url} returned ${page.status || page.error}`);
    else if (!page.html.includes('data-amazon-cta')) E(`landing page ${url} has no Amazon CTAs (data-amazon-cta)`);
  }
  for (const s of sitelinks) {
    const page = await fetchPage(s.url);
    if (page.status !== 200) E(`sitelink "${s.text}" → ${s.url} returned ${page.status || page.error}`);
  }
  const brandRow = (await rest(`brand_sites?slug=eq.${encodeURIComponent(spec.brand.slug)}&select=google_analytics_id`))[0];
  if (!brandRow?.google_analytics_id) W('brand has no google_analytics_id — no GA4 on the site, so no amazon_click events to import as conversions');
  const primary = spec.source?.primary_asin;
  if (primary) {
    const tags = await rest(`brand_site_paid_links?brand_slug=eq.${encodeURIComponent(spec.brand.slug)}&channel=eq.google_ads&asin=eq.${primary}&select=asin`);
    if (tags.length === 0) E(`no active google_ads Attribution tag for primary ASIN ${primary} — run npm run attribution-tags -- --brand=${spec.brand.slug} --channel=google_ads and rebuild`);
  } else W('spec has no source.primary_asin — regenerate to record it');

  // ---- Google's own validation ------------------------------------------------------------
  if (customerId && googleReady && errors.length === 0) {
    const args = ['scripts/ads-push.mjs', `--spec=${file}`, '--validate-only', ...(spec.google?.campaign ? ['--sync'] : [])];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (run.status !== 0) E(`Google validate-only failed:\n${(run.stderr || run.stdout).trim().split('\n').map((l) => `      ${l}`).join('\n')}`);
  }

  const status = errors.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  // Re-read before writing: the validate-only child never writes, but keep
  // whatever is on disk authoritative.
  const current = JSON.parse(readFileSync(file, 'utf8'));
  current.review = { date: localDate(), hash: specHash(current), status, errors, warnings };
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  return { file, name: spec.campaign.name, status, errors, warnings };
}

let failed = 0;
for (const file of specFiles) {
  const r = await review(file);
  console.log(`\n${r.status.toUpperCase().padEnd(4)} ${r.name}  (${r.file})`);
  for (const e of r.errors) console.log(`  ERROR ${e}`);
  for (const w of r.warnings) console.log(`  warn  ${w}`);
  if (r.status === 'fail') failed++;
}
console.log(`\n${specFiles.length} spec(s) reviewed, ${failed} failed. Results recorded under "review" in each spec.`);
process.exit(failed > 0 ? 1 : 0);
