// tk-scan — logs one QR scan (TAPEKING_DISPENSER_FUNNEL_SCOPE.md, "QR code and URL
// spec"). Called by the /r/<code> redirect page with navigator.sendBeacon, so the body
// arrives as text/plain JSON { code, lot } and nobody reads the response; the page
// forwards to /claim/ either way. Writes marketing.tk_scans via public.tk_log_scan
// (drops scans over the per-IP hourly limit). Unknown codes are logged raw so a
// misprint shows up in the data.
import { type Env, clientIp, corsHeaders, json, originAllowed, pepperedHash, readJson, rpc, str } from '../_shared/http.ts';
import { CODE_RE, LOT_RE } from '../_shared/claim-fields.ts';

export async function handle(req: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors);
  if (!originAllowed(env, req.headers.get('origin'))) return json({ ok: false, error: 'origin' }, 403);
  if (!env.supabaseUrl || !env.serviceKey || !env.pepper) return json({ ok: false, error: 'unavailable' }, 503, cors);

  try {
    const body = (await readJson(req, 2_000)) ?? {};
    const code = str(body.code, 24).toLowerCase();
    const lot = str(body.lot, 16).toLowerCase();
    const ip = clientIp(req);
    await rpc(env, 'tk_log_scan', {
      sku_code: CODE_RE.test(code) ? code : 'invalid',
      lot: LOT_RE.test(lot) ? lot : null,
      ip_hash: ip ? await pepperedHash(env.pepper, 'ip', ip) : null,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
    });
    return new Response(null, { status: 204, headers: cors });
  } catch (err) {
    console.error('[tk-scan]', err instanceof Error ? err.message : err);
    return json({ ok: false, error: 'server' }, 500, cors);
  }
}
