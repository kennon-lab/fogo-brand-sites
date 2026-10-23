// Free-dispenser claim program (Tape King QR funnel, TAPEKING_DISPENSER_FUNNEL_SCOPE.md).
// src/content/brands/<slug>/claim.yaml turns on /claim/, /r/<code> and /<typed_path>/
// for that brand; brands without the file build none of them.
//
// The claim page and the /r/ redirect are the only places the shipped site calls
// Supabase at runtime — and only the funnel's Edge Functions (tk-claim, tk-scan),
// never PostgREST or the publishable key. Everything else stays build-time.
import { getCollection } from 'astro:content';
import { getTapeCatalog } from './tapeking.js';

const BRAND_SLUG = import.meta.env.BRAND_SLUG;

// Scope "Redirect target": every printed entry point carries these into /claim/.
export const CLAIM_UTM = { utm_source: 'tape_core', utm_campaign: 'dispenser_claim' };

let programPromise;

/** The brand's claim.yaml data, or null when the brand runs no claim program. */
export function getClaimProgram() {
  programPromise ??= getCollection('claim').then(async (entries) => {
    const program = entries.find((e) => e.id === `${BRAND_SLUG}/claim`)?.data ?? null;
    if (!program) return null;
    // Cross-check against catalog.yaml: every code names a real line, and the
    // thank-you CTA and fallback photo are curated SKUs. Bad authoring fails the build.
    const { lines, skuByAsin } = await getTapeCatalog();
    const lineSlugs = new Set(lines.map((l) => l.slug));
    const problems = [];
    const codes = program.qr.codes.map((c) => c.code);
    if (new Set(codes).size !== codes.length) problems.push('duplicate qr code');
    for (const c of program.qr.codes) {
      if (!lineSlugs.has(c.line)) problems.push(`qr code "${c.code}": unknown line "${c.line}"`);
    }
    if (!skuByAsin.has(program.thanks.cta_asin)) problems.push(`thanks.cta_asin ${program.thanks.cta_asin} not in catalog.yaml`);
    if (!skuByAsin.has(program.hero.image_asin)) problems.push(`hero.image_asin ${program.hero.image_asin} not in catalog.yaml`);
    if (problems.length) throw new Error(`[claim.js] invalid claim.yaml:\n  ${problems.join('\n  ')}`);
    return program;
  });
  return programPromise;
}

/** Public URL of one of the funnel's Edge Functions. */
export const claimFunctionUrl = (name) => `${import.meta.env.SUPABASE_URL}/functions/v1/${name}`;
