// Deno entrypoint; the logic lives in handler.ts (runs under Node for tests).
// Deploy: supabase functions deploy tk-claim --no-verify-jwt (see supabase/config.toml).
// Secrets: TK_HASH_PEPPER, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, TURNSTILE_HOSTNAMES
// (+ optional TK_ALLOWED_ORIGINS, TK_ALLOWED_ORIGIN_PATTERN).
import { readEnv } from '../_shared/http.ts';
import { handle } from './handler.ts';

const env = readEnv((k) => Deno.env.get(k));

Deno.serve((req) => handle(req, env));
