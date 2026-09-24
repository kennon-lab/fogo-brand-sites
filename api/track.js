// POST /api/track: the "What are you making?" choice from the general welcome
// email (EMAIL_CAPTURE_SCOPE_v1.md §6.4). The email links to the static
// /subscribe/choose/<track>/?s=…&sig=… page, whose one button posts here, so
// link scanners never switch anyone. The HMAC signature ties the link to one
// subscriber and one track; no database token is needed.
import { missingEnv, rpc, getBrand, emailEnabled, getContent } from './_lib/email.js';
import { verifyTrackSig } from './_lib/drip.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (missingEnv().length) return go('/');

  try {
    const brand = await getBrand();
    const content = getContent();
    if (!emailEnabled(brand) || !content) return go('/');
    const { s, k, sig } = req.body ?? {};
    const track = String(k ?? '');
    const valid =
      UUID_RE.test(String(s ?? '')) &&
      track !== 'general' &&
      Object.hasOwn(content.seq.tracks, track) &&
      Object.hasOwn(content.seq.tracks.general?.on_choice ?? {}, track) &&
      verifyTrackSig(String(s), track, sig);
    if (!valid) return go('/subscribe/link-expired/');

    const result = await rpc('email_set_track', { p_brand_slug: brand.slug, p_subscriber_id: s, p_track: track });
    if (result === 'invalid') return go('/subscribe/link-expired/');
    return go(`/subscribe/confirmed/${track}/?switched=1`);
  } catch (err) {
    console.error('[track]', err);
    return go('/subscribe/link-expired/?error=server');
  }
}

export const config = { maxDuration: 10 };
