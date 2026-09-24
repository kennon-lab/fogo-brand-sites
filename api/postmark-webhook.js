// POST /api/postmark-webhook: Postmark → our subscriber table
// (EMAIL_CAPTURE_SCOPE_v1.md §7.1). Postmark already blocks sends to anyone who
// unsubscribed, bounced hard or complained (per stream); this mirrors that into
// bronze.email_subscribers so the scheduler stops queuing them and the numbers
// are right, and logs deliveries/clicks to bronze.email_events.
//
// Configure in Postmark (Otis Classic server → each stream → Webhooks) with URL
//   https://<POSTMARK_WEBHOOK_USER>:<POSTMARK_WEBHOOK_PASS>@www.<domain>/api/postmark-webhook
// and events: Subscription change, Bounce, Spam complaint, Delivery, Link click.
import { timingSafeEqual } from 'node:crypto';
import { missingEnv, rpc, getBrand } from './_lib/email.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req) {
  const user = process.env.POSTMARK_WEBHOOK_USER;
  const pass = process.env.POSTMARK_WEBHOOK_PASS;
  if (!user || !pass) return false;
  const want = Buffer.from(`Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** { status, type, email, url, at } for one Postmark webhook record, or null to ignore. */
export function interpret(e) {
  const email = e.Recipient ?? e.Email ?? null;
  switch (e.RecordType) {
    case 'SubscriptionChange': {
      if (!e.SuppressSending) return { status: null, type: 'resubscribe', email, at: e.ChangedAt };
      const status =
        e.SuppressionReason === 'HardBounce' ? 'bounced' : e.SuppressionReason === 'SpamComplaint' ? 'complained' : 'unsubscribed';
      return { status, type: 'unsubscribe', email, at: e.ChangedAt };
    }
    case 'Bounce':
      return { status: e.Type === 'HardBounce' ? 'bounced' : null, type: 'bounce', email, at: e.BouncedAt };
    case 'SpamComplaint':
      return { status: 'complained', type: 'spam', email, at: e.BouncedAt };
    case 'Delivery':
      return { status: null, type: 'delivery', email, at: e.DeliveredAt };
    case 'Click':
      return { status: null, type: 'click', email, url: e.OriginalLink ?? null, at: e.ReceivedAt };
    default:
      return null; // Opens and anything new: ignored.
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  if (!authorized(req)) return res.status(401).end();
  if (missingEnv().length) return res.status(503).end();

  try {
    const e = typeof req.body === 'object' && req.body ? req.body : {};
    const r = interpret(e);
    if (!r) return res.status(200).json({ ok: true, ignored: e.RecordType ?? null });
    const brand = await getBrand();
    const sid = e.Metadata?.subscriber_id;
    // Keep the record small: bounce payloads can carry the whole bounced message.
    const payload = {
      RecordType: e.RecordType, MessageStream: e.MessageStream, Type: e.Type, SuppressionReason: e.SuppressionReason,
      SuppressSending: e.SuppressSending, Tag: e.Tag, Metadata: e.Metadata, Description: e.Description,
    };
    const result = await rpc('email_apply_event', {
      p_brand_slug: brand.slug,
      p_subscriber_id: UUID_RE.test(String(sid ?? '')) ? sid : null,
      p_email: r.email,
      p_status: r.status,
      p_type: r.type,
      p_message_id: e.MessageID ?? null,
      p_url: r.url ?? null,
      p_payload: payload,
      p_occurred_at: r.at ?? null,
    });
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    // Non-2xx makes Postmark retry with backoff, which is what we want.
    console.error('[postmark-webhook]', err);
    return res.status(500).json({ ok: false });
  }
}

export const config = { maxDuration: 10 };
