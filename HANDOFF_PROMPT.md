# Claude Code Handoff Prompt — fogo-brand-sites

Save `BRAND_SITES_SCOPE_v1.md` and this file into a new empty folder (e.g. `C:\Users\kenno\Documents\fogo-brand-sites`), open Claude Code there, and paste everything below the line.

---

Read BRAND_SITES_SCOPE_v1.md in this directory in full before doing anything. It is the authoritative spec for this project. If the scope and this prompt ever conflict, the scope wins. Ask me before deviating from it.

Context: I'm the founder of FOGO Brands (Amazon FBA portfolio, ~27 brands). This is a NEW repo — fogo-brand-sites — separate from the existing fogo-dashboard repo. It builds individual static marketing websites, one per brand, each deployed as its own Vercel project on its own domain. No checkout, no cart — every CTA links out to Amazon via Attribution-tagged URLs.

This session has two phases, in order. Phase 1 must fully verify before Phase 2 begins.

## PHASE 1 — Database (scope section 4)

You have Supabase access. Target project: avlhnogtosjxdyibjipz. This is my PRODUCTION database backing a live dashboard — the migration is purely additive (3 new tables, 2 new views, 1 storage bucket). Do NOT drop, alter, or touch any existing table, view, matview, or Edge Function this session. Task 1.0 in the scope (widening listings-items-sync) is explicitly a separate future session.

1. Before writing any DDL, verify column names against information_schema.columns for bronze.products and bronze.amazon_listing_attributes — never assume. The SQL in the scope was verified against live schema on Jul 15, but re-check anyway.
2. Apply the migration in scope section 4.2 (bronze.brand_sites, bronze.attribution_links, bronze.brand_site_product_overrides) and the views in section 4.3 (silver.brand_site_products, public.brand_site_products, public.brand_sites). Use apply_migration / named migration files for ALL DDL — never raw execute_sql for DDL.
3. RLS pattern: match my existing bronze tables — service_role ALL + anon SELECT policies on all three new tables.
4. GRANT SELECT to anon on both public views, then run NOTIFY pgrst, 'reload schema' — the views are invisible to PostgREST without it.
5. Create the brand-site-images Storage bucket (public read).
6. Insert the pilot row into bronze.brand_sites: brand='Bean Envy' (must match bronze.products.brand exactly), slug='bean-envy', store='Bean Envy'. Ask me for domain, primary/secondary colors, and tagline before inserting.
7. GATE: SELECT count(*) FROM public.brand_site_products WHERE brand_slug='bean-envy' must return 15. If it doesn't, stop and debug the brand-name join with me before starting Phase 2.

## PHASE 2 — Pilot site (scope sections 5–5.3), built against Bean Envy

1. Scaffold the repo exactly per section 5.1: Astro + Tailwind, static output, BRAND_SLUG env selects the brand at build time. Build must fail loudly if the slug isn't found in public.brand_sites.
2. Implement all P0 requirements in section 5.2 and satisfy every acceptance criterion in section 5.3.
3. Write scripts/mirror-images.mjs and scripts/rebuild-all.ps1 per sections 4.4 and 5.1. Run mirror-images for bean-envy so the pilot builds with real mirrored images.
4. Init git with a sensible .gitignore and an initial commit. I'll create the GitHub repo and push.
5. Write a CLAUDE.md capturing this repo's conventions, stack, data layer facts, and the per-brand rollout steps (scope section 6) for future sessions.

Data layer facts (verified live — do not re-derive or guess):
- Build-time fetch only, anon (sb_publishable) key via env SUPABASE_URL / SUPABASE_ANON_KEY. Zero runtime Supabase calls from the shipped site; keep the key out of shipped JS.
- Read from public.brand_site_products and public.brand_sites.
- PostgREST caps at 1,000 rows: every fetch must append &limit=10000. Numeric columns arrive as strings: wrap in parseFloat.
- Images come ONLY from the brand-site-images Supabase Storage bucket (URLs recorded in bronze.brand_site_images by the mirror script). Never link m.media-amazon.com. ASINs with no mirrored image render a text-only card, never a broken img.
- Group the catalog by parent_asin with children as variant chips on one card.

Conventions from my main project that carry over:
- Theming via CSS variable tokens (--brand, --bg, etc.) injected from the brand row's primary_color/secondary_color — same pattern as my dashboard's Sharpened Burnished theme.
- toISOString().slice(0,10) is banned in any script — use a local-date helper if dates are ever needed.
- Complete files, no partial snippets. Validate that Astro/JSX parses before finishing.
- I'm on Windows/PowerShell. Never generate files via PowerShell here-strings — write files directly.

Environment: create a .env.example documenting SUPABASE_URL, SUPABASE_ANON_KEY, BRAND_SLUG. Do not commit real keys.

Out of scope this session (do NOT build): widening listings-items-sync or touching any existing Edge Function, Vercel project creation, DNS, Amazon Attribution setup, email capture (P1), landing page variants (P1), blog (P2).

When done: give me (a) exact commands to run the dev server and a production build for bean-envy, and (b) a checklist of my manual next steps per scope section 6 (Vercel project + BRAND_SLUG env + domain attach + deploy hook, Squarespace DNS records, Amazon Attribution per-ASIN tags + bulk CSV export, logo upload, copy review via the overrides table).
