// Build-time email-capture config (EMAIL_CAPTURE_SCOPE_v1.md §5). Decides
// whether this brand shows signup forms and which track each page's form
// starts people on. Reads only the brand row + repo content; no subscriber
// data is ever touched at build.
//
// Capture is on when the brand has emails/ content AND either
// brand_sites.email_enabled is true or EMAIL_FORCE_ENABLE=1 is set (use that on
// the Vercel *Preview* environment to test before going live).
import { getBrand } from './supabase.js';
import { hasEmails, loadSequences } from '../../scripts/lib/email-render.mjs';

let configPromise;

/** null when capture is off; otherwise { consent, tracks, leadMagnets, trackFor(asin) }. */
export function getEmailConfig() {
  configPromise ??= getBrand().then((brand) => {
    const forced = import.meta.env.EMAIL_FORCE_ENABLE === '1' || process.env.EMAIL_FORCE_ENABLE === '1';
    if (!hasEmails(brand.slug) || !(brand.email_enabled || forced)) return null;
    const seq = loadSequences(brand.slug);
    const byAsin = new Map();
    for (const [track, def] of Object.entries(seq.tracks)) {
      for (const asin of def.asins ?? []) byAsin.set(asin, track);
    }
    return {
      consent: seq.consent,
      tracks: seq.tracks,
      leadMagnets: seq.lead_magnets ?? {},
      trackFor: (...asins) => asins.map((a) => byAsin.get(a)).find(Boolean) ?? 'general',
    };
  });
  return configPromise;
}

/** Lead magnets ({ key, title, path }) a track's subscribers get. */
export function leadMagnetsFor(config, track) {
  const keys = config.tracks[track]?.lead_magnets ?? Object.keys(config.leadMagnets);
  return keys.map((key) => ({ key, ...config.leadMagnets[key] }));
}
