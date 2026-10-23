// US states for the dispenser claim form (50 states + DC — the offer is US only,
// no territories or APO/FPO in v1) and a ZIP-prefix → state table for the
// mismatched-state/ZIP check. Shared by the /claim page (client-side warning) and
// the tk-claim Edge Function (manual-review flag), so keep it dependency-free.

export const US_STATES: [code: string, name: string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

/** The state dropdown's "I'm outside the US" option — never a valid ship-to. */
export const OUTSIDE_US = 'XX';

const STATE_CODES = new Set(US_STATES.map(([code]) => code));
export const isUsState = (code: string) => STATE_CODES.has(code);

// USPS 3-digit ZIP prefixes by state, as [first, last, state] ranges. Prefixes for
// territories and military mail (006–009, 090–099, 340, 962–966, 969) are absent,
// so they resolve to null like unassigned prefixes. Single-prefix exceptions
// (055 MA, 201 VA, 569 DC, 733 TX, 885 TX) sit before the range that contains them.
const ZIP3: [number, number, string][] = [
  [5, 5, 'NY'], [55, 55, 'MA'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [201, 201, 'VA'], [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'],
  [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [398, 399, 'GA'], [320, 339, 'FL'],
  [341, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [400, 427, 'KY'],
  [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'],
  [550, 567, 'MN'], [569, 569, 'DC'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'],
  [716, 729, 'AR'], [733, 733, 'TX'], [730, 749, 'OK'], [750, 799, 'TX'], [885, 885, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'],
  [870, 884, 'NM'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'],
  [980, 994, 'WA'], [995, 999, 'AK'],
];

/** State a ZIP (5-digit or ZIP+4) belongs to, or null when unknown / malformed. */
export function zipState(zip: string): string | null {
  const m = /^(\d{3})\d{2}(?:-?\d{4})?$/.exec(zip.trim());
  if (!m) return null;
  const prefix = Number(m[1]);
  for (const [lo, hi, state] of ZIP3) if (prefix >= lo && prefix <= hi) return state;
  return null;
}

/** 5-digit ZIP or ZIP+4, normalized to `12345` / `12345-6789`; null if malformed. */
export function normalizeZip(zip: string): string | null {
  const m = /^(\d{5})(?:-?(\d{4}))?$/.exec(zip.trim());
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}
