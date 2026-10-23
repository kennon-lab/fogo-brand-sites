// tk-claim — the Tape King free-dispenser claim API (TAPEKING_DISPENSER_FUNNEL_SCOPE.md,
// "Landing page spec" + "Anti-abuse"). Called by www.tapeking.com/claim/.
//
//   GET                       → { ok, state, dispenser, consent, turnstile_site_key }
//   POST { action: 'start' }  → step 1: Turnstile check, validation, then
//                               public.tk_claim_start (dedupe by email, per-IP rate
//                               limit, cap / kill switch, segment, Flow B enrollment).
//                               Returns { ok, claim_id, token } — the token authorizes step 2.
//   POST { action: 'address' }→ step 2: validation, address normalization + hashes,
//                               ZIP/state flag, then public.tk_claim_address (address
//                               dedupe, review flags, status, Flow A + D enrollment).
//
// Errors are { ok: false, error } with error one of: invalid (+ fields), turnstile,
// already_claimed (never says which field matched), ended, paused, rate_limited,
// outside_us, expired (step-2 token unknown — start again), unavailable, server.
// Every DB write goes through the public.tk_* RPCs (service role); the browser never
// sees a key. Fails closed: without TK_HASH_PEPPER, the Turnstile keys and
// TURNSTILE_HOSTNAMES the GET reports state "unavailable" and POSTs are refused.
import {
  type Env,
  clientIp,
  corsHeaders,
  json,
  originAllowed,
  pepperedHash,
  randomToken,
  readJson,
  rpc,
  str,
} from '../_shared/http.ts';
import {
  CODE_RE,
  EMAIL_RE,
  LIMITS,
  LOT_RE,
  PURCHASE_CHANNELS,
  SRC_VALUES,
  USE_CASES,
  UTM_KEYS,
  VOLUME_BANDS,
  isOption,
} from '../_shared/claim-fields.ts';
import { OUTSIDE_US, isUsState, normalizeZip, zipState } from '../_shared/us.ts';
import { addressKeys } from '../_shared/address.ts';

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_ACTION = 'tk_claim';

type Body = Record<string, unknown>;

const configured = (env: Env) =>
  Boolean(
    env.supabaseUrl &&
      env.serviceKey &&
      env.pepper &&
      env.turnstileSecret &&
      env.turnstileSiteKey &&
      env.turnstileHostnames.length > 0
  );

// Canonical siteverify (Cloudflare Turnstile "Spin" contract): the token must come back
// success, with our widget action, from a page on one of TURNSTILE_HOSTNAMES. Tokens are
// single-use, so a replayed token fails here. A siteverify outage refuses the claim.
async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<boolean> {
  if (!token || token.length > 2048 || env.turnstileHostnames.length === 0) return false;
  const form = new URLSearchParams({ secret: env.turnstileSecret!, response: token });
  if (ip) form.set('remoteip', ip);
  let out: { success?: boolean; action?: string; hostname?: string };
  try {
    const res = await fetch(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: form,
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    out = await res.json();
  } catch (err) {
    console.error('[tk-claim] siteverify', err instanceof Error ? err.message : err);
    return false;
  }
  return (
    out.success === true &&
    out.action === TURNSTILE_ACTION &&
    env.turnstileHostnames.includes(String(out.hostname ?? '').toLowerCase())
  );
}

function attribution(b: Body) {
  const code = str(b.sku_code, 24).toLowerCase();
  const lot = str(b.lot, 16).toLowerCase();
  const src = str(b.src, 12).toLowerCase();
  const utm: Record<string, string> = {};
  const raw = b.utm && typeof b.utm === 'object' ? (b.utm as Record<string, unknown>) : {};
  for (const k of UTM_KEYS) {
    const v = str(raw[k], 100);
    if (v) utm[k] = v.slice(0, 100);
  }
  return {
    sku_code: CODE_RE.test(code) ? code : null,
    lot: LOT_RE.test(lot) ? lot : null,
    src: SRC_VALUES.includes(src) ? src : 'direct',
    utm,
  };
}

async function start(env: Env, b: Body, req: Request, ip: string | null) {
  const email = str(b.email, LIMITS.email).toLowerCase();
  const firstName = str(b.first_name, LIMITS.first_name);
  const company = str(b.company, LIMITS.company);
  const fields: string[] = [];
  if (!EMAIL_RE.test(email) || email.length > LIMITS.email) fields.push('email');
  if (!firstName || firstName.length > LIMITS.first_name) fields.push('first_name');
  if (company.length > LIMITS.company) fields.push('company');
  if (!isOption(USE_CASES, b.use_case)) fields.push('use_case');
  if (!isOption(VOLUME_BANDS, b.monthly_rolls_band)) fields.push('monthly_rolls_band');
  if (b.purchase_channel && !isOption(PURCHASE_CHANNELS, b.purchase_channel)) fields.push('purchase_channel');
  const consentVersion = str(b.consent_version, 40);
  if (b.consent !== true || !consentVersion) fields.push('consent');
  if (fields.length) return json({ ok: false, error: 'invalid', fields }, 422);

  if (!(await verifyTurnstile(env, str(b.turnstile_token, 2048), ip))) {
    return json({ ok: false, error: 'turnstile' }, 403);
  }

  const token = randomToken();
  const out = await rpc<{ result: string; claim_id: string | null }>(env, 'tk_claim_start', {
    email,
    first_name: firstName,
    company: company || null,
    use_case: b.use_case,
    monthly_rolls_band: b.monthly_rolls_band,
    purchase_channel: b.purchase_channel || null,
    consent_text_version: consentVersion,
    ...attribution(b),
    ip_hash: ip ? await pepperedHash(env.pepper, 'ip', ip) : null,
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    token_hash: await pepperedHash(env.pepper, 'token', token),
  });
  if (out.result === 'started' || out.result === 'resumed') {
    return json({ ok: true, result: out.result, claim_id: out.claim_id, token }, 200);
  }
  return json({ ok: false, error: out.result }, out.result === 'rate_limited' ? 429 : 409);
}

async function address(env: Env, b: Body, ip: string | null) {
  const claimId = str(b.claim_id, 40);
  const token = str(b.token, 100);
  if (!claimId || !token) return json({ ok: false, error: 'expired' }, 409);

  const state = str(b.state, 2).toUpperCase();
  if (state === OUTSIDE_US) return json({ ok: false, error: 'outside_us' }, 422);
  const shipName = str(b.ship_name, LIMITS.ship_name);
  const address1 = str(b.address1, LIMITS.address1);
  const address2 = str(b.address2, LIMITS.address2);
  const city = str(b.city, LIMITS.city);
  const zip = normalizeZip(str(b.zip, 10));
  const fields: string[] = [];
  if (!shipName || shipName.length > LIMITS.ship_name) fields.push('ship_name');
  if (!address1 || address1.length > LIMITS.address1) fields.push('address1');
  if (address2.length > LIMITS.address2) fields.push('address2');
  if (!city || city.length > LIMITS.city) fields.push('city');
  if (!isUsState(state)) fields.push('state');
  if (!zip) fields.push('zip');
  if (fields.length) return json({ ok: false, error: 'invalid', fields }, 422);

  const keys = addressKeys({ address1, address2, zip: zip! });
  const zs = zipState(zip!);
  const flags = zs && zs !== state ? ['zip_state_mismatch'] : [];
  const out = await rpc<{ result: string }>(env, 'tk_claim_address', {
    claim_id: claimId,
    token_hash: await pepperedHash(env.pepper, 'token', token),
    ship_name: shipName,
    address1,
    address2: address2 || null,
    city,
    state,
    zip,
    address_hash: await pepperedHash(env.pepper, 'address', keys.addressKey),
    street_hash: await pepperedHash(env.pepper, 'street', keys.streetKey),
    flags,
    ip_hash: ip ? await pepperedHash(env.pepper, 'ip', ip) : null,
  });
  if (out.result === 'ok') return json({ ok: true }, 200);
  if (out.result === 'invalid') return json({ ok: false, error: 'expired' }, 409);
  return json({ ok: false, error: out.result }, out.result === 'rate_limited' ? 429 : 409);
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, req);
  const withCors = (res: Response) => {
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };
  if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

  try {
    if (req.method === 'GET') {
      if (!configured(env)) return withCors(json({ ok: true, state: 'unavailable' }, 200));
      const cfg = await rpc<{ state: string; dispenser: unknown; consent: unknown }>(env, 'tk_claim_config');
      return withCors(json({ ok: true, ...cfg, turnstile_site_key: env.turnstileSiteKey }, 200));
    }
    if (req.method !== 'POST') return withCors(json({ ok: false, error: 'method' }, 405));
    // The Origin check keeps other sites from posting through visitors' browsers;
    // Turnstile is what stops scripts.
    if (!originAllowed(env, req.headers.get('origin'))) return json({ ok: false, error: 'origin' }, 403);
    if (!configured(env)) return withCors(json({ ok: false, error: 'unavailable' }, 503));

    const body = await readJson(req);
    if (!body) return withCors(json({ ok: false, error: 'invalid', fields: [] }, 400));
    const ip = clientIp(req);
    if (body.action === 'start') return withCors(await start(env, body, req, ip));
    if (body.action === 'address') return withCors(await address(env, body, ip));
    return withCors(json({ ok: false, error: 'invalid', fields: ['action'] }, 400));
  } catch (err) {
    console.error('[tk-claim]', err instanceof Error ? err.message : err);
    return withCors(json({ ok: false, error: 'server' }, 500));
  }
}
