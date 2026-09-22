// Claim language that must never ship in consumer-product content or ad copy:
// the FDA structure/function line for wellness brands and Google Ads'
// healthcare / misrepresentation destination policies. Shared by the blog
// content gate and the ad-copy validator so both hold the same bar.
export const CLAIM_FAIL = [
  [/\bfda[- ]?(approved|cleared|registered)\b/i, 'FDA approval claim'],
  [/\bclinically[- ](proven|tested|shown)\b/i, '"clinically proven" claim'],
  [/\b(cure|cures|cured|curing)\b/i, 'cure claim'],
  [
    /\b(treat|treats|treating|prevent|prevents|preventing|diagnose|diagnoses|heal|heals|healing)\b[^.!?\n]{0,80}\b(disease|illness|cancer|diabetes|arthritis|infection|depression|anxiety|insomnia|allerg(?:y|ies)|asthma|virus|covid)\b/i,
    'disease treatment / prevention claim',
  ],
];

export const CLAIM_WARN = [
  [/\bguarantee[ds]?\b/i, 'guarantee language'],
  [/(^|\s)#1\b|\bbest[- ]selling\b|\bworld'?s best\b/i, 'unsubstantiated superlative'],
];

/** { fails: string[], warns: string[] } for a block of text. */
export function checkClaims(text) {
  const fails = [];
  const warns = [];
  for (const [re, label] of CLAIM_FAIL) {
    const m = text.match(re);
    if (m) fails.push(`${label}: "${m[0].trim()}"`);
  }
  for (const [re, label] of CLAIM_WARN) {
    const m = text.match(re);
    if (m) warns.push(`${label}: "${m[0].trim()}"`);
  }
  return { fails, warns };
}
