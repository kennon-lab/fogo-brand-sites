// GET /api/drip-tick: daily Vercel Cron (vercel.json) that sends every drip
// email that's due for this brand (EMAIL_CAPTURE_SCOPE_v1.md §7.1).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is refused.
// Crons only run on production deployments, and each brand's project sends
// only its own brand's mail (BRAND_SLUG).
import { timingSafeEqual } from 'node:crypto';
import { missingEnv, getBrand, emailEnabled, getContent } from './_lib/email.js';
import { runDrip } from './_lib/drip.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false });
  const missing = missingEnv();
  if (missing.length) return res.status(503).json({ ok: false, missing });

  try {
    const brand = await getBrand();
    const content = getContent();
    if (!emailEnabled(brand) || !content) return res.status(200).json({ ok: true, skipped: 'email off' });
    const stats = await runDrip({ brand, seq: content.seq, defaults: content.defaults });
    console.log('[drip-tick]', brand.slug, stats);
    return res.status(200).json({ ok: true, ...stats });
  } catch (err) {
    console.error('[drip-tick]', err);
    return res.status(500).json({ ok: false });
  }
}

export const config = { maxDuration: 60 };
