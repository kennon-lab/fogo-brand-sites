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

## Next: PR 2 — design system ("Rested Modern")

**Run the `frontend-design` skill for this phase** (brainstorm → token plan →
critique → build). Direction brief (scope §6):

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

## Then

- **PR 3 — content authoring**: 7 family YAMLs + needs.yaml + site.yaml (voice: scope
  §7 — benefit-led, specific, no exclamation marks, no medical claims, no "Xtreme"
  wordplay). Gate: Kennon approves all copy.
- **PR 4 — homepage rebuild** (section order: scope §8.1).
- **PR 5 — family PDPs + /collections/[slug] + ASIN redirect stubs + sitemap filter**
  (scope §9; JSON-LD AggregateOffer/AggregateRating — confirm Kennon is comfortable
  sourcing schema rating from Amazon reviews).
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
