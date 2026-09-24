// Drip sender (EMAIL_CAPTURE_SCOPE_v1.md §6, §7.1). Used by api/drip-tick.js
// (daily cron, all due subscribers) and api/confirm.js (the day-0 welcome for
// one subscriber, right after they confirm).
//
// Each send is claimed in bronze.email_sends before Postmark is called
// (email_claim_send), so overlapping runs never send the same step twice, and
// a failed Postmark call releases the claim for the next run to retry.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { nextDue } from '../../scripts/lib/drip-schedule.mjs';
import {
  ENV, rpc, supabaseGet, siteOrigin, leadMagnetVars, postmarkSend, fromAddress, loadStep, renderEmail,
} from './email.js';

export const BROADCAST_STREAM = () => process.env.POSTMARK_BROADCAST_STREAM || 'drip';
const MAX_SENDS_PER_RUN = 300;

/** Signature for the track-choice links (subscriber id + chosen track), checked by /api/track. */
export function trackSig(subscriberId, track) {
  return createHmac('sha256', ENV.pepper).update(`track:${subscriberId}:${track}`).digest('base64url').slice(0, 32);
}

export function verifyTrackSig(subscriberId, track, sig) {
  const want = Buffer.from(trackSig(subscriberId, track));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * ASIN → Amazon URL for drip emails: the brand's `email` Attribution tag, else
 * its organic brand_site tag, else the plain listing (renderEmail's default).
 */
export async function amazonResolver(brand) {
  const map = new Map();
  try {
    const organic = await supabaseGet(
      `brand_site_products?brand_slug=eq.${encodeURIComponent(brand.slug)}&select=asin,attribution_url&limit=10000`
    );
    for (const r of organic) if (r.attribution_url) map.set(r.asin, r.attribution_url);
    const email = await supabaseGet(
      `brand_site_paid_links?brand_slug=eq.${encodeURIComponent(brand.slug)}&channel=eq.email&select=asin,attribution_url&limit=10000`
    );
    for (const r of email) if (r.attribution_url) map.set(r.asin, r.attribution_url);
  } catch (err) {
    console.warn('[drip] attribution lookup failed; plain Amazon links this run', err.message);
  }
  return (asin) => map.get(asin) ?? null;
}

/** Placeholder values for a drip step. */
function stepVars(seq, sub, sequence, origin) {
  const magnetTrack = sequence === 'general' || sequence === 'general-fallback' ? 'general' : sequence;
  const vars = leadMagnetVars(seq, magnetTrack, origin);
  for (const t of Object.keys(seq.tracks)) {
    if (t === 'general') continue;
    const qs = new URLSearchParams({ s: sub.subscriber_id, sig: trackSig(sub.subscriber_id, t) });
    vars[`track_link:${t}`] = `${origin}/subscribe/choose/${t}/?${qs}`;
  }
  return vars;
}

/**
 * Sends whatever is due. subscriberId limits the run to one subscriber (the
 * welcome right after confirming). Returns { sent, skipped, failed }.
 */
export async function runDrip({ brand, seq, defaults, subscriberId = null, now = Date.now() }) {
  const stats = { sent: 0, skipped: 0, failed: 0 };
  const candidates = await rpc('email_drip_candidates', { p_brand_slug: brand.slug, p_subscriber_id: subscriberId });
  if (candidates.length === 0) return stats;

  const origin = siteOrigin(brand);
  const resolveAmazon = await amazonResolver(brand);
  const from = fromAddress(brand, seq);

  for (const sub of candidates) {
    if (stats.sent >= MAX_SENDS_PER_RUN) break;
    const due = nextDue(seq, sub, now);
    if (!due) {
      stats.skipped++;
      continue;
    }
    try {
      const step = loadStep(brand.slug, due.file);
      const msg = renderEmail({
        step,
        brand,
        defaults,
        vars: stepVars(seq, sub, due.sequence, origin),
        track: due.sequence,
        stepKey: `${due.sequence}-${due.step}`,
        resolveAmazon,
      });
      const sendId = await rpc('email_claim_send', {
        p_subscriber_id: sub.subscriber_id,
        p_sequence: due.sequence,
        p_step: due.step,
        p_template_hash: msg.template_hash,
      });
      if (!sendId) {
        stats.skipped++;
        continue;
      }
      let messageId = null;
      let ok = false;
      try {
        messageId = await postmarkSend({
          from,
          to: sub.email,
          replyTo: brand.contact_email,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          stream: BROADCAST_STREAM(),
          trackLinks: 'HtmlOnly',
          tag: `${due.sequence}-${due.step}`,
          metadata: { subscriber_id: sub.subscriber_id, brand: brand.slug, step: `${due.sequence}-${due.step}` },
        });
        ok = true;
      } catch (err) {
        console.error('[drip] send failed', sub.subscriber_id, `${due.sequence}-${due.step}`, err.message);
      }
      await rpc('email_finish_send', { p_send_id: sendId, p_message_id: messageId, p_ok: ok, p_last_step: ok && due.last });
      if (ok) stats.sent++;
      else stats.failed++;
    } catch (err) {
      stats.failed++;
      console.error('[drip]', sub.subscriber_id, err.message);
    }
  }
  return stats;
}
