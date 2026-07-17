# Xtreme Comforts v2 — status & handoff

Working branch: `claude/planning-session-kaopi8`. Scope doc: `XTREME_SITE_V2_SCOPE.md`
(repo root). This file tracks what's done, what's decided, and what's next, so any
session (Claude Code desktop or web) can pick up mid-stream.

## Decisions locked (Kennon, 2026-07-17)

- **Review claim:** "50,000+ verified Amazon reviews" / 4.3★. The raw per-ASIN sum
  (262,847) double-counts — Amazon pools reviews per listing family, so aggregation is
  MAX per family (51,492 verified), summed across the 9 families. Driven live from
  `public.brand_site_review_stats` (Keepa) at build; never hardcode.
- **Flagship family:** shredded memory foam pillow (B0G5Q8C8RG, 11 variants).
- **Attribution links:** populated AFTER v2 ships (Kennon console task). Build already
  logs the miss list. 0/41 today.
- **Photography:** interim — best existing mirrored/storefront assets + AI-assisted
  fills, flagged for replacement after a real shoot.
- **Review excerpts:** Claude drafts candidates → Kennon must replace/approve with real
  verified quotes. The review wall renders NOTHING until approved content exists.
  Never ship drafted text presented as an Amazon review.

## Phase 0 corrections to the scope doc

- Site already live from this multi-brand repo (BRAND_SLUG per Vercel project).
- Attribution source is `bronze.attribution_links` (view-joined `attribution_url`),
  NOT `public.ad_landing_pages` (doesn't exist).
- Catalog: 41 ASINs / 9 families. No B0GSHC9GNB family, no lumbar family. Slim pillow
  is standalone B014E9UMHI. Wedge covers (B09Z37J83D, ×15) are accessories.
- Keepa date column is `created_at` (view exposes it as `as_of`).

## Done

- **PR 1 — plumbing** (commits `ace3ec1`, `36ae18b`): content collections
  (`src/content.config.ts`, brand-scoped under `src/content/brands/<slug>/`),
  `src/lib/content.js` merge layer (family MAX review aggregation, authoring
  validation fails builds loudly), `getReviewStats()` + attribution-miss report in
  `src/lib/supabase.js`, `public.brand_site_review_stats` view (migration applied,
  anon SELECT only), GA4 `outbound_amazon_click` {asin, page_type, cta_position}
  dual-fired with legacy `amazon_click`, same-tab-on-touch CTA handoff,
  `src/styles/tokens.css` (defaults reproduce v1 exactly), `scripts/check-dist.mjs`
  ASIN guard (strict for authored brands, warn-only otherwise; runs on Vercel via
  `npm run build`), `products/[asin]→[slug].astro` rename (URLs unchanged).
  Verified: bean-envy + xtreme dists byte-identical to baselines except intended
  deltas; merge smoke-tested end-to-end (51,492 @ 4.3 confirmed in-build).

## PR 2 — design system ("Rested Modern") — DONE, gate passed

Built 2026-07-17 (desktop session, frontend-design skill). **Gate PASSED:
Kennon approved palette + type 2026-07-17** ("i like the look and feel").
Preview at `/design-preview` (temp page, local-only/uncommitted; run
`npm run dev` with BRAND_SLUG=xtreme-comforts).

Chosen direction ("dusk to first light"): ink-navy #222839 / night #171C29 +
linen #F4F0E7 / oat #EAE3D3 + ONE accent, honeyed amber #D39A3F (bronze
#875E17 as the AA text-accent). Type: Fraunces (display, 500) + Figtree
(body), self-hosted via @fontsource. Signature element: sleep-position
iconography (side/back/stomach/combination, `ui/SleepPosition.astro`) — used
in badges, comparison tables, PDP fit guidance.

Shipped: `src/styles/brands/xtreme-comforts.css` (full token contract +
focus-visible + `.reveal` motion util, reduced-motion safe); Base.astro loads
`src/styles/brands/<slug>.css` via eager `?raw` glob and inlines it INSTEAD of
the DB themeVars (bean-envy path unchanged); ui/{Button,Badge,ReviewStars,
SectionHeader,SleepPosition} + TrustBar, FaqAccordion, ComparisonTable,
VariantSelector, StickyCta; ProductCard `authored` prop branch (without it →
v1 markup, only inter-tag whitespace shifted).

⚠ Cascade correction to PR 1 notes: Astro places the bundled stylesheet LINK
*after* inline head styles, so tokens.css would beat an inline brand sheet for
any token both define (v1 never noticed — themeVars only sets vars tokens.css
omits). The brand sheet therefore uses `:root:root` to out-specify tokens.css
regardless of order. Keep that doubled selector.

Verified: both brands build clean (check-dist passes); bean-envy dist vs
pre-PR2 baseline differs only by CSS bundle hash, added font files, and
ProductCard whitespace collapse — zero markup/visual changes.

### PR 2 direction brief (scope §6, for reference)

- Palette: deep restful ink/night-navy family + warm linen/oat neutrals + ONE accent
  with genuine character. Explicitly avoid: cream+terracotta, near-black+acid-green,
  the dashboard's Sharpened Burnished tokens, and the current cyan (#00B7D2)/black.
- Type: characterful display face (hero/section leads only) + readable body. Not
  Manrope (dashboard), not Michroma/Montserrat (current techy pairing — wrong voice).
  Google Fonts/Fontshare, self-hosted via @fontsource (import weights only).
- One signature element (e.g. sleep-position iconography or texture-macro motif);
  motion = one hero moment + subtle scroll reveals, respect prefers-reduced-motion.
- Quality floor: 360px responsive, visible focus, semantic HTML, Lighthouse ≥95.

Deliverables:

- `src/styles/brands/xtreme-comforts.css` — :root token overrides (see
  `src/styles/tokens.css` for the vocabulary; keep the `--brand/--brand-2/--ink/--bg/
  --surface/--accent/...` contract).
- `Base.astro`: load `src/styles/brands/<BRAND_SLUG>.css` via `import.meta.glob` when
  it exists; when it does, skip injecting DB `--brand/--brand-2`/fonts (the inline
  `themeVars` <style> otherwise wins the cascade). Bean-envy path must be unchanged.
- Components: `ui/Button`, `ui/Badge`, `ui/ReviewStars`, `ui/SectionHeader`,
  `TrustBar`, `FaqAccordion`, `ComparisonTable`, `VariantSelector`, `StickyCta`,
  plus an `authored` prop branch on `ProductCard` (without it → today's card exactly).
  All colors/type/spacing via tokens only.
- **Gate: Kennon approves palette + type before merge.**

⚠ Deploy note: once `src/styles/brands/xtreme-comforts.css` exists and Base.astro
loads it, a master merge restyles the LIVE xtreme site while it still has v1 layout.
Keep PR 2–5 on this branch and merge to master as one unit at launch.

## PR 3 — content authoring — BUILT, awaiting copy gate

Built 2026-07-17. **Gate outstanding: Kennon approves all copy before merge.**

- 9 family YAMLs (not 7 — the real catalog has 9 Amazon families): 6 nav
  (shredded-pillow, slim-pillow, seat-cushions, back-lumbar, wedge-body,
  foam-filler) + 3 accessory cover families (nav:false, accessory_of:
  wedge-body). Plus needs.yaml (4 needs: neck-support, all-day-sitting,
  elevated-rest, refresh-refill) and site.yaml.
- All claims sourced from listing data (GREENGUARD/UL, CertiPUR-US, OEKO-TEX,
  made-in-USA, 30°/7" wedge, machine-washable). Comparison block on the
  flagship uses generic fill categories, no named competitors.
  review_excerpts/review_wall are EMPTY by design (real quotes only, Kennon).
- ⚠ For Kennon: 3 provisional variant labels in seat-cushions.yaml
  (B09H3JG56W "Everyday" / B01N2VSUAE "Extra-support" / B09KNVQRMK "Premium"
  — titles identical, differentiators not in our data; correct before launch).
  Also flagged: Amazon groups the body pillow with the wedge (shared PDP
  "Wedge & Body Pillows"), and slim Standard/Queen sit inside the flagship
  family while slim King is standalone.
- Wiring: authoring flipped check-dist to strict, which caught the 15
  wedge-cover ASIN chips (identical titles → ASIN fallback). Fixed by
  preferring authored labels: getMergedCatalog() labels now feed ProductCard
  chips + PDP option chips (index, products/index, products/[slug]).
  Unauthored brands pass an empty Map — bean-envy verified unchanged
  (PDP/about byte-identical mod css hash; home/catalog whitespace-only).
- check-dist: OK — zero ASINs in rendered text across all 47 xtreme pages.

## PR 4 — homepage rebuild — DONE

Built 2026-07-17. index.astro branches on getSiteContent(): site.yaml present →
v2 homepage (scope §8.1 order: hero + TrustBar, shop-by-need, flagship
feature, why-us on night, review wall [renders nothing until real quotes],
comparison teaser); absent → v1 exactly (bean-envy verified clean, including
the restored brand.about_html "Our story" section). Header nav + Footer are
authored-gated the same way (v2 footer: night palette, trust claims line,
disclosure-as-logistics). Scroll reveals are additive (js-reveal class via
script; no-JS and reduced-motion safe). Header nav wraps at 360px.

Gotchas discovered:
- Inside a JSX-ternary branch Astro TRIMS whitespace-only text between
  adjacent expressions: `{year} {brand.brand}` renders "2026Brand". Use a
  template literal for any such line in component branches.
- Headless Chrome CLI screenshots clamp to ~500px min window width — mobile
  captures below that are cropped, not reflowed. Verify 360-375px with DOM
  measurements (documentElement.scrollWidth) instead.

Launch checklist additions: run Lighthouse (target ≥95 perf mobile) on home +
flagship PDP before flipping DNS; hero uses fetchpriority="high" (no
<link rel=preload> — revisit only if Lighthouse complains). Home flagship CTA
and needs cards link to /products/shredded-pillow/ and /collections/* — the
collections routes and family-slug PDPs land in PR 5 (404 on this branch
until then).

## PR 5 — family PDPs + collections + redirects + sitemap — DONE

Built 2026-07-17.

- products/[slug].astro: authored brands render one v2 PDP per family slug
  (full §9.1 template: gallery, badges, stars, price range, interactive
  variant chips [aria-pressed CSS state; script swaps price + both CTAs' href
  and data-asin — verified live], benefit trio [ui/BenefitIcon glyph map],
  fit guide + anti-fit cross-sell, specs dl, comparison table, review
  excerpts [empty until approved], FAQ, long description, StickyCta).
  Every child ASIN URL → noindex meta-refresh stub with canonical → family
  page, so live URLs never break. Unauthored brands keep v1 ASIN PDPs.
- /collections/[slug]: 4 needs + 4 category routes (categories added to
  needs.yaml + content.config.ts schema; getCategories() in content.js).
  Editorial intro + repeated TrustBar + authored ProductCards. Needs pages
  are the future ads landing destinations.
- products/index.astro: authored branch = editorial catalog (family cards,
  accessories hidden). Fixed a second adjacent-expression whitespace bug
  ("15products") in the v1 branch — template literal, same as PR 4.
- astro.config.mjs sitemap filter: authored brands exclude /products/<ASIN>/
  stubs (bean-envy sitemap unchanged, 15 ASIN PDPs still listed).
- JSON-LD on family PDPs: Product + AggregateOffer (low/high/offerCount).
  **AggregateRating deliberately omitted — pending Kennon's call on sourcing
  schema rating from Amazon review data.**
- check-dist: OK across 64 xtreme pages; bean-envy parity: intentional
  header nav-wrap class + whitespace only.

## Pre-launch revisions (Kennon, 2026-07-17)

- **Slim pillow folded into the flagship family.** slim-pillow.yaml deleted;
  B014E9UMHI is adopted into B0G5Q8C8RG via the new adoption logic in
  content.js (authored variants may claim an ASIN stranded in its own
  single-ASIN unauthored group). It joins the price range, review MAX, the
  variant chips ("Slim · King"), and stub generation (/products/B014E9UMHI/
  → /products/shredded-pillow/).
- **Shredded Foam Filler removed from the site.** Data-layer:
  bronze.brand_site_product_overrides.hide_from_site=true for B01DR0YUXC,
  B01DR5GDIC, B07HB52YZL, B07WW975P9 (flip back to false to restore).
  foam-filler.yaml deleted; refresh-refill need + filler category removed;
  homepage needs grid now 3 cards. The old filler ASIN URLs 404 by design.
- **AggregateRating added to family PDP JSON-LD** (Kennon approved sourcing
  schema rating from Amazon review data): ratingValue/reviewCount from the
  live family aggregate; omitted automatically when stats are stale.
- **LAUNCHED 2026-07-17**: branch merged to master with all of PR 1–5;
  Vercel git integration deploys xtremecomforts.com (and rebuilds bean-envy,
  verified byte-safe). Still open post-launch: seat-cushion variant label
  differentiators, real review quotes (site renders nothing until then),
  attribution links + campaign, Lighthouse pass, Search Console re-submit.

## Then
- **Review quotes (Kennon)**: `REVIEW_EXCERPT_CANDIDATES.md` (repo root, on
  this branch) holds draft theme targets + search terms + paste-ready YAML
  shapes. Replace each with a verbatim verified Amazon quote; never publish
  the drafts; delete the file at launch.
- **Launch ops (Kennon)**: attribution campaign + `bronze.attribution_links` inserts,
  `brand_sites` row update (colors/fonts/tagline to final tokens), deploy hook,
  Search Console re-submit.

## Dev notes

- Local build needs `.env` (SUPABASE_URL, SUPABASE_ANON_KEY publishable key,
  BRAND_SLUG). Always verify BOTH brands build:
  `BRAND_SLUG=xtreme-comforts npm run build` and `BRAND_SLUG=bean-envy npm run build`
  (bean-envy output must not change except deliberate shared plumbing).
- The remote (web) sandbox blocks `*.supabase.co`; builds there use a local fixture
  server. Desktop with normal network hits Supabase directly — nothing special needed.
