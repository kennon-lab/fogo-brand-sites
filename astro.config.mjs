// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Astro config runs before Astro's own .env loading, so pull env explicitly.
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
const BRAND_SLUG = env.BRAND_SLUG;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('[fogo-brand-sites] SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example).');
}
if (!BRAND_SLUG) {
  throw new Error('[fogo-brand-sites] BRAND_SLUG must be set — it selects which brand is built (e.g. BRAND_SLUG=bean-envy).');
}

// Fail loudly at config time if the slug doesn't exist in public.brand_sites.
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/brand_sites?slug=eq.${encodeURIComponent(BRAND_SLUG)}&select=slug,domain&limit=10000`,
  { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
);
if (!res.ok) {
  throw new Error(`[fogo-brand-sites] Failed to query public.brand_sites (${res.status} ${res.statusText}). Check SUPABASE_URL / SUPABASE_ANON_KEY.`);
}
const rows = await res.json();
if (!Array.isArray(rows) || rows.length === 0) {
  throw new Error(`[fogo-brand-sites] BRAND_SLUG "${BRAND_SLUG}" not found in public.brand_sites. Insert the brand row first (scope section 6, step 1).`);
}
const brandDomain = rows[0].domain;

// Authored brands replace per-ASIN PDPs with family-slug pages; the ASIN URLs
// become noindex redirect stubs and must stay out of the sitemap. Unauthored
// brands keep ASIN pages as their canonical PDPs.
const contentDir = join('src', 'content', 'brands', BRAND_SLUG, 'products');
const isAuthored = existsSync(contentDir) && readdirSync(contentDir).some((f) => /\.ya?ml$/.test(f));

export default defineConfig({
  output: 'static',
  site: `https://${brandDomain}`,
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      filter: (page) => !(isAuthored && /\/products\/B0[A-Z0-9]{8}\/$/.test(page)),
    }),
  ],
  image: {
    // Bucket images are downloaded and optimized at build time so the shipped
    // site makes zero runtime requests to *.supabase.co.
    domains: [new URL(SUPABASE_URL).hostname],
  },
});
