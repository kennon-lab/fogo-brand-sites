// Option sets for the Tape King dispenser claim form (TAPEKING_DISPENSER_FUNNEL_SCOPE.md,
// "Landing page spec"). Shared by the /claim page (labels, client-side checks) and the
// tk-claim Edge Function (server-side validation). Values must match the check
// constraints on marketing.tk_claims (sql/tk_dispenser_funnel_phase1.sql); the segment
// itself is derived in SQL by marketing.tk_segment().

export type Option = { value: string; label: string };

export const USE_CASES: Option[] = [
  { value: 'shipping_ecommerce', label: 'Shipping / ecommerce' },
  { value: 'warehouse_freight', label: 'Warehouse / freight' },
  { value: 'moving', label: 'Moving' },
  { value: 'office', label: 'Office' },
  { value: 'events_av', label: 'Events / AV' },
  { value: 'home', label: 'Home' },
];

export const VOLUME_BANDS: Option[] = [
  { value: 'le1', label: '1 or less' },
  { value: '2_5', label: '2–5' },
  { value: '6_20', label: '6–20' },
  { value: '21_50', label: '21–50' },
  { value: '50_plus', label: '50+' },
];

export const PURCHASE_CHANNELS: Option[] = [
  { value: 'amazon', label: 'Amazon' },
  { value: 'amazon_business', label: 'Amazon Business' },
  { value: 'office_store', label: 'Office store' },
  { value: 'other', label: 'Other' },
];

export const isOption = (options: Option[], value: unknown) =>
  typeof value === 'string' && options.some((o) => o.value === value);

// Field limits, enforced on both sides.
export const LIMITS = {
  email: 254,
  first_name: 60,
  company: 120,
  ship_name: 80,
  address1: 100,
  address2: 100,
  city: 60,
} as const;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Attribution params carried from the QR redirect (/r/<code>) into the claim.
export const CODE_RE = /^[a-z0-9]{1,24}$/;
export const LOT_RE = /^[a-z0-9]{1,16}$/;
export const SRC_VALUES = ['qr', 'typed', 'direct'];
export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
