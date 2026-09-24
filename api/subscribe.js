// POST /api/subscribe: signup form endpoint (EMAIL_CAPTURE_SCOPE_v1.md §5.2, §7.1).
// Works with or without JS: a fetch() with Accept: application/json gets JSON;
// a plain form post gets a 303 to /subscribe/check-inbox/. Every accepted
// outcome (new, resend, already subscribed, suppressed) looks identical to the
// visitor so the form can't be used to test whether an address is on the list.
import {
  missingEnv, rpc, getBrand, emailEnabled, getContent, siteOrigin, leadMagnetVars, postmarkSend, fromAddress,
  loadStep, renderEmail, newToken, tokenHash, ipHash, clientIp, sha256,
} from './_lib/email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_FILL_MS = 2000;

export default async function handler(req, res) {
  const wantsJson = String(req.headers.accept || '').includes('application/json');
  const done = (status, payload, location) => {
    if (wantsJson) return res.status(status).json(payload);
    if (location) {
      res.setHeader('Location', location);
      return res.status(303).end();
    }
    return res.status(status).send(payload.error ?? 'Error');
  };

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const missing = missingEnv();
  if (missing.length) {
    console.error('[subscribe] missing env', missing);
    return done(503, { ok: false, error: 'Signup is temporarily unavailable.' });
  }

  try {
    const brand = await getBrand();
    const content = getContent();
    if (!emailEnabled(brand) || !content) return done(404, { ok: false, error: 'Not found.' });
    const { seq, defaults } = content;
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const ok = () => done(200, { ok: true }, '/subscribe/check-inbox/?s=1');

    // Bots: honeypot filled, or submitted faster than a person can type.
    // Pretend success so they learn nothing.
    const ts = Number(body.ts);
    if (body.website || (Number.isFinite(ts) && ts > 0 && Date.now() - ts < MIN_FILL_MS)) return ok();

    const email = String(body.email ?? '').trim();
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return done(422, { ok: false, error: 'Please enter a valid email address.' }, '/subscribe/check-inbox/?error=email');
    }

    const track = Object.hasOwn(seq.tracks, body.track) ? body.track : 'general';
    let paid = null;
    try {
      paid = body.paid ? JSON.parse(String(body.paid)) : null;
    } catch {
      paid = null;
    }

    const token = newToken();
    const [row] = await rpc('email_subscribe', {
      p_brand_slug: brand.slug,
      p_email: email,
      p_email_hash: sha256(email.toLowerCase()),
      p_track: track,
      p_source_type: String(body.source_type ?? '').slice(0, 40) || null,
      p_source_path: String(body.source_path ?? '').slice(0, 300) || null,
      p_paid_snapshot: paid && typeof paid === 'object' ? paid : null,
      p_consent_text: seq.consent.text,
      p_consent_version: String(seq.consent.version),
      p_ip_hash: ipHash(clientIp(req)),
      p_user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
      p_token_hash: tokenHash(token),
    });

    if (row?.action === 'send_confirm') {
      const origin = siteOrigin(brand);
      const msg = renderEmail({
        step: loadStep(brand.slug, seq.confirm),
        brand,
        defaults,
        vars: {
          ...leadMagnetVars(seq, track, origin),
          confirm_url: `${origin}/subscribe/confirm/?t=${token}`,
        },
        track,
        stepKey: 'confirm',
      });
      await postmarkSend({
        from: fromAddress(brand, seq),
        to: email,
        replyTo: brand.contact_email,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        stream: 'outbound',
        tag: 'confirm',
        metadata: { subscriber_id: row.subscriber_id, brand: brand.slug },
      });
    } else if (row?.action === 'rate_limited') {
      console.warn('[subscribe] rate limited', brand.slug);
    }
    return ok();
  } catch (err) {
    console.error('[subscribe]', err);
    return done(500, { ok: false, error: 'Something went wrong. Please try again in a few minutes.' }, '/subscribe/check-inbox/?error=server');
  }
}

export const config = { maxDuration: 10 };
