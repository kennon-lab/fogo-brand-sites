// One-time Google Ads OAuth setup: obtains the refresh token that
// scripts/ads-push.mjs uses. Run it once per manager-account user.
//
// Usage:
//   node scripts/google-oauth.mjs
//   npm run ads:auth
//
// Needs GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in .env (an OAuth
// client of type "Desktop app" from the Google Cloud project). The script
// starts a loopback listener, prints the consent URL, waits for Google to
// redirect back, exchanges the code, and prints the refresh token — paste it
// into .env as GOOGLE_ADS_REFRESH_TOKEN. Nothing is written to disk.
//
// Sign in as the user on the Google Ads MANAGER account. The token carries
// the Google Ads scope only.
import process from 'node:process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
const AUTH_URL = process.env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

if (!clientId || !clientSecret) {
  console.error('GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET are required in .env (Desktop app OAuth client).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const url = new URL(AUTH_URL);
url.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline', // refresh token
  prompt: 'consent', // always issue a refresh token, even on re-authorisation
  include_granted_scopes: 'false',
  state,
}).toString();

console.log('\nOpen this URL in the browser where you are signed in as the manager-account user:\n');
console.log(`  ${url.href}\n`);
console.log('Waiting for Google to redirect back to this machine…');

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const q = new URL(req.url, redirectUri).searchParams;
    if (!q.has('code') && !q.has('error')) {
      res.writeHead(404);
      return res.end();
    }
    if (q.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('State mismatch — start over.');
      return reject(new Error('OAuth state mismatch'));
    }
    if (q.has('error')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`Authorisation failed: ${q.get('error')}`);
      return reject(new Error(`OAuth error: ${q.get('error')}`));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Authorised. You can close this tab and return to the terminal.');
    resolve(q.get('code'));
  });
});
server.close();

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
  process.exit(1);
}
const tok = JSON.parse(text);
if (!tok.refresh_token) {
  console.error('Google returned no refresh token. Revoke the app at https://myaccount.google.com/permissions and run again.');
  process.exit(1);
}
console.log('\nAdd this line to .env (never commit it):\n');
console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tok.refresh_token}\n`);
console.log('Then set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account id (digits only) and GOOGLE_ADS_DEVELOPER_TOKEN from API Center.');
