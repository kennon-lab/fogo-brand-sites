// Shared plumbing for the Tape King funnel Edge Functions (tk-claim, tk-scan): CORS,
// JSON responses, client IP, peppered hashing and PostgREST RPC calls. Pure Web APIs
// (fetch, crypto.subtle) so the handlers also run under Node for tests.

export type Env = {
  supabaseUrl: string;
  serviceKey: string;
  pepper: string; // TK_HASH_PEPPER
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  allowedOrigins: string[]; // exact origins
  allowedOriginPattern?: RegExp; // e.g. Vercel preview deploys of brand-tape-king
};

const DEFAULT_ORIGINS = [
  'https://www.tapeking.com',
  'https://tapeking.com',
  'http://localhost:4321',
  'http://127.0.0.1:4321',
];
const DEFAULT_ORIGIN_PATTERN = '^https://brand-tape-king-[a-z0-9-]+\\.vercel\\.app$';

/** Env from Deno.env-like getter (TK_ALLOWED_ORIGINS / TK_ALLOWED_ORIGIN_PATTERN optional). */
export function readEnv(get: (k: string) => string | undefined): Env {
  const extra = (get('TK_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    supabaseUrl: get('SUPABASE_URL') ?? '',
    serviceKey: get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    pepper: get('TK_HASH_PEPPER') ?? '',
    turnstileSecret: get('TURNSTILE_SECRET_KEY') || undefined,
    turnstileSiteKey: get('TURNSTILE_SITE_KEY') || undefined,
    allowedOrigins: [...DEFAULT_ORIGINS, ...extra],
    allowedOriginPattern: new RegExp(get('TK_ALLOWED_ORIGIN_PATTERN') || DEFAULT_ORIGIN_PATTERN),
  };
}

export function originAllowed(env: Env, origin: string | null): origin is string {
  if (!origin) return false;
  return env.allowedOrigins.includes(origin) || Boolean(env.allowedOriginPattern?.test(origin));
}

export function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!originAllowed(env, origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** First hop of x-forwarded-for (the visitor), else the platform's single-IP headers. */
export function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  return first || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || null;
}

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256(pepper, `${purpose}:${value}`) as hex. Purpose keeps hash spaces apart. */
export async function pepperedHash(pepper: string, purpose: string, value: string): Promise<string> {
  if (!keyCache.has(pepper)) {
    keyCache.set(
      pepper,
      crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    );
  }
  const sig = await crypto.subtle.sign('HMAC', await keyCache.get(pepper)!, enc.encode(`${purpose}:${value}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url — the step-2 claim token handed to the browser. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** POST /rest/v1/rpc/<fn> with the service key; the RPCs take one jsonb arg `p`. */
export async function rpc<T = Record<string, unknown>>(env: Env, fn: string, p?: unknown): Promise<T> {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(p === undefined ? {} : { p }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${fn} → ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Body as JSON whatever the content type (the page posts text/plain to skip CORS preflight). */
export async function readJson(req: Request, maxBytes = 8_000): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text || text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max + 1) : '';
