// Address normalization for the dispenser claim dedupe (one per address) and the
// 3+-claims-per-street review flag. Produces two keys that tk-claim HMACs before
// they reach the database:
//   addressKey — street line + unit + ZIP5   ("123 N MAIN ST #4B|60601")
//   streetKey  — street line without unit + ZIP5 ("123 N MAIN ST|60601")
// City and state are left out on purpose: ZIP5 pins the place, and city spellings
// vary ("St Louis" / "Saint Louis"). The goal is catching the same door typed two
// ways, not USPS-grade standardization.

const SUFFIX: Record<string, string> = {
  STREET: 'ST', STR: 'ST', AVENUE: 'AVE', AV: 'AVE', AVEN: 'AVE', ROAD: 'RD', DRIVE: 'DR', DRV: 'DR',
  BOULEVARD: 'BLVD', BOUL: 'BLVD', LANE: 'LN', COURT: 'CT', PLACE: 'PL', TERRACE: 'TER', HIGHWAY: 'HWY',
  PARKWAY: 'PKWY', PKY: 'PKWY', CIRCLE: 'CIR', CIRCL: 'CIR', TRAIL: 'TRL', SQUARE: 'SQ', WAY: 'WAY',
  EXPRESSWAY: 'EXPY', FREEWAY: 'FWY', TURNPIKE: 'TPKE', PIKE: 'PIKE', POINT: 'PT', CROSSING: 'XING',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE',
  SOUTHWEST: 'SW', MOUNT: 'MT', FORT: 'FT', SAINT: 'ST',
};

// Secondary-unit designators; any of them (or a leading "#") starts the unit part.
const UNIT = new Set([
  'APT', 'APARTMENT', 'UNIT', 'STE', 'SUITE', 'RM', 'ROOM', 'FL', 'FLOOR', 'BLDG', 'BUILDING', 'LOT',
  'SPC', 'SPACE', 'DEPT', 'TRLR', 'TRAILER', 'OFC', 'OFFICE', 'HNGR', 'PIER', 'SLIP', 'STOP', 'BOX',
]);

function tokens(s: string): string[] {
  return s
    .toUpperCase()
    .replace(/#/g, ' # ')
    .replace(/[^A-Z0-9# ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Splits one address line into normalized [street, unit] token strings. */
function splitLine(line: string): [string, string] {
  const t = tokens(line);
  const at = t.findIndex((w, i) => w === '#' || (UNIT.has(w) && i > 0 && !(w === 'BOX' && t[i - 1] === 'PO')));
  const street = (at < 0 ? t : t.slice(0, at)).map((w) => SUFFIX[w] ?? w);
  // "APT 4B", "# 4B", "STE 200" all become "#4B" / "#200": the designator word is noise.
  const unit = at < 0 ? [] : t.slice(at).filter((w) => w !== '#' && !UNIT.has(w));
  return [street.join(' '), unit.length ? `#${unit.join('')}` : ''];
}

export function addressKeys(a: { address1: string; address2?: string | null; zip: string }) {
  const zip5 = a.zip.trim().slice(0, 5);
  const [street, unit1] = splitLine(a.address1);
  // Line 2 is all unit unless it carries a designator of its own ("Suite 200").
  const t2 = tokens(a.address2 ?? '').filter((w) => w !== '#' && !UNIT.has(w));
  const unit = [unit1.replace(/^#/, ''), t2.join('')].filter(Boolean).join('');
  return {
    addressKey: `${street}${unit ? ` #${unit}` : ''}|${zip5}`,
    streetKey: `${street}|${zip5}`,
  };
}
