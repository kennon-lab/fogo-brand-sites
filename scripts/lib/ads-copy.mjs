// Google Ads copy rules: hard character limits from the Responsive Search Ad
// and asset specs, plus the editorial-policy heuristics that get ads
// disapproved (punctuation, capitalization, gimmicks, claims). Used by the
// campaign generator to build compliant ads from a post's search brief, and by
// the blog content gate to validate an author's `ads:` block before it ships.
import { checkClaims } from './claims.mjs';

export const LIMITS = {
  headline: 30,
  description: 90,
  path: 15,
  sitelinkText: 25,
  sitelinkLine: 35,
  callout: 25,
  keywordChars: 80,
  keywordWords: 10,
  campaignName: 255,
  headlinesMin: 3,
  headlinesMax: 15,
  descriptionsMin: 2,
  descriptionsMax: 4,
  sitelinksMax: 6,
  calloutsMax: 10,
};

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);

/** Title Case that leaves small words lowercase (except first/last) and keeps existing caps/units. */
export function titleCase(s) {
  const words = String(s).trim().split(/\s+/);
  return words
    .map((w, i) => {
      if (/^[A-Z0-9]/.test(w) && w !== w.toLowerCase()) return w; // already cased (N2O, 16oz)
      if (/^[a-z]{1,2}\d[a-z0-9]{0,2}$/i.test(w)) return w.toUpperCase(); // n2o, co2, f2
      const lower = w.toLowerCase();
      if (i > 0 && i < words.length - 1 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Whole sentences of a text (split on . ! ?), trimmed, punctuation kept. */
export function sentences(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 8);
}

/** Sentence / clause fragments of a text, trimmed, without trailing punctuation. */
export function clauses(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\s+[—–]\s+|;\s+|:\s+|,\s+(?=[A-Za-z])/)
    .map((c) => c.trim().replace(/[.,;:]+$/, ''))
    .filter((c) => c.length >= 8);
}

// Words a phrase must not end on — a cut there reads as broken ("How to Use a").
const DANGLING = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'is', 'are',
  'was', 'were', 'be', 'that', 'this', 'your', 'my', 'our', 'its', 'not', 'so', 'if', 'than', 'then', 'into', 'onto',
]);
// Lead-ins that leave a usable noun / imperative phrase behind. Deliberately
// not "where to" / "when to": "where to put a scratching post" → "put a
// scratching post" reads wrong.
const LEAD_PREFIX = /^(how to|how do (you|i)|how (can|should) (you|i)|what (is|are|to)|why (do|does|is)|things to make with( a| an)?|ideas for|tips for|the|a|an)\s+/i;

/**
 * Ad-safe plain text: Unicode compatibility forms folded to ASCII (N₂O → N2O,
 * ™ → TM), curly quotes and dashes straightened. Google's SYMBOLS policy
 * disapproves ads over characters like subscripts.
 */
export function adText(s) {
  return String(s)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*[–—]\s*/g, ' - ')
    .replace(/⁄/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First letter upper-cased, rest untouched. */
export function sentenceCase(s) {
  const t = String(s).trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** True when the phrase ends on a preposition / article / conjunction. */
export function dangles(s) {
  const last = String(s).trim().toLowerCase().split(/\s+/).pop()?.replace(/[^a-z]/g, '');
  return DANGLING.has(last ?? '');
}

/** Cut at a word boundary so the result is <= max chars (no ellipsis); '' if the cut would dangle. */
export function truncateWords(s, max) {
  let t = String(s).trim();
  if (t.length <= max) return t;
  t = t.slice(0, max + 1).replace(/\s+\S*$/, '').trim().replace(/[,;:–—-]+$/, '');
  while (t && dangles(t)) t = t.replace(/\s+\S+$/, '').trim();
  return t;
}

/**
 * A search phrase as a headline / sitelink label that fits `max` chars:
 * the whole phrase if it fits, else with its question or instruction lead-in
 * removed ("how to use a whipped cream dispenser" → "Whipped Cream Dispenser"),
 * else '' — never a mid-phrase cut.
 */
export function phraseThatFits(phrase, max) {
  const full = titleCase(phrase);
  if (full.length <= max) return full;
  let core = String(phrase).trim();
  for (let i = 0; i < 3; i++) core = core.replace(LEAD_PREFIX, '');
  const cased = titleCase(core);
  if (cased.length <= max && cased.split(' ').length >= 2) return cased;
  return '';
}

const GIMMICK = [
  [/!/, 'exclamation mark'],
  [/[?.!,]{2,}/, 'repeated punctuation'],
  [/\bclick here\b/i, '"click here"'],
  [/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/, 'phone number'],
  [/[★☆✓✔➤►→•]/, 'symbol character'],
  [/[^ -~]/, 'non-ASCII character (Google SYMBOLS policy)'],
  [/\b(free|cheap|lowest|100%|guaranteed)\b.*\b(free|cheap|lowest|100%|guaranteed)\b/i, 'stacked promotional words'],
];
const CAPS_ALLOW = new Set(['N2O', 'CO2', 'USA', 'FAQ', 'XL', 'BPA', 'LED', 'UV']);

function styleIssues(text, { allowOneExclamation = false } = {}) {
  const issues = [];
  for (const [re, label] of GIMMICK) {
    if (label === 'exclamation mark' && allowOneExclamation) {
      if ((text.match(/!/g) ?? []).length > 1) issues.push('more than one exclamation mark');
      continue;
    }
    if (re.test(text)) issues.push(label);
  }
  const caps = text.match(/\b[A-Z]{4,}\b/g) ?? [];
  if (caps.some((w) => !CAPS_ALLOW.has(w))) issues.push(`all-caps word (${caps.join(', ')})`);
  if (/^\s|\s$|\s{2,}/.test(text)) issues.push('stray whitespace');
  return issues;
}

/** Issues for one headline (empty array = OK). */
export function headlineIssues(text) {
  const issues = [];
  if (text.length > LIMITS.headline) issues.push(`${text.length} chars (max ${LIMITS.headline})`);
  if (text.length < 5) issues.push('too short');
  issues.push(...styleIssues(text));
  issues.push(...checkClaims(text).fails);
  return issues;
}

/** Issues for one description. */
export function descriptionIssues(text) {
  const issues = [];
  if (text.length > LIMITS.description) issues.push(`${text.length} chars (max ${LIMITS.description})`);
  if (text.length < 25) issues.push('too short (<25 chars)');
  issues.push(...styleIssues(text, { allowOneExclamation: true }));
  issues.push(...checkClaims(text).fails);
  return issues;
}

/** Issues for a keyword string (Google: <=80 chars, <=10 words, no special characters). */
export function keywordIssues(text) {
  const issues = [];
  if (text.length > LIMITS.keywordChars) issues.push(`${text.length} chars (max ${LIMITS.keywordChars})`);
  if (text.split(/\s+/).length > LIMITS.keywordWords) issues.push(`more than ${LIMITS.keywordWords} words`);
  if (/[^a-z0-9 '&\-]/i.test(text)) issues.push('special characters');
  return issues;
}

/**
 * Validate a whole ad block { headlines, descriptions, sitelinks, callouts }.
 * Returns [{ where, text, issues }] — empty when everything passes.
 */
export function validateAd(ad) {
  const out = [];
  const push = (where, text, issues) => issues.length && out.push({ where, text, issues });
  const seen = new Set();
  for (const h of ad.headlines ?? []) {
    const issues = headlineIssues(h);
    if (seen.has(h.toLowerCase())) issues.push('duplicate');
    seen.add(h.toLowerCase());
    push('headline', h, issues);
  }
  seen.clear();
  for (const d of ad.descriptions ?? []) {
    const issues = descriptionIssues(d);
    if (seen.has(d.toLowerCase())) issues.push('duplicate');
    seen.add(d.toLowerCase());
    push('description', d, issues);
  }
  if ((ad.headlines ?? []).length < LIMITS.headlinesMin) push('headlines', '', [`need at least ${LIMITS.headlinesMin}`]);
  if ((ad.headlines ?? []).length > LIMITS.headlinesMax) push('headlines', '', [`max ${LIMITS.headlinesMax}`]);
  if ((ad.descriptions ?? []).length < LIMITS.descriptionsMin) push('descriptions', '', [`need at least ${LIMITS.descriptionsMin}`]);
  if ((ad.descriptions ?? []).length > LIMITS.descriptionsMax) push('descriptions', '', [`max ${LIMITS.descriptionsMax}`]);
  for (const s of ad.sitelinks ?? []) {
    const issues = [];
    if (s.text.length > LIMITS.sitelinkText) issues.push(`text ${s.text.length} chars (max ${LIMITS.sitelinkText})`);
    for (const line of [s.line1, s.line2].filter(Boolean)) {
      if (line.length > LIMITS.sitelinkLine) issues.push(`line "${line}" ${line.length} chars (max ${LIMITS.sitelinkLine})`);
    }
    if (Boolean(s.line1) !== Boolean(s.line2)) issues.push('sitelink needs both lines or neither');
    issues.push(...styleIssues(s.text));
    push('sitelink', s.text, issues);
  }
  for (const c of ad.callouts ?? []) {
    const issues = [];
    if (c.length > LIMITS.callout) issues.push(`${c.length} chars (max ${LIMITS.callout})`);
    issues.push(...styleIssues(c));
    push('callout', c, issues);
  }
  for (const p of [ad.path1, ad.path2].filter(Boolean)) {
    if (p.length > LIMITS.path || /[^a-z0-9-]/i.test(p)) push('path', p, [`max ${LIMITS.path} chars, letters/digits/hyphens`]);
  }
  return out;
}
