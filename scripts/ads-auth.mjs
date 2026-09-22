// One-time OAuth for the Google Ads API: runs the installed-app (loopback)
// consent flow for the Desktop OAuth client in .env and writes the refresh
// token back into .env as GOOGLE_ADS_REFRESH_TOKEN, so the token never has to
// be copied by hand. Sign in as a user with access to the FOGO manager account.
//
// Usage:
//   npm run ads:auth                 consent in the browser → refresh token into .env
//   npm run ads:auth -- --accounts   list the client accounts under the manager
//                                    (ids for brand_sites.google_ads_customer_id)
//
// Env (.env): GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET (Desktop-app client),
// plus GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_LOGIN_CUSTOMER_ID for --accounts.
import process from 'node:process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { adsEnv, managedAccounts } from './lib/google-ads.mjs';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET (Desktop-app OAuth client) in .env first.');
  process.exit(1);
}

function setEnvVar(name, value) {
  let text = '';
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    // new file
  }
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync('.env', text);
}

async function listAccounts() {
  const missing = adsEnv().missing;
  if (missing.length) {
    console.error(`--accounts needs ${missing.join(', ')}.`);
    process.exit(1);
  }
  for (const c of await managedAccounts()) {
    console.log(`${String(c.id).padEnd(12)} ${c.manager ? 'MANAGER' : 'client '} ${String(c.status).padEnd(10)} ${c.currencyCode ?? ''}  ${c.descriptiveName ?? ''}`);
  }
}

async function consent() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const url = `${OAUTH_AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  console.log('Open this URL, sign in with a user on the FOGO manager account and allow access:\n');
  console.log(url);
  console.log('\nWaiting for the redirect…');
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], { stdio: 'ignore', detached: true }).unref();

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirectUri).searchParams;
      if (!q.get('code') && !q.get('error')) {
        res.writeHead(404).end();
        return;
      }
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(200, { 'content-type': 'text/plain' }).end(ok ? 'Google Ads authorized — you can close this tab.' : `Authorization failed: ${q.get('error') ?? 'state mismatch'}`);
      server.close();
      ok ? resolve(q.get('code')) : reject(new Error(`authorization failed: ${q.get('error') ?? 'state mismatch'}`));
    });
  });

  const r = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }),
  });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const tokens = await r.json();
  if (!tokens.refresh_token) throw new Error('Google returned no refresh_token — revoke the app at myaccount.google.com/permissions and run again.');
  setEnvVar('GOOGLE_ADS_REFRESH_TOKEN', tokens.refresh_token);
  console.log('GOOGLE_ADS_REFRESH_TOKEN written to .env.');
}

if (process.argv.includes('--accounts')) await listAccounts();
else await consent();
