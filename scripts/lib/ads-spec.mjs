// Campaign-spec helpers shared by the generator (ads-campaigns), the review
// gate (ads-review) and the push script (ads-push): keyword normalization for
// overlap checks, the product-noun rule, negative-vs-keyword conflicts, and the
// hash that ties a review to the exact spec content it approved.
import { createHash } from 'node:crypto';

const singular = (w) => (w.endsWith('ies') && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') && w.length > 3 ? w.slice(0, -1) : w);

/**
 * Comparison key for a keyword: what Google's close-variant matching treats as
 * the same query for our purposes — case, plurals, "16 oz" vs "16oz",
 * punctuation. Two keywords with the same key compete for the same searches.
 */
export function keywordKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/(\d+)\s+(oz|ml|l|lb|lbs|in|inch|inches|ft|pack|pk|ct)\b/g, '$1$2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

// Words that must never be bid on: Google restricts or disapproves them
// (nitrous oxide is policed as a recreational inhalant; the rest are drug /
// dangerous-product topics), whatever our product actually is.
const POLICY_RISK = /\b(n2o|nitrous|laughing gas|whippets?|cream chargers?|chargers?|cbd|thc|kratom|vapes?|vaping|delta 8)\b/i;

/** Policy-risk term in a keyword or ad line, or null. */
export function policyRisk(text) {
  const m = String(text).match(POLICY_RISK);
  return m ? m[0] : null;
}

const PREPOSITIONS = new Set(['for', 'from', 'with', 'of', 'to', 'in', 'on', 'at', 'by', 'without']);

/**
 * The head noun of a product phrase: the last word of its longest stretch
 * between prepositions ("swing top bottles for kombucha" → "bottle", "couch
 * protector from cats" → "protector", "how to use a whipped cream dispenser"
 * → "dispenser"), singularized.
 */
export function headNoun(phrase) {
  const segments = [[]];
  for (const w of String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (PREPOSITIONS.has(w)) segments.push([]);
    else segments[segments.length - 1].push(w);
  }
  const core = segments.reduce((best, s) => (s.length > best.length ? s : best), []);
  return core.length ? singular(core[core.length - 1]) : null;
}

/** True when the keyword contains one of the product nouns (singularized). */
export function hasProductNoun(keyword, nouns) {
  const words = new Set(keywordKey(keyword).split(' '));
  return nouns.some((n) => words.has(n));
}

/**
 * Negatives that would stop one of our own keywords from serving: a PHRASE
 * negative blocks every keyword containing its words in order; EXACT blocks
 * the identical query; BROAD blocks any keyword containing all its words.
 * Returns [{ negative, keyword }].
 */
export function negativeConflicts(negatives, keywords) {
  const out = [];
  for (const n of negatives) {
    const nk = keywordKey(n.text);
    const nWords = nk.split(' ');
    for (const k of keywords) {
      const kk = keywordKey(k.text);
      const blocked =
        n.match === 'EXACT'
          ? kk === nk
          : n.match === 'BROAD'
            ? nWords.every((w) => kk.split(' ').includes(w))
            : ` ${kk} `.includes(` ${nk} `);
      if (blocked) out.push({ negative: n.text, keyword: k.text });
    }
  }
  return out;
}

/**
 * Hash of everything a review approves: keywords, negatives, ads, assets,
 * targeting, budget. Excludes what ads-push changes later (status, bidding
 * stage) and bookkeeping (generated date, google ids, the review itself), so
 * regenerating an unchanged spec keeps its review and any real edit voids it.
 */
export function specHash(spec) {
  const { status, bidding, stages, ...campaign } = spec.campaign ?? {};
  const payload = JSON.stringify({ campaign, ad_groups: spec.ad_groups, source: { asins: spec.source?.asins, primary_asin: spec.source?.primary_asin } });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
