// Google Ads REST helpers shared by ads-push, ads-review, ads-campaigns and
// ads-auth: OAuth refresh, GAQL search (paged), mutate, and the queries the
// scripts need about an account (live keywords, conversion actions, …).
//
// Env (.env): GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
// GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID;
// optional GOOGLE_ADS_API_VERSION (default v25), GOOGLE_ADS_API_BASE.
import process from 'node:process';

const API_VERSION = () => process.env.GOOGLE_ADS_API_VERSION ?? 'v25';
const API_BASE = () => process.env.GOOGLE_ADS_API_BASE ?? 'https://googleads.googleapis.com';
const OAUTH_TOKEN_URL = () => process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

export const digits = (id) => String(id ?? '').replace(/-/g, '');

/** Credentials from env; `missing` lists unset variables (empty = usable). */
export function adsEnv() {
  const env = {
    devToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    loginCustomerId: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  };
  const names = {
    devToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
    clientId: 'GOOGLE_ADS_CLIENT_ID',
    clientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
    refreshToken: 'GOOGLE_ADS_REFRESH_TOKEN',
    loginCustomerId: 'GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  };
  return { ...env, missing: Object.keys(names).filter((k) => !env[k]).map((k) => names[k]) };
}

let cachedToken = null;
async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const env = adsEnv();
  const r = await fetch(OAUTH_TOKEN_URL(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.refreshToken ?? '', client_id: env.clientId ?? '', client_secret: env.clientSecret ?? '' }),
  });
  if (!r.ok) throw new Error(`OAuth token refresh ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  cachedToken = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return cachedToken.value;
}

async function call(path, body) {
  const env = adsEnv();
  const r = await fetch(`${API_BASE()}/${API_VERSION()}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'developer-token': env.devToken,
      'login-customer-id': env.loginCustomerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`${path.split('/').pop()} ${r.status}\n${text.slice(0, 4000)}`);
    try {
      err.failure = JSON.parse(text).error;
    } catch {
      // non-JSON error body
    }
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/** GAQL search, all pages. */
export async function search(customerId, query) {
  const rows = [];
  let pageToken;
  do {
    const j = await call(`customers/${digits(customerId)}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
    rows.push(...(j.results ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return rows;
}

/** One atomic googleAds:mutate. */
export function mutate(customerId, operations, { validate = false } = {}) {
  return call(`customers/${digits(customerId)}/googleAds:mutate`, { mutateOperations: operations, partialFailure: false, validateOnly: validate });
}

/** Client accounts under the login (manager) customer. */
export async function managedAccounts() {
  const rows = await search(
    adsEnv().loginCustomerId,
    'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level, customer_client.currency_code FROM customer_client'
  );
  return rows.map((x) => x.customerClient);
}

/** Positive keywords in ENABLED ad groups of ENABLED campaigns: [{campaign, adGroup, text, match}]. */
export async function liveKeywords(customerId) {
  const rows = await search(
    customerId,
    "SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.type = KEYWORD AND ad_group_criterion.negative = FALSE"
  );
  return rows.map((x) => ({ campaign: x.campaign.name, adGroup: x.adGroup.name, text: x.adGroupCriterion.keyword.text, match: x.adGroupCriterion.keyword.matchType }));
}

/** ENABLED campaigns: [{id, name, channel}]. */
export async function liveCampaigns(customerId) {
  const rows = await search(customerId, "SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.status = 'ENABLED'");
  return rows.map((x) => ({ id: x.campaign.id, name: x.campaign.name, channel: x.campaign.advertisingChannelType }));
}

/** ENABLED conversion actions: [{name, type, category, primary}]. */
export async function conversionActions(customerId) {
  const rows = await search(
    customerId,
    "SELECT conversion_action.name, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status = 'ENABLED'"
  );
  return rows.map((x) => ({ name: x.conversionAction.name, type: x.conversionAction.type, category: x.conversionAction.category, primary: x.conversionAction.primaryForGoal }));
}

/** Google's field-level error messages from a failed call, one line each. */
export function failureLines(err) {
  const errors = err?.failure?.details?.flatMap((d) => d.errors ?? []) ?? [];
  if (errors.length === 0) return [String(err?.message ?? err).split('\n')[0]];
  return errors.map((e) => {
    const where = (e.location?.fieldPathElements ?? []).map((f) => f.fieldName + (f.index != null ? `[${f.index}]` : '')).join('.');
    const evidence = e.details?.policyFindingDetails?.policyTopicEntries
      ?.map((t) => `${t.topic}${t.evidences?.length ? ` (${t.evidences.flatMap((v) => v.textList?.texts ?? []).join(', ')})` : ''}`)
      .join('; ');
    return `${Object.values(e.errorCode ?? {})[0] ?? 'ERROR'}: ${e.message}${evidence ? ` — ${evidence}` : ''}${where ? ` @ ${where}` : ''}`;
  });
}
