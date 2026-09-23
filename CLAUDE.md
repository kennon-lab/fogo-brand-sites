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
- `npm run check:blog` — blog content gate (also the first step of `npm run build`)
- `npm run attribution-tags -- --brand=<slug>|all --channel=brand_site|brand_site_blog|google_ads [--probe] [--dry-run] [--force]`
  — create Amazon Attribution tags via the Ads API and write `bronze.attribution_links` (see below)
- `npm run ads:campaigns -- --brand=<slug>|all [--post=<slug>] [--days=90]` — write Google Ads
  campaign specs to `ads/<brand>/<post>.json` from each post's search brief + Amazon search terms
- `npm run ads:review -- --brand=<slug> | --spec=…` — the required review gate between generate
  and push (account overlap, policy, negatives, copy, landing page, tags, Google validate-only);
  records `review` in each spec — see `ads/README.md`
- `npm run ads:push -- --spec=ads/<brand>/<post>.json [--dry-run|--validate-only|--sync|--enable [--ack-warnings]|--pause|--stage=…]`
  — create / sync / update that campaign through the Google Ads API (see "Google Ads campaigns")
- `npm run ga:setup -- --brand=<slug> [--account=<id>] [--dry-run]` — idempotent GA4 setup via
  the Analytics Admin API: finds/creates property "<Brand> (<domain>)" + web stream under the
  "FOGO Brands" GA account (408983327), 14-month retention, `amazon_click` key event (once per
  session), event dimensions asin/cta_channel/cta_position/page_type, Google Ads link, and writes
  `brand_sites.google_analytics_id`; rebuild afterwards. Live: otis-classic (G-MEK8HE82J9),
  amazing-shields (G-MSNM6LX9HT), bean-envy (G-QC6SMX79QY), tape-king (G-P7WJ67RDEX) — the
  last three have no Ads link until their brand_sites.google_ads_customer_id is set; re-run then.
  Importing `amazon_click` into Google Ads is UI-only (Goals → Conversions → Import → GA4).
- `npm run ads:auth [-- --accounts]` — one-time loopback OAuth (Desktop client in Cloud project
  404956388162; scopes adwords + analytics.edit, Analytics Admin API enabled) that writes `GOOGLE_ADS_REFRESH_TOKEN` into `.env`; `--accounts` lists the
  client accounts under the manager (ids for `brand_sites.google_ads_customer_id`). API version
  defaults to v25 (v20/v21 are sunset); override with `GOOGLE_ADS_API_VERSION`.
- `npm run attribution-report -- --brand=<slug>|all [--days=90] [--dry-run]` — pull the Attribution
  PERFORMANCE/PRODUCTS reports and sync every campaign with traffic (Google Ads → Amazon listing
  ads, creator links, console tags — i.e. everything NOT from the site) into
  `bronze.attribution_campaigns` (campaign_kind dsa|keyword|other, primary_asin, keywords,
  90-day clicks/purchases/sales/BRB, is_active = traffic in last 14 days). Re-run any time;
  upserts on (advertiser_id, campaign_id, ad_group_id). The site's own tags stay in
  `bronze.attribution_links`; the two tables together are the full Attribution picture.

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
- `public.brand_site_paid_links` — paid-channel attribution tags (channel ≠ `brand_site`),
  read soft-fail by `getPaidLinks()`; see "Paid-traffic attribution" below

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
- ASINs whose listing-attribute snapshot has no image locators: list their gallery URLs in
  `scripts/image-supplements/<slug>.json` (`{asin: [urls]}`) — the mirror script falls back to it.
- If the script can't write DB rows (bad key), it saves `scripts/mirror-manifest.json` and
  exits 2 — fix the key and re-run (uploads are idempotent via `x-upsert`).

## Template conventions

- Theming via CSS variable tokens injected in `src/layouts/Base.astro` from the brand row:
  `--brand` = `primary_color`, `--brand-2` = `secondary_color`, `--font-heading` =
  `font_heading`, `--font-body` = `font_body`; neutral `--ink/--bg/--surface` defaults live in
  `src/styles/global.css`. Same pattern as the dashboard's Sharpened Burnished theme. Bean Envy
  palette (from BNV_PreliminaryBrandGuidelines_AMZ_US_102721.pdf): yellow #fecb34, black
  #000000, off-white #efe7e4, orange #eda31d.
- Fonts are self-hosted via @fontsource packages, statically imported in `Base.astro` (unused
  @font-face rules are free — browsers only fetch rendered fonts). To register a new brand
  font: `npm i @fontsource/<font>` + one import line in Base.astro + set
  `brand_sites.font_heading`/`font_body` to the CSS family name. Never load fonts from Google
  Fonts CDN — the shipped site must make no external font requests. Current registry: Archivo
  Black + Inter (Bean Envy ≈ Nimbus Sans Ext), Michroma + Montserrat (Xtreme Comforts ≈
  Eurostile Heavy per their style guide), Fira Sans Condensed + Fira Sans (Otis Classic, per
  OtisClassic_BrandGuidelines.pdf: teal #86BDC2, charcoal #373131), Zilla Slab + Barlow Semi
  Condensed (Amazing Shields ≈ Neue Aachen Pro + Ballinger Condensed per
  STL_Stelucca_US_OnePager_100121.pdf: coral #E56A54, navy #1B365D, mint #9BE3BF, yellow
  #F2C75C, tan #F1E6B2).
- `brand_sites.hero_style` picks the hero layout variant in `Hero.astro`: `'split'` (text
  beside image), `'full-bleed'` (edge-to-edge image, dark overlay, white text), `'minimal'`
  (centered text, no image). NULL = auto (split when hero_image_path set, else minimal).
- Every purchase CTA is `src/components/AmazonCTA.astro`: `attribution_url ?? plain_amazon_url`,
  `target="_blank" rel="sponsored noopener"`, `data-amazon-cta`/`data-asin` for the GA outbound
  event (GA loads only when `google_analytics_id` is set on the brand row).
- Catalog groups by parent (`groupByParent`); variant chips label via title-diffing
  (`variantLabel`), falling back to price then ASIN (identical sibling titles → ASIN chips).
- PDPs emit JSON-LD `Product` with `offers.url` = the Amazon link.
- Canonical host is always `www.<domain>` (`astro.config.mjs` derives `site` from
  `brand_sites.domain`, which stays the bare apex). Every Vercel project must keep www as the
  primary domain with the apex redirecting to it; submit the www sitemap URL in Search Console.
- Blog (per brand, opt-in by content): markdown posts in
  `src/content/brands/<slug>/blog/<post-slug>.md` (schema: `blog` collection in
  `src/content.config.ts` — `title`, `description` ≤200 chars, quoted `date: "YYYY-MM-DD"`,
  optional bucket-relative `hero_image_path`/`hero_alt`, `related_asins`, `draft`). A brand
  with ≥1 published post gets `/blog/` + `/blog/<slug>/` (`src/pages/blog/[...slug].astro`),
  a Blog link in the v1 header/footer nav, and a "From the blog" strip on the v1 homepage;
  brands with no posts build none of it. Authored (`site.yaml`) brands own their nav — add
  the link there. No inline remote images in post bodies; never print an ASIN in post text
  (link to `/products/<asin>/` instead). Blog-index intro copy is per brand in `BLOG_INTROS`
  (`src/pages/blog/[...slug].astro`) — add an entry when launching a blog, else the generic line
  renders. Live on: otis-classic, amazing-shields.
- Blog search brief (every post, enforced by `scripts/check-blog.mjs`, which runs first in
  `npm run build` and standalone as `npm run check:blog [-- --brand=<slug>]`; any FAIL stops
  every brand's build): `target_keyword` (must be in the title and body), `secondary_keywords`,
  `search_intent`, `summary` (renders the "Quick answer" box + schema `abstract`), `faq` ≥2
  (`FaqAccordion` + FAQPage JSON-LD), optional `author` (Person schema). Purchase paths ≥3 per
  post: `cta_early` (product card after the intro, default on) + `cta_after_sections` (exact
  H2 texts; card at the end of each section) + inline `/products/` links + the bottom
  "Featured in this post" strip. `primary_asin` (must be in `related_asins`, defaults to the
  first) is what the cards sell. Cards are `src/components/BlogCta.astro`, injected by
  splitting `entry.rendered.html` at H2s. Also failed: ASIN in text, direct amazon.com links,
  inline images, disease/FDA/"clinically proven" claims. The same brief will feed the Google
  Ads campaign generator (one keyword → H1, slug, ad headline, attribution tag name).
- Blog ↔ PDP backlinks: `PdpGuides.astro` lists posts whose `related_asins` hit the family on
  both v1 and authored PDPs. `/llms.txt` (`src/pages/llms.txt.ts`) and `/robots.txt` (explicit
  AI-crawler allows) are generated per brand from the same data.
- Paid-traffic attribution: `public.brand_site_paid_links` (SQL in `sql/`; every active
  `bronze.attribution_links` row with channel ≠ `brand_site`) is read at build by
  `getPaidLinks()` and embedded as JSON in `Base.astro`. A landing with `gclid`/`gbraid`/
  `wbraid` (or `utm_source=google&utm_medium=cpc`) is stored in sessionStorage for the session
  and every `a[data-amazon-cta]` swaps to the `google_ads` tag for its ASIN, with ValueTrack
  placeholders (`{campaignid}` `{adgroupid}` `{creative}` `{keyword}` …) filled from the landing
  URL; a MutationObserver re-applies after variant switchers rewrite hrefs, and
  `window.fogoResolveCta(asin, fallback)` is exposed for scripts. GA outbound events carry
  `cta_channel` (`google_ads` | `organic`). Insert `google_ads` rows (Amazon Attribution
  macro-enabled tags for Google Ads) into `bronze.attribution_links` to activate; until then
  nothing is emitted and CTAs keep the organic link.
- Google Ads campaigns (one Search campaign per post; specs in `ads/`, see `ads/README.md`):
  `scripts/ads-campaigns.mjs` reads the post's brief (`target_keyword`, `secondary_keywords`,
  optional `ads:` block — `budget_daily`, `max_cpc`, `seeds`, `headlines`, `descriptions`,
  `callouts`, `sitelink`, `negatives`, `path1/2`, all validated by check-blog via
  `scripts/lib/ads-copy.mjs`) and mines `public.brand_site_search_terms(store, asins, days)`
  (service-role RPC over `bronze.ads_search_terms` for the ad groups advertising the post's
  ASIN families). Ad group `guide` = brief keywords; `product` = `ads.seeds` + Amazon terms that
  convert (tier A ≥5 purchases & ≥5% CVR → exact+phrase; tier B ≥2 purchases & ≥3% → exact),
  relevance-filtered (≥60% token overlap with a seed) and vocabulary-filtered (every word must
  occur in the post/brief/product titles — keeps competitor brands out); 1–2 word terms are
  exact-only; product keywords must contain a product noun (head noun of `ads.seeds`, else of
  the target keyword; override `ads.product_nouns`). Keywords live in any other campaign of the
  brand's account (Otis Classic's account also runs Quartile's `QT_*` direct-to-Amazon
  campaigns) or owned by an earlier post are dropped (listed under `excluded`); policy-risk
  terms (N2O, chargers, CBD — `scripts/lib/ads-spec.mjs`) are never bid on. Negatives =
  generic commerce list (never "amazon" or "manual") + relevant Amazon terms with ≥15 clicks and
  no purchase + `ads.negatives`, minus any that would block one of our keywords. RSA copy =
  guide: author lines first, then whole (never truncated) phrases from the brief; product: led
  by product keywords + product title; headline 1 pinned; ASCII only (`adText`). Sitelinks =
  related posts sharing an ASIN family + product + catalog. Final URL = the post; `final_url_suffix` carries
  ValueTrack (`{campaignid}` `{adgroupid}` `{creative}` `{keyword}` …) which the site's
  paid-landing swap fills into the Amazon `google_ads` macro tag. Campaign name
  `fbs-{brand-slug}-{post-slug}` is the join key across Google Ads, GA4 (`utm_campaign`) and
  Amazon Attribution. `scripts/ads-push.mjs` sends one atomic `googleAds:mutate` (budget →
  campaign PAUSED → geo/language/negatives → ad groups → keywords → RSA → sitelink/callout
  assets) with temp ids, writes resource names back into the spec, refuses duplicates, and
  handles `--validate-only`, `--sync` (diff live campaign → spec: keywords, negatives, ad
  groups, RSA replace, sitelinks/callouts, budget, CPC), `--enable`/`--pause`,
  `--stage=maximize_conversions|target_roas`. Every campaign excludes inherited account-level
  CALL assets (no phone numbers, ever). Create / sync / enable require a non-failing
  `ads:review` whose hash matches the spec; enable also requires approved ads, a live campaign
  identical to the spec, and `--ack-warnings`. Shared API code: `scripts/lib/google-ads.mjs`.
  Credentials: `.env` GOOGLE_ADS_* (manager-account OAuth + developer token); client account =
  `brand_sites.google_ads_customer_id`. OAuth setup: Cloud project → OAuth consent screen
  (External, app **published to production** — an app left in Testing expires refresh tokens
  after 7 days; unverified is fine for our own use) → Desktop-app OAuth client → `npm run
  ads:auth` signed in as the manager-account user (writes the refresh token into `.env`). Explorer
  access (2,880 ops/day on production accounts) is enough at our volume; Basic needs OAuth
  brand verification and is only worth it if a feature is gated or volume grows. Bidding progression: maximize clicks (CPC ceiling) →
  maximize conversions once GA4 `amazon_click` is imported as a conversion → target ROAS once
  Attribution purchases are uploaded. Never enable a campaign from a script without a human
  having read the spec.
- `toISOString().slice(0,10)` is banned in any script — use a local-date helper if dates are
  ever needed. Never generate files via PowerShell here-strings — write files directly.
- Complete files only, no partial snippets; validate Astro/JSX parses before finishing.

## Per-brand rollout (scope §6, ~30–45 min once template is stable)

1. Insert `bronze.brand_sites` row — `brand` must match `bronze.products.brand` EXACTLY;
   slug, domain, store, tagline, `primary_color`/`secondary_color` (brand-guide PDFs live in
   Google Drive under Brand Assets/<brand>), upload logo to
   `brand-site-images/{slug}/logo.*` and set `logo_path`.
   Optional visual content (all bucket-relative paths, mirrored owned creative — the brand's
   Amazon storefront tiles are a great source; strip the `._CR..._SX..._` transform suffix
   from store image URLs for full resolution): `hero_image_path` (square lifestyle shot →
   split hero), `about_banner_path` (wide banner on /about), `feature_tiles` jsonb
   `[{image_path, label, asin}]` (home "Shop by category" grid linking to PDPs).
2. `node scripts/mirror-images.mjs --brand=<slug>`.
3. Attribution tags: run `npm run attribution-tags -- --brand=<slug> --channel=brand_site` and
   again with `--channel=brand_site_blog` (then `--channel=google_ads` for the paid-traffic
   swap). Ads API creds come from `public.ads_api_accounts` keyed by `brand_sites.store` (needs
   `SUPABASE_SERVICE_ROLE_KEY`; run from Git Bash as `env -u SUPABASE_SERVICE_ROLE_KEY node …`
   so `.env` wins over the stale inherited var). `--probe` lists the profile's advertisers +
   publishers, `--dry-run` previews, `--force` overwrites. Advertiser = the store's sole
   Attribution advertiser (auto-picked; `--advertiser=<id>` if a profile exposes several).
   Publishers (Amazon has no "Website" option): `brand_site` → **Display - Other** (product /
   catalog / home CTAs), `brand_site_blog` → **Blogpost - Other** (CTAs on /blog/ pages; the
   blog page swaps them in via `getPaidLinks()`); `--publisher=<id>` overrides. How the API
   actually works (the docs' method/placeholder names are wrong): `GET /attribution/tags/
   nonMacroTemplateTag?publisherIds=&advertiserIds=` returns ONE template per (advertiser,
   publisher) with `{insertCampaign}` / `{insertAdGroupId}` / `{insertCreativeId}`
   placeholders; the script fills them per ASIN with `fbs-{slug}-{channel}` / `site|blog` /
   `{asin}` (stored in `campaign_name`), so tags cost no per-ASIN API calls. `macroTag` is the
   same GET. Idempotent (existing active rows skipped). Rebuild afterwards so the URLs ship.
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
