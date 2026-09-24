// POST /api/confirm: double opt-in confirmation (EMAIL_CAPTURE_SCOPE_v1.md §4.2).
// The link in the confirm email opens the static /subscribe/confirm/?t=… page,
// which asks for one click before posting here. Confirming on a plain GET would
// let corporate link scanners (which pre-fetch every URL in an email) confirm
// addresses nobody actually confirmed.
import { missingEnv, rpc, getBrand, emailEnabled, tokenHash } from './_lib/email.js';

export default async function handler(req, res) {
  const go = (location) => {
    res.setHeader('Location', location);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(303).end();
  };

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (missingEnv().length) return go('/subscribe/link-expired/');

  try {
    const brand = await getBrand();
    if (!emailEnabled(brand)) return go('/');
    const token = String(req.body?.t ?? '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return go('/subscribe/link-expired/');

    const [row] = await rpc('email_confirm', { p_token_hash: tokenHash(token) });
    if (row?.result === 'confirmed' || row?.result === 'already') {
      if (row.brand_slug !== brand.slug) return go('/subscribe/link-expired/');
      const track = /^[a-z-]+$/.test(row.track ?? '') ? row.track : 'general';
      return go(`/subscribe/confirmed/${track}/${row.result === 'confirmed' ? '?new=1' : ''}`);
    }
    return go('/subscribe/link-expired/');
  } catch (err) {
    console.error('[confirm]', err);
    return go('/subscribe/link-expired/?error=server');
  }
}

export const config = { maxDuration: 10 };
