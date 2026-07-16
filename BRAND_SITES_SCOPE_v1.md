# BRAND_SITES_SCOPE_v1.md
## Per-Brand Informational Websites — Amazon Pre-Sell / BRB Architecture

**Status:** Scoped for Claude Code handoff — Claude Code executes Phase 1 (migration, via its Supabase access) and Phase 2 (pilot site) in one session; see HANDOFF_PROMPT.md
**Date:** 2026-07-15
**Owner:** Kennon
**Supersedes:** the drafted (never-applied) `public.ad_landing_pages` migration — that concept is absorbed into this project.

---

## 1. Problem & Goals

FOGO owns domains for its brands but has no web presence for them beyond Packstrong.co (Shopify). We want an individual website per brand — its own domain, its own identity, NOT one portfolio site with brand subsections — that:

1. Presents the brand and its product catalog with real product detail pages.
2. Routes all purchase intent to Amazon via **Amazon Attribution-tagged links**, earning **Brand Referral Bonus (~10% of sale credited against referral fees)**.
3. Creates landing surfaces for the Google Ads external-traffic strategy (owned-domain pre-sell → Attribution URL → Amazon PDP).
4. Keeps FOGO **off the hook for sales tax**: no checkout, no cart, no seller-of-record status. Amazon remains the marketplace facilitator.

**Non-goals (v1):**
- ❌ Cart / checkout / payments of any kind (tax fork — deliberately avoided)
- ❌ Shopify or MCF integration (Packstrong.co continues unchanged, out of scope)
- ❌ CMS / admin UI for editing site content (content edits happen via DB or repo config; revisit if team needs it)
- ❌ Blog / content marketing engine (P2 — architecture must not preclude it)
- ❌ Reviews display (scraping Amazon reviews violates ToS; revisit with owned testimonials later)
- ❌ A+ Content reproduction (known data gap; images from listing attributes are the v1 ceiling)

---

## 2. Architecture Decision

**One monorepo, one template, N static builds — one Vercel project per brand/domain.**

- New repo: `kennon-lab/fogo-brand-sites`
- Framework: **Astro + Tailwind** (static output, zero client JS by default, content-heavy fit; Tailwind consistent with FOGO Dashboard skills). If you'd rather stay pure-React, Vite + `vite-plugin-ssg` works, but Astro is the recommendation.
- Each brand = one Vercel project pointed at the same repo, with env `BRAND_SLUG=bean-envy` (etc.) controlling which brand's config + catalog is baked at build time. Custom domain attached per project.
- **Build-time data fetch** from Supabase (anon key, SELECT-only, same RLS posture as dashboard). Sites are fully static — no runtime Supabase dependency, no client-side data fetching, nothing to secure at runtime.
- Rebuilds: Vercel Deploy Hooks per project. v1 trigger is manual (or a single `rebuild-all.ps1` that curls every hook). P1: pg_cron weekly hook ping.

**Why static:** catalog changes slowly (products, copy, images), Vercel free/pro tier handles N static sites trivially, and there is zero attack surface / zero anon-key exposure in the shipped HTML.

---

## 3. Brand Roster (verified from `bronze.products`, canonical DISTINCT ON pattern, 2026-07-15)

| Brand | Store | Active ASINs | v1 site? |
|---|---|---|---|
| GS Power | GS Power | 90 | ✅ wave 2 (large catalog) |
| Artlicious | BenStores | 43 | ✅ |
| NewMe Fitness | NewMe Fitness | 41 | ✅ |
| Xtreme Comforts | Xtreme Comforts | 41 | ✅ |
| Tape King | Maxpro Direct | 22 | ✅ |
| Holiday Joy | BenStores | 19 | ✅ |
| Elite Sportz Equipment | Elite Sportz Equipment | 16 | ✅ |
| Otis Classic | Stylever | 16 | ✅ |
| Bean Envy | Bean Envy | 15 | ✅ **PILOT** |
| EverElectrix | Everelectrix | 15 | ✅ |
| Packstrong | Packstrong | 15 | ⚠️ Shopify site exists — skip or later replace |
| Stylever | Stylever | 15 | ✅ |
| Bullshark Bond | Bullshark Bond | 12 | ✅ |
| Home Acre Designs | Home Acre Designs | 11 | ✅ |
| Table-Mate | Table Mate | 10 | ✅ |
| Velette | Velette | 10 | ✅ |
| KOHM | Kohm | 9 | ✅ |
| Verivue Mirrors | Verivue Mirrors | 8 | ✅ |
| KarZone | BenStores | 7 | ✅ |
| Holly Poly Bags | BenStores | 5 | small — judgment call |
| SEE MANY PLACES .com | NewMe Fitness | 5 | small — judgment call |
| Stelucca Amazing Shields | Stelucca | 4 | small — judgment call |
| Oaktown Supply | NewMe Fitness | 4 | small — judgment call |
| Grizzly Power | Maxpro Direct | 3 | defer |
| Get Stuff Done | NewMe Fitness | 2 | defer |
| Grizzly Brand / Sorillo Brands | Maxpro / BenStores | 1 each | defer |

Note: 45 active ASINs have NULL brand+store and 1 sits under Hefty Haul with NULL brand — excluded by the view's `brand IS NOT NULL` filter; clean up in Finale if any should appear on a site.

**Pilot brand: Bean Envy** — consumer/giftable category, recent investment analysis already done, mid-size catalog (15 ASINs), and external traffic is directly useful for the Black-variant PPC-bleed thesis (external conversions earn BRB and boost organic rank without PPC spend).

---

## 4. Data Layer (Phase 1)

### 4.1 Verified source columns

`bronze.products` (canonical, per Apr 28 Finale API cutover): `sku, asin, parent_asin, name, brand, store, status, category, item_price, list_price, hero, updated_at` (plus cost/ops columns not needed here). Canonical-record rule applies: `DISTINCT ON (asin) ORDER BY asin, (status='Active') DESC, updated_at DESC NULLS LAST`. Do **not** filter on `hero` (sparsely populated).

`bronze.amazon_listing_attributes` (PK `snapshot_date, store, sku`): `list_price, our_price, status_flags, issues_count, parent_sku, raw_response jsonb`.

**Verified `raw_response` shape (2026-07-15):** top-level keys are `sku, issues, offers, summaries, attributes`. Content lives under `raw_response->'attributes'`:
- `attributes->'item_name'->0->>'value'` — title (318/751 latest rows)
- `attributes->'bullet_point'` — array of `{value}` objects (306/751)
- `attributes->'product_description'->0->>'value'` (296/751)
- `attributes->'main_product_image_locator'->0->>'media_location'` — main image URL (728/751)
- `attributes->'other_product_image_locator_1'..'_8'` — alt images (707/751 have _1)
- `summaries->0->>'mainImage'` present on 748/751 (fallback image source)

Coverage caveat: `listings-items-sync` currently targets the primary SKU per ASIN for the recommendation-engine subset. **Task 1.0: widen `listings-items-sync` to sync all active ASINs (primary SKU each)** so catalog coverage approaches 100%. Same per-store rate limits (5 RPS / 250ms gap) — this just extends the ASIN iteration list.

### 4.2 New migration: `brand_sites_phase1`

```sql
-- 1. Brand-site config (replaces the ad_landing_pages draft)
CREATE TABLE IF NOT EXISTS bronze.brand_sites (
  brand            text PRIMARY KEY,          -- must match bronze.products.brand exactly
  slug             text UNIQUE NOT NULL,      -- 'bean-envy'
  domain           text UNIQUE NOT NULL,      -- 'beanenvy.com'
  store            text NOT NULL,             -- seller account, for Attribution scoping
  tagline          text,
  about_html       text,                      -- brand story block
  logo_path        text,                      -- Supabase Storage path
  primary_color    text,                      -- hex
  secondary_color  text,
  contact_email    text,
  google_analytics_id text,
  is_live          boolean NOT NULL DEFAULT false,
  vercel_deploy_hook_url text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 2. Attribution links (manually created in Amazon Attribution console per store)
CREATE TABLE IF NOT EXISTS bronze.attribution_links (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand            text NOT NULL,
  asin             text NOT NULL,
  channel          text NOT NULL DEFAULT 'brand_site',  -- brand_site | google_ads | email ...
  attribution_url  text NOT NULL,             -- full amzn.to/attribution tagged URL
  campaign_name    text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand, asin, channel)
);

-- 3. Per-ASIN site overrides (custom copy beats Amazon copy when present)
CREATE TABLE IF NOT EXISTS bronze.brand_site_product_overrides (
  asin             text PRIMARY KEY,
  display_title    text,
  display_description_html text,
  hide_from_site   boolean NOT NULL DEFAULT false,
  sort_weight      integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bronze.brand_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE bronze.attribution_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE bronze.brand_site_product_overrides ENABLE ROW LEVEL SECURITY;
-- standard pattern: service_role ALL + anon SELECT on each (match existing bronze policies)
```

### 4.3 Silver view + public alias

```sql
CREATE OR REPLACE VIEW silver.brand_site_products AS
WITH canon AS (
  SELECT DISTINCT ON (asin)
    asin, parent_asin, sku, name, brand, store, status, category,
    item_price, list_price
  FROM bronze.products
  ORDER BY asin, (status='Active') DESC, updated_at DESC NULLS LAST
),
latest_attrs AS (
  SELECT DISTINCT ON (asin)
    asin,
    raw_response->'attributes'->'item_name'->0->>'value'            AS amazon_title,
    raw_response->'attributes'->'bullet_point'                       AS bullets_json,
    raw_response->'attributes'->'product_description'->0->>'value'  AS amazon_description,
    raw_response->'attributes'->'main_product_image_locator'->0->>'media_location' AS main_image_url,
    (SELECT jsonb_agg(raw_response->'attributes'->('other_product_image_locator_' || n)->0->>'media_location')
       FROM generate_series(1,8) n
      WHERE raw_response->'attributes' ? ('other_product_image_locator_' || n)) AS alt_image_urls
  FROM bronze.amazon_listing_attributes
  ORDER BY asin, snapshot_date DESC
)
SELECT
  c.asin, c.parent_asin, c.brand, c.store, c.category,
  COALESCE(o.display_title, la.amazon_title, c.name) AS display_title,
  COALESCE(o.display_description_html, la.amazon_description) AS display_description,
  la.bullets_json,
  la.main_image_url,
  la.alt_image_urls,
  c.item_price,
  bs.slug AS brand_slug,
  bs.domain AS brand_domain,
  al.attribution_url,
  ('https://www.amazon.com/dp/' || c.asin) AS plain_amazon_url,
  COALESCE(o.sort_weight, 0) AS sort_weight
FROM canon c
JOIN bronze.brand_sites bs ON bs.brand = c.brand
LEFT JOIN latest_attrs la ON la.asin = c.asin
LEFT JOIN bronze.brand_site_product_overrides o ON o.asin = c.asin
LEFT JOIN bronze.attribution_links al
       ON al.brand = c.brand AND al.asin = c.asin
      AND al.channel = 'brand_site' AND al.is_active
WHERE c.status = 'Active'
  AND c.brand IS NOT NULL
  AND COALESCE(o.hide_from_site, false) = false;

CREATE OR REPLACE VIEW public.brand_site_products AS SELECT * FROM silver.brand_site_products;
CREATE OR REPLACE VIEW public.brand_sites AS SELECT * FROM bronze.brand_sites;
-- GRANT SELECT to anon on both; NOTIFY pgrst, 'reload schema';
```

Known-quirks checklist for whoever implements: PostgREST 1,000-row cap (`&limit=10000` in build fetch), numeric-as-string (`parseFloat`), `NOTIFY pgrst, 'reload schema'` after view creation, capture dependents before any future `DROP ... CASCADE` touching `silver.finale_*`.

### 4.4 Image mirroring (do NOT hotlink Amazon CDN)

`media_location` URLs point at `m.media-amazon.com`. Hotlinking is fragile (URLs rotate) and against Amazon's usage terms for off-Amazon display. FOGO owns these images (brand owner supplied them), so mirror them:

- New Supabase Storage bucket `brand-site-images`, public read.
- Node script `scripts/mirror-images.mjs` in the new repo: reads `public.brand_site_products`, downloads each `main_image_url` + `alt_image_urls`, uploads to `brand-site-images/{brand_slug}/{asin}/{n}.jpg`, writes resulting public URLs to a new table `bronze.brand_site_images (asin, position, storage_url, source_url, mirrored_at)` (PK `asin, position`).
- Site build reads `bronze.brand_site_images` first, falls back to nothing (never the Amazon URL).
- Re-run manually when catalogs change; P1: monthly cron.

---

## 5. Site Template (Phase 2 — build against Bean Envy)

### 5.1 Repo structure

```
fogo-brand-sites/
├── astro.config.mjs            # reads BRAND_SLUG env
├── tailwind.config.mjs
├── src/
│   ├── lib/supabase.js         # build-time fetch, anon key, &limit=10000
│   ├── layouts/Base.astro      # head/meta/OG/theme CSS vars from brand config
│   ├── components/
│   │   ├── Header.astro  Footer.astro  Hero.astro
│   │   ├── ProductCard.astro   # image, title, price, "View on Amazon" CTA
│   │   ├── ProductGallery.astro
│   │   └── AmazonCTA.astro     # attribution_url ?? plain_amazon_url, rel="sponsored noopener", outbound GA event
│   └── pages/
│       ├── index.astro         # hero, brand story, featured products (top sort_weight)
│       ├── products/index.astro        # catalog grid, grouped by parent_asin (160 parents portfolio-wide — group children as variant chips on one card)
│       ├── products/[asin].astro       # PDP: gallery, bullets, description, price, CTA
│       ├── about.astro  contact.astro  privacy.astro
│       └── sitemap + robots via @astrojs/sitemap
├── scripts/
│   ├── mirror-images.mjs
│   └── rebuild-all.ps1         # curls every vercel_deploy_hook_url where is_live
└── vercel.json
```

### 5.2 Requirements

**P0**
- [ ] `BRAND_SLUG` env selects brand; build fails loudly if slug not found in `public.brand_sites`
- [ ] Home, catalog (parent-grouped), PDP per ASIN, about, contact, privacy pages
- [ ] Every CTA is `attribution_url` when present, else `plain_amazon_url`; opens Amazon in new tab
- [ ] Zero client-side Supabase calls; anon key used only at build time (still safe to expose, but keep it out of shipped JS anyway)
- [ ] Images served exclusively from `brand-site-images` bucket; ASINs with zero mirrored images render text-only card, never broken img
- [ ] Per-brand theming via CSS variable tokens (same pattern as Sharpened Burnished: `--brand`, `--bg`, etc. injected from `primary_color`/`secondary_color`)
- [ ] SEO: unique title/meta/OG per page, JSON-LD `Product` schema on PDPs (with `offers.url` = Amazon link), sitemap.xml, robots.txt
- [ ] `localDateString()` discipline n/a (no dates rendered), but the `toISOString().slice(0,10)` ban carries into any build scripts

**P1**
- [ ] Email capture form (Postmark or simple provider) — customer-ownership beachhead without commerce
- [ ] GA4 outbound-click events on AmazonCTA (feeds the TACoS/organic-rank measurement philosophy)
- [ ] pg_cron weekly deploy-hook ping for content freshness
- [ ] Google Ads landing-page variants (`/lp/[campaign]`) — the original `ad_landing_pages` use case

**P2 (architectural insurance)**
- [ ] Blog collection (Astro content collections slot in cleanly)
- [ ] Per-brand Shopify "Buy Direct" toggle for brands that later justify seller-of-record status
- [ ] Owned testimonials module

### 5.3 Acceptance criteria (pilot)

- Given `BRAND_SLUG=bean-envy`, build produces only Bean Envy's 15 ASINs, grouped under their parents.
- Given an ASIN with an active `brand_site` attribution link, the PDP CTA href contains the Attribution tag; given none, it links `amazon.com/dp/{asin}`.
- Given an ASIN with `hide_from_site=true`, it appears nowhere in the built output.
- Lighthouse ≥ 90 performance/SEO on PDP.
- No request to `*.supabase.co` or `m.media-amazon.com` from the deployed site at runtime.

---

## 6. Rollout (Phase 3)

Per brand (≈30–45 min each once template is stable):
1. Insert `bronze.brand_sites` row (slug, domain, colors, tagline, logo uploaded to Storage).
2. Run `mirror-images.mjs --brand={slug}`.
3. Create Amazon Attribution campaign in the owning store's console → one tag per ASIN (or per parent) → insert `bronze.attribution_links` rows. (This is the only genuinely manual per-ASIN chore; Amazon Attribution has bulk-upload CSV — use it.)
4. New Vercel project → repo → `BRAND_SLUG` env → attach domain → DNS at registrar → capture deploy hook URL into `brand_sites.vercel_deploy_hook_url`, flip `is_live`.
5. Spot-check PDPs + CTA tags, submit sitemap in Search Console.

Wave plan: Bean Envy pilot → 5-brand wave (Xtreme Comforts, NewMe Fitness, KOHM, Verivue Mirrors, Elite Sportz) → remainder. GS Power (90 ASINs) last in wave 2 after parent-grouping UX is proven.

---

## 7. Success Metrics

- **Leading:** sites live per week; % of live-site ASINs with Attribution-tagged CTAs (target 100%); outbound CTA CTR (GA4).
- **Lagging:** BRB credits appearing in settlement data per store (visible in payments reports — future `cashflow` cross-check); organic rank movement on ASINs receiving external clicks (existing rank radar); TACoS per brand once Google Ads waves start. No channel-ACoS targets, per measurement philosophy.

---

## 8. Open Questions

1. ✅ **RESOLVED (Jul 15):** Registrar is **Squarespace**; DNS stays there. Rollout step 4: in Squarespace DNS per domain, add Vercel's A record (`76.76.21.21`) for apex + CNAME `cname.vercel-dns.com` for `www` (confirm exact values from Vercel's domain-attach screen at setup time).
2. ✅ **RESOLVED (Jul 15):** Logos exist for all brands — upload to `brand-site-images/{slug}/logo.*` during rollout step 1. No image-gen needed.
3. ✅ **RESOLVED (Jul 15):** Attribution tags **per-ASIN, all brands** — child-level conversion data prioritized over console effort. Use Amazon Attribution bulk CSV upload per store to keep the chore manageable; `bronze.attribution_links` UNIQUE (brand, asin, channel) already fits.
4. **(Non-blocking, engineering)** Whether `listings-items-sync` widening (Task 1.0) should also request `includedData=attributes,summaries,issues,offers` for all rows or only new ones — check current call shape in the Edge Function before assuming.
5. **(Non-blocking)** Packstrong: replace Shopify with this template + keep Shopify checkout as the "Buy Direct" P2 pattern, or leave entirely alone. No action needed for v1.

---

## 9. Explicit tax posture (for the record)

No page on any v1 brand site collects payment, holds a cart, or lists FOGO as seller. All commerce occurs on Amazon, where Amazon is marketplace facilitator for sales tax collection/remittance. Adding direct checkout to any brand later (P2 toggle) changes FOGO's seller-of-record status for that brand and requires a nexus review with a CPA first — especially given FBA inventory presence across states.
