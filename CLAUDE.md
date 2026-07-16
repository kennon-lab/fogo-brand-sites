# fogo-brand-sites

Per-brand static marketing sites for the FOGO Brands portfolio (~27 Amazon FBA brands).
One repo, one Astro template, N static builds — each brand is its own Vercel project on its
own domain, selected at build time via `BRAND_SLUG`. No cart, no checkout, no seller-of-record:
every CTA routes to Amazon via Attribution-tagged URLs (Brand Referral Bonus ~10%).

Authoritative spec: `BRAND_SITES_SCOPE_v1.md` (kept in repo root). Original brief: `HANDOFF_PROMPT.md`.

## Stack & commands

- Astro 5 (static output) + Tailwind 3 (`@astrojs/tailwind`) + `@astrojs/sitemap`. Node 24.
- `npm run dev` — dev server (uses `.env`; localhost:4321)
- `npm run build` — production build for the brand in `BRAND_SLUG`
- `npm run preview` — serve `dist/`
- `node scripts/mirror-images.mjs --brand=<slug>` — mirror Amazon images to Storage (see below)
- `.\scripts\rebuild-all.ps1` — POST every `vercel_deploy_hook_url` where `is_live=true`

## Environment (`.env`, never committed; see `.env.example`)

- `SUPABASE_URL` — https://avlhnogtosjxdyibjipz.supabase.co (production project)
- `SUPABASE_ANON_KEY` — the **publishable** key (`sb_publishable_...`). Legacy JWT anon/service
  keys were **disabled 2026-04-15** — never use `eyJ...` keys against this project.
- `BRAND_SLUG` — selects the brand; build fails loudly (in `astro.config.mjs`) if the slug
  isn't in `public.brand_sites`.
- `SUPABASE_SERVICE_ROLE_KEY` — **secret** key (`sb_secret_...`), only needed by
  `mirror-images.mjs`. Also stored as a user-scope Windows env var. Note: Node's
  `process.loadEnvFile` does NOT override inherited env vars — if a stale value is inherited,
  clear it (`Remove-Item env:SUPABASE_SERVICE_ROLE_KEY`) so `.env` wins.

## Data layer (all build-time; zero runtime Supabase calls)

Reads go through PostgREST with the anon key, only in `src/lib/supabase.js` and
`astro.config.mjs`:

- `public.brand_sites` — brand config row (colors, tagline, domain, logo_path, GA id, deploy hook)
- `public.brand_site_products` — catalog view (canonical `bronze.products` + latest
  `bronze.amazon_listing_attributes` + overrides + attribution links; `hide_from_site` rows
  already filtered out)
- `public.brand_site_images` — mirrored image URLs written by the mirror script

Known quirks (do not re-derive):

- PostgREST caps at 1,000 rows → every fetch appends `&limit=10000` (handled in `rest()`)
- Numeric columns arrive as strings → `parseFloat` (handled in `getProducts()`)
- `parent_asin` contains the literal string `'#N/A'` (Finale artifact) for standalone
  products — `src/lib/catalog.js` treats `#N/A`/`N/A`/null/'' as "no parent"
- After creating/altering public views: `GRANT SELECT TO anon` + `NOTIFY pgrst, 'reload schema'`
- Supabase default privileges grant WRITE on new public views to anon/authenticated — always
  REVOKE those down to SELECT (views execute DML as owner and bypass RLS). Done for the three
  brand-site views in migration `brand_sites_phase1_view_grants_lockdown`.
- New bronze tables: RLS pattern is service_role ALL + anon SELECT + authenticated SELECT
  (match `bronze.amazon_listing_attributes`)

## Images

- Never hotlink `m.media-amazon.com`. `scripts/mirror-images.mjs` downloads listing images and
  uploads to Storage bucket `brand-site-images/{slug}/{asin}/{position}.{ext}`, recording URLs
  in `bronze.brand_site_images` (position 0 = main image).
- The build then **localizes** bucket images via `src/lib/images.js` (Astro `getImage`) so the
  shipped site makes zero requests to `*.supabase.co` at runtime. `astro.config.mjs` allowlists
  the Supabase hostname under `image.domains`.
- ASINs with no mirrored images render a text-only card — never a broken `<img>`.
- If the script can't write DB rows (bad key), it saves `scripts/mirror-manifest.json` and
  exits 2 — fix the key and re-run (uploads are idempotent via `x-upsert`).

## Template conventions

- Theming via CSS variable tokens injected in `src/layouts/Base.astro` from the brand row:
  `--brand` = `primary_color`, `--brand-2` = `secondary_color`; neutral `--ink/--bg/--surface`
  defaults live in `src/styles/global.css`. Same pattern as the dashboard's Sharpened Burnished
  theme. Bean Envy palette (from BNV_PreliminaryBrandGuidelines_AMZ_US_102721.pdf): yellow
  #fecb34, black #000000, off-white #efe7e4, orange #eda31d.
- Every purchase CTA is `src/components/AmazonCTA.astro`: `attribution_url ?? plain_amazon_url`,
  `target="_blank" rel="sponsored noopener"`, `data-amazon-cta`/`data-asin` for the GA outbound
  event (GA loads only when `google_analytics_id` is set on the brand row).
- Catalog groups by parent (`groupByParent`); variant chips label via title-diffing
  (`variantLabel`), falling back to price then ASIN (identical sibling titles → ASIN chips).
- PDPs emit JSON-LD `Product` with `offers.url` = the Amazon link.
- `toISOString().slice(0,10)` is banned in any script — use a local-date helper if dates are
  ever needed. Never generate files via PowerShell here-strings — write files directly.
- Complete files only, no partial snippets; validate Astro/JSX parses before finishing.

## Per-brand rollout (scope §6, ~30–45 min once template is stable)

1. Insert `bronze.brand_sites` row — `brand` must match `bronze.products.brand` EXACTLY;
   slug, domain, store, tagline, `primary_color`/`secondary_color` (brand-guide PDFs live in
   Google Drive under Brand Assets/<brand>), upload logo to
   `brand-site-images/{slug}/logo.*` and set `logo_path`.
2. `node scripts/mirror-images.mjs --brand=<slug>`.
3. Amazon Attribution campaign in the owning store's console → one tag per ASIN (bulk CSV
   upload) → insert `bronze.attribution_links` rows (channel `brand_site`).
4. New Vercel project → this repo → env `BRAND_SLUG=<slug>` (+ SUPABASE_URL, SUPABASE_ANON_KEY)
   → attach domain → Squarespace DNS (A `76.76.21.21` apex, CNAME `cname.vercel-dns.com` www —
   confirm on Vercel's domain screen) → save deploy hook URL into
   `brand_sites.vercel_deploy_hook_url`, flip `is_live=true`.
5. Spot-check PDPs + CTA tags; submit sitemap in Search Console.

Wave plan: Bean Envy (pilot, live) → Xtreme Comforts, NewMe Fitness, KOHM, Verivue Mirrors,
Elite Sportz → remainder (GS Power last, 90 ASINs).

## Out of scope / do not touch from this repo

- `listings-items-sync` widening (Task 1.0 in scope) and all other Edge Functions — separate
  session, dashboard repo.
- Any existing dashboard tables/views/matviews in the shared Supabase project.
