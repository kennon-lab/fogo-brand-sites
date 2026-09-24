// Shared helpers for the email-capture Vercel Functions (api/*.js).
// Server-only: holds the Supabase secret key and the Postmark server token.
// Nothing here is bundled into the static site.
import { createHash, randomBytes } from 'node:crypto';
import { hasEmails, loadSequences, loadStep, loadDefaults, renderEmail } from '../../scripts/lib/email-render.mjs';

export const ENV = {
  supabaseUrl: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  postmarkToken: process.env.POSTMARK_SERVER_TOKEN,
  pepper: process.env.EMAIL_TOKEN_PEPPER,
  brandSlug: process.env.BRAND_SLUG,
};

export function missingEnv() {
  return Object.entries(ENV)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => sha256(`${ENV.pepper}:${token}`);
export const ipHash = (ip) => (ip ? sha256(`${ENV.pepper}:ip:${ip}`) : null);

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
}

async function supabase(path, init = {}) {
  const res = await fetch(`${ENV.supabaseUrl}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: ENV.serviceKey,
      Authorization: `Bearer ${ENV.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

export const rpc = (name, args) => supabase(`rpc/${name}`, { method: 'POST', body: args });
export const supabaseGet = (path) => supabase(path);

let brandCache = null;
const BRAND_TTL_MS = 5 * 60 * 1000;
/** The brand_sites row for BRAND_SLUG, cached 5 min per instance so flipping
 *  email_enabled in the database takes effect without a redeploy. */
export function getBrand() {
  if (brandCache && Date.now() - brandCache.at < BRAND_TTL_MS) return brandCache.promise;
  const promise = supabase(`brand_sites?slug=eq.${encodeURIComponent(ENV.brandSlug)}&limit=1`).then((rows) => {
    if (!rows[0]) throw new Error(`brand ${ENV.brandSlug} not found`);
    return rows[0];
  });
  brandCache = { at: Date.now(), promise };
  promise.catch(() => {
    brandCache = null;
  });
  return promise;
}

/** Live flag, or EMAIL_FORCE_ENABLE=1 (set on the Vercel Preview environment for testing). */
export const emailEnabled = (brand) => Boolean(brand.email_enabled) || process.env.EMAIL_FORCE_ENABLE === '1';

export const siteOrigin = (brand) => `https://www.${brand.domain.replace(/^www\./, '')}`;

/** Origin for links in outgoing mail: the live site, except on a Vercel preview
 *  deploy, where links must come back to the preview so it can be tested. */
export function linkOrigin(brand, req) {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (process.env.VERCEL_ENV === 'preview' && host) return `https://${String(host).split(',')[0].trim()}`;
  return siteOrigin(brand);
}

let contentCache;
/** sequences.yaml + email-defaults.yaml for this brand, or null if the brand has no emails. */
export function getContent() {
  if (contentCache !== undefined) return contentCache;
  contentCache = hasEmails(ENV.brandSlug) ? { seq: loadSequences(ENV.brandSlug), defaults: loadDefaults() } : null;
  return contentCache;
}

/** Lead-magnet placeholder values for a track ({{lead_magnet_url}}, {{lead_magnet_title}}, …). */
export function leadMagnetVars(seq, track, origin) {
  const keys = seq.tracks[track]?.lead_magnets ?? [];
  const vars = {};
  for (const [k, lm] of Object.entries(seq.lead_magnets ?? {})) vars[`lead_magnet_url:${k}`] = origin + lm.path;
  if (keys[0]) vars.lead_magnet_url = origin + seq.lead_magnets[keys[0]].path;
  vars.lead_magnet_title = keys.length === 1 ? seq.lead_magnets[keys[0]].title : 'free kitchen guides';
  return vars;
}

// trackLinks: 'None' for transactional mail; the drip passes 'HtmlOnly' so
// click rates (a scope §2 metric) are measurable. Opens stay off: Apple Mail
// Privacy Protection makes them meaningless.
export async function postmarkSend({ from, to, replyTo, subject, html, text, stream, tag, metadata, trackLinks = 'None' }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': ENV.postmarkToken,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      ReplyTo: replyTo || undefined,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: stream,
      Tag: tag,
      Metadata: metadata,
      TrackOpens: false,
      TrackLinks: trackLinks,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ErrorCode) throw new Error(`postmark ${res.status} ${json.ErrorCode ?? ''} ${json.Message ?? ''}`);
  return json.MessageID;
}

/** Lifts Postmark's suppression on a stream after someone who unsubscribed
 *  signs up and confirms again. Postmark refuses for spam complaints; that's
 *  logged and the address simply stays suppressed. */
export async function postmarkUnsuppress(stream, email) {
  const res = await fetch(`https://api.postmarkapp.com/message-streams/${encodeURIComponent(stream)}/suppressions/delete`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': ENV.postmarkToken },
    body: JSON.stringify({ Suppressions: [{ EmailAddress: email }] }),
  });
  const json = await res.json().catch(() => ({}));
  const status = json.Suppressions?.[0]?.Status;
  if (!res.ok || (status && status !== 'Deleted')) {
    console.warn('[unsuppress]', res.status, status, json.Suppressions?.[0]?.Message ?? json.Message ?? '');
    return false;
  }
  return true;
}

/** "Otis Classic <hello@otisclassic.com>" from the brand row + sequences.yaml. */
export function fromAddress(brand, seq) {
  const name = brand.email_from_name || seq.from_name || brand.brand;
  const addr = brand.email_from_address || `${seq.from_local || 'hello'}@${brand.domain.replace(/^www\./, '')}`;
  return `"${name.replace(/"/g, '')}" <${addr}>`;
}

export { loadStep, renderEmail };
