// Deno entrypoint; the logic lives in handler.ts (runs under Node for tests).
// Deploy: supabase functions deploy tk-scan --no-verify-jwt (see supabase/config.toml).
// Secrets: TK_HASH_PEPPER (+ optional TK_ALLOWED_ORIGINS, TK_ALLOWED_ORIGIN_PATTERN).
import { readEnv } from '../_shared/http.ts';
import { handle } from './handler.ts';

const env = readEnv((k) => Deno.env.get(k));

Deno.serve((req) => handle(req, env));
