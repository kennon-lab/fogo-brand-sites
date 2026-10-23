// Tests for the Tape King funnel Edge Functions and their shared modules. Runs under
// Node's built-in runner with type stripping: `npm run test:functions`. Network is
// mocked — Turnstile siteverify and the PostgREST RPCs are answered by fakeFetch().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipState, normalizeZip, isUsState, US_STATES } from '../_shared/us.ts';
import { addressKeys } from '../_shared/address.ts';
import { pepperedHash, randomToken, readEnv, type Env } from '../_shared/http.ts';
import { handle as claim } from '../tk-claim/handler.ts';
import { handle as scan } from '../tk-scan/handler.ts';

const ORIGIN = 'https://www.tapeking.com';

const env: Env = readEnv(
  (k) =>
    ({
      SUPABASE_URL: 'https://db.test',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
      TK_HASH_PEPPER: 'pepper',
      TURNSTILE_SECRET_KEY: 'ts-secret',
      TURNSTILE_SITE_KEY: 'ts-site',
      TURNSTILE_HOSTNAMES: 'tapeking.com, WWW.tapeking.com',
    })[k]
);

type Call = { url: string; body: any };
type Siteverify = { success: boolean; action?: string; hostname?: string; 'error-codes'?: string[] };
const PASS: Siteverify = { success: true, action: 'tk_claim', hostname: 'www.tapeking.com' };

function fakeFetch(answers: Record<string, unknown>, turnstile: boolean | Siteverify = true) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : raw ? JSON.parse(String(raw)) : null;
    calls.push({ url, body });
    if (url.includes('turnstile')) {
      const verdict = typeof turnstile === 'boolean' ? (turnstile ? PASS : { success: false }) : turnstile;
      return Response.json(verdict);
    }
    const fn = url.split('/rpc/')[1];
    return Response.json(answers[fn] ?? {});
  }) as typeof fetch;
  return calls;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://fn.test/tk-claim', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers },
    body: JSON.stringify(body),
  });

const step1 = {
  action: 'start',
  turnstile_token: 'tok',
  email: '  Pat@Example.COM ',
  first_name: 'Pat',
  use_case: 'shipping_ecommerce',
  monthly_rolls_band: '6_20',
  consent: true,
  consent_version: '2026-10-v1',
  sku_code: 'SC',
  lot: '26a',
  src: 'qr',
  utm: { utm_source: 'tape_core', utm_medium: 'qr', evil: 'x' },
};

// ---------------------------------------------------------------- shared modules

test('zipState maps prefixes, exceptions and unknowns', () => {
  assert.equal(zipState('60601'), 'IL');
  assert.equal(zipState('10001-1234'), 'NY');
  assert.equal(zipState('00501'), 'NY');
  assert.equal(zipState('05501'), 'MA');
  assert.equal(zipState('20101'), 'VA');
  assert.equal(zipState('20500'), 'DC');
  assert.equal(zipState('73301'), 'TX');
  assert.equal(zipState('73101'), 'OK');
  assert.equal(zipState('88510'), 'TX');
  assert.equal(zipState('34001'), null); // military AA
  assert.equal(zipState('00901'), null); // Puerto Rico
  assert.equal(zipState('99501'), 'AK');
  assert.equal(zipState('1234'), null);
  assert.equal(US_STATES.length, 51);
  assert.ok(isUsState('DC') && !isUsState('PR') && !isUsState('XX'));
  assert.equal(normalizeZip(' 606011234 '), '60601-1234');
  assert.equal(normalizeZip('6060'), null);
});

test('addressKeys: the same door typed two ways matches; units split from the street', () => {
  const a = addressKeys({ address1: '123 North Main Street, Apt 4B', zip: '60601' });
  const b = addressKeys({ address1: '123 n. main st', address2: '#4b', zip: '60601-0001' });
  assert.equal(a.addressKey, '123 N MAIN ST #4B|60601');
  assert.equal(a.addressKey, b.addressKey);
  assert.equal(a.streetKey, '123 N MAIN ST|60601');
  const c = addressKeys({ address1: '123 Main St', address2: 'Suite 200', zip: '60601' });
  assert.equal(c.addressKey, '123 MAIN ST #200|60601');
  assert.equal(addressKeys({ address1: 'PO Box 77', zip: '60601' }).addressKey, 'PO BOX 77|60601');
});

test('pepperedHash is stable, purpose-scoped and pepper-dependent; tokens are 43-char base64url', async () => {
  const h1 = await pepperedHash('p', 'ip', '1.2.3.4');
  assert.equal(h1, await pepperedHash('p', 'ip', '1.2.3.4'));
  assert.notEqual(h1, await pepperedHash('p', 'token', '1.2.3.4'));
  assert.notEqual(h1, await pepperedHash('q', 'ip', '1.2.3.4'));
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
});

// ---------------------------------------------------------------- tk-claim

test('GET returns config + site key; unconfigured reports unavailable', async () => {
  fakeFetch({ tk_claim_config: { state: 'open', dispenser: { headline: 'H' }, consent: { version: 'v' } } });
  const res = await claim(new Request('https://fn.test/tk-claim', { headers: { origin: ORIGIN } }), env);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const j = await res.json();
  assert.equal(j.state, 'open');
  assert.equal(j.turnstile_site_key, 'ts-site');

  const bare = await claim(new Request('https://fn.test/tk-claim'), { ...env, turnstileSecret: undefined });
  assert.equal((await bare.json()).state, 'unavailable');
});

test('POST from a foreign origin is refused before anything runs', async () => {
  const calls = fakeFetch({});
  const res = await claim(post(step1, { origin: 'https://evil.example' }), env);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('preview deploys of brand-tape-king are allowed origins', async () => {
  const res = await claim(
    new Request('https://fn.test/tk-claim', {
      method: 'OPTIONS',
      headers: { origin: 'https://brand-tape-king-git-main-kennon.vercel.app' },
    }),
    env
  );
  assert.equal(res.status, 204);
  assert.ok(res.headers.get('access-control-allow-origin'));
});

test('step 1 validates fields before calling Turnstile', async () => {
  const calls = fakeFetch({});
  const res = await claim(post({ ...step1, email: 'nope', use_case: 'hobby', consent: false }), env);
  assert.equal(res.status, 422);
  assert.deepEqual((await res.json()).fields, ['email', 'use_case', 'consent']);
  assert.equal(calls.length, 0);
});

test('step 1 rejects a failed Turnstile check without touching the database', async () => {
  const calls = fakeFetch({}, false);
  const res = await claim(post(step1), env);
  assert.equal((await res.json()).error, 'turnstile');
  assert.ok(calls.every((c) => !c.url.includes('/rpc/')));
});

test('step 1 sends normalized, hashed fields to tk_claim_start and returns the token', async () => {
  const calls = fakeFetch({ tk_claim_start: { result: 'started', claim_id: 'c-1' } });
  const res = await claim(post(step1), env);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.claim_id, 'c-1');
  assert.match(j.token, /^[A-Za-z0-9_-]{43}$/);

  const ts = calls.find((c) => c.url.includes('turnstile'))!;
  assert.equal(ts.body.remoteip, '203.0.113.9');
  const p = calls.find((c) => c.url.endsWith('/rpc/tk_claim_start'))!.body.p;
  assert.equal(p.email, 'pat@example.com');
  assert.equal(p.sku_code, 'sc');
  assert.equal(p.lot, '26a');
  assert.deepEqual(p.utm, { utm_source: 'tape_core', utm_medium: 'qr' });
  assert.equal(p.ip_hash, await pepperedHash('pepper', 'ip', '203.0.113.9'));
  assert.equal(p.token_hash, await pepperedHash('pepper', 'token', j.token));
  assert.equal(p.company, null);
});

test('step 1 passes DB outcomes through as errors', async () => {
  for (const [result, status] of [
    ['already_claimed', 409],
    ['rate_limited', 429],
    ['ended', 409],
    ['paused', 409],
  ] as const) {
    fakeFetch({ tk_claim_start: { result, claim_id: null } });
    const res = await claim(post(step1), env);
    assert.equal(res.status, status);
    assert.equal((await res.json()).error, result);
  }
});

const step2 = {
  action: 'address',
  claim_id: 'c-1',
  token: 'secret-token',
  ship_name: 'Pat Person',
  address1: '123 North Main Street',
  address2: 'Apt 4B',
  city: 'Chicago',
  state: 'wi',
  zip: '60601',
};

test('step 2 hashes the address, flags a ZIP/state mismatch and maps results', async () => {
  const calls = fakeFetch({ tk_claim_address: { result: 'ok' } });
  const res = await claim(post(step2), env);
  assert.equal(res.status, 200);
  const p = calls.find((c) => c.url.endsWith('/rpc/tk_claim_address'))!.body.p;
  assert.equal(p.state, 'WI');
  assert.deepEqual(p.flags, ['zip_state_mismatch']);
  assert.equal(p.address_hash, await pepperedHash('pepper', 'address', '123 N MAIN ST #4B|60601'));
  assert.equal(p.street_hash, await pepperedHash('pepper', 'street', '123 N MAIN ST|60601'));
  assert.equal(p.token_hash, await pepperedHash('pepper', 'token', 'secret-token'));

  fakeFetch({ tk_claim_address: { result: 'invalid' } });
  assert.equal((await (await claim(post(step2), env)).json()).error, 'expired');
  fakeFetch({ tk_claim_address: { result: 'already_claimed' } });
  assert.equal((await (await claim(post(step2), env)).json()).error, 'already_claimed');
});

test('step 2 refuses outside-US and bad fields without calling the database', async () => {
  const calls = fakeFetch({});
  assert.equal((await (await claim(post({ ...step2, state: 'XX' }), env)).json()).error, 'outside_us');
  const bad = await (await claim(post({ ...step2, state: 'PR', zip: '9', city: '' }), env)).json();
  assert.deepEqual(bad.fields, ['city', 'state', 'zip']);
  assert.equal(calls.length, 0);
});

test('a database error becomes a generic server error', async () => {
  globalThis.fetch = (async (input: string) =>
    String(input).includes('turnstile')
      ? Response.json(PASS)
      : new Response('boom', { status: 500 })) as typeof fetch;
  const res = await claim(post(step1), env);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'server');
});

test('Turnstile: replayed token, wrong action, wrong hostname and outages are all refused', async () => {
  const cases: [string, Siteverify | 'outage'][] = [
    ['replay', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
    ['wrong action', { ...PASS, action: 'signup' }],
    ['missing action', { success: true, hostname: 'www.tapeking.com' }],
    ['wrong hostname', { ...PASS, hostname: 'evil.example' }],
    ['localhost', { ...PASS, hostname: 'localhost' }],
    ['outage', 'outage'],
  ];
  for (const [label, verdict] of cases) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      calls.push(String(input));
      if (String(input).includes('turnstile')) {
        return verdict === 'outage' ? new Response('down', { status: 503 }) : Response.json(verdict);
      }
      return Response.json({ result: 'started', claim_id: 'c-1' });
    }) as typeof fetch;
    const res = await claim(post(step1), env);
    assert.equal(res.status, 403, label);
    assert.equal((await res.json()).error, 'turnstile', label);
    assert.ok(calls.every((u) => !u.includes('/rpc/')), `${label}: no database call`);
  }
  // Apex host is allowed too (case-insensitive list).
  fakeFetch({ tk_claim_start: { result: 'started', claim_id: 'c-1' } }, { ...PASS, hostname: 'tapeking.com' });
  assert.equal((await claim(post(step1), env)).status, 200);
});

test('no TURNSTILE_HOSTNAMES → unavailable (fails closed)', async () => {
  const noHosts = { ...env, turnstileHostnames: [] };
  fakeFetch({ tk_claim_config: { state: 'open' } });
  const get = await claim(new Request('https://fn.test/tk-claim', { headers: { origin: ORIGIN } }), noHosts);
  assert.equal((await get.json()).state, 'unavailable');
  const res = await claim(post(step1), noHosts);
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------- tk-scan

test('tk-scan logs a beacon scan with a hashed IP and answers 204', async () => {
  const calls = fakeFetch({ tk_log_scan: { result: 'ok' } });
  const res = await scan(
    new Request('https://fn.test/tk-scan', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Phone' },
      body: JSON.stringify({ code: 'UT', lot: '26A' }),
    }),
    env
  );
  assert.equal(res.status, 204);
  const p = calls[0].body.p;
  assert.deepEqual(
    { sku_code: p.sku_code, lot: p.lot, user_agent: p.user_agent },
    { sku_code: 'ut', lot: '26a', user_agent: 'Phone' }
  );
  assert.equal(p.ip_hash, await pepperedHash('pepper', 'ip', '198.51.100.7'));
});

test('tk-scan refuses foreign origins and logs junk codes as invalid', async () => {
  let calls = fakeFetch({});
  const res = await scan(
    new Request('https://fn.test/tk-scan', { method: 'POST', headers: { origin: 'https://x.example' }, body: '{}' }),
    env
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
  calls = fakeFetch({ tk_log_scan: { result: 'ok' } });
  await scan(
    new Request('https://fn.test/tk-scan', { method: 'POST', headers: { origin: ORIGIN }, body: '{"code":"<script>"}' }),
    env
  );
  assert.equal(calls[0].body.p.sku_code, 'invalid');
});
