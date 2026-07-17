# XTREME_SITE_V2_SCOPE.md
**Xtreme Comforts — xtremecomforts.com v2 ("$100M Brand" Upgrade)**
Scope document for Claude Code implementation. Version 1.0 — 2026-07-16.

---

## 1. Context & Objective

xtremecomforts.com is currently a catalog site auto-generated from Amazon product data (Astro static build, product pages keyed by ASIN, raw Amazon SEO titles, white-background pack shots, `View on Amazon` CTAs). It functions correctly as a Brand Referral Bonus (BRB) pre-sell surface but reads as a reseller catalog, not a brand.

**Objective:** Rebuild the presentation layer so the site reads as a premium DTC sleep brand on par with Coop Home Goods / Purple / Casper — while keeping its actual job unchanged: build buyer confidence, then send the click to Amazon with a per-store Amazon Attribution tag (BRB strategy).

**Strategic frame:** The conversion event is a *click to Amazon*, not a cart checkout. There is no cart friction to optimize. Every page's single job is belief. This permits harder editorial confidence-building (comparison tables, expert positioning, aggressive social proof) than a normal DTC site.

**Unfair advantage to exploit:** A decade of accumulated Amazon reviews across the catalog. Aggregate review counts and ratings are the primary trust asset — surface them everywhere.

---

## 2. Goals & Success Metrics

| Goal | Metric | Target | Source |
|---|---|---|---|
| Site reads as premium brand | Qualitative: zero raw ASINs, zero Amazon SEO titles visible anywhere | 100% | Manual audit |
| Pre-sell → Amazon click-through | Outbound CTA CTR on paid landing sessions | Baseline first 2 wks, then +30% | GA4 / attribution URLs |
| BRB-attributed conversion | Attributed sales via Amazon Attribution console | Trend up post-launch | Amazon Attribution |
| External traffic → rank | Organic rank movement on target keywords for promoted ASINs | Directional | DataDive rank radars |
| Blended efficiency | TACoS on Xtreme Comforts brand | Flat-to-down while external spend scales | FOGO Dashboard |

Measurement philosophy per existing external-traffic strategy: TACoS + organic rank movement, not channel ACoS.

---

## 3. Non-Goals (v2)

1. **No on-site checkout/cart.** Amazon remains the transaction layer. Do not add Shopify, Stripe, or any commerce backend.
2. **No multi-brand templating yet.** Bean Envy gets the same treatment later; do not generalize prematurely. Build clean, extract patterns in a future pass.
3. **No CMS integration.** Content lives in the repo (content collections / JSON / MD). Revisit if non-engineers need to edit copy.
4. **No blog / SEO content engine.** Sleep-guide editorial content is a v3 consideration (P2).
5. **No customer accounts, email flows, or reviews-collection widget.** Email capture is P1 (single field, no ESP automation build-out in this scope).

---

## 4. Phase 0 — Discovery & Verification (REQUIRED FIRST)

Per standard practice: **verify before building. Do not assume repo structure, data shapes, or column names.**

Claude Code must confirm and document in a `## Phase 0 findings` note at the top of its working branch:

- [ ] Repo location and structure for the website (separate repo from `fogo-dashboard` — confirm name/path with Kennon if not obvious).
- [ ] How product data currently enters the build: static JSON? Build-time fetch from Supabase? Which tables/views? (Likely derived from `bronze.products` / Keepa data — verify actual source.)
- [ ] Where product images come from (Amazon image URLs cached locally? `_astro` pipeline?).
- [ ] Deployment target (assume Vercel; confirm).
- [ ] Whether `public.ad_landing_pages` migration (drafted, pending review) has been applied — it defines the per-store Amazon Attribution URL mapping this site must consume. If not applied, flag to Kennon before Phase 3.
- [ ] Available review-count / rating data per ASIN. Candidate source: Keepa tables in Supabase (`bronze.keepa_*` — verify which table carries `review_count` / `rating` and freshness). If unavailable, aggregate numbers get hardcoded in the presentation layer with a `last_verified` date field.

**Blocking questions for Kennon (answer before Phase 3):**
1. Confirm the canonical Amazon Attribution URL per (ASIN → store) mapping source. `ad_landing_pages` table, or per-link manual config for v2?
2. Photography: budget/timeline for a real shoot vs. interim AI-assisted pipeline (see Appendix A)? Phases 1–2 proceed either way; Phase 3 hero quality depends on this.
3. Aggregate review claim: what number are we comfortable publishing? (e.g., "90,000+ verified Amazon reviews" — needs to be defensible from Keepa/SP-API data.)

---

## 5. Phase 1 — Presentation Layer Data Model

**Problem:** The site renders Amazon's data verbatim. Amazon SEO titles ("Xtreme Comforts Memory Foam Pillows Made in The USA - King Size, Slim Cooling Pillow for Sleeping on Side...") and raw ASINs in variant pickers are the loudest "reseller" tells.

**Solution:** A brand-content layer that sits on top of Amazon product data. Amazon data remains the source of truth for price/availability/ASIN mapping; the presentation layer owns everything human-facing.

### 5.1 Schema (site repo — content collection or JSON, not Supabase)

Per product family (parent-level concept, not per-ASIN):

```yaml
# content/products/slim-cooling-pillow.yaml
slug: slim-cooling-pillow
display_name: "The Slim Cooling Pillow"
tagline: "Low-profile memory foam for back & stomach sleepers"
category: pillows            # pillows | wedge | seat-lumbar | filler
needs: [back-sleepers, stomach-sleepers, hot-sleepers, neck-pain]
hero_benefit: "Wake up aligned, not overheated"
description_short: "..."     # 1–2 sentences, brand voice
description_long: "..."      # PDP body copy, brand voice
badges: [made-in-usa, certipur, machine-washable, warranty-XX]
review_aggregate:
  count: 41200               # from Phase 0 data source
  rating: 4.4
  last_verified: 2026-07-16
faq:
  - q: "..."
    a: "..."
variants:
  - asin: B014E9UMHI
    label: "King"            # human label — NEVER the ASIN
    price_display: "$39.99"  # or pulled at build time — per Phase 0 findings
  - asin: B014E9UO12
    label: "Queen"
comparison:                  # optional — powers the vs-competitor table
  competitors: [...]
images:
  hero_lifestyle: ...
  gallery: [...]
```

### 5.2 Rules

- **Every rendered product surface** reads from the presentation layer. Amazon titles may exist in data files but never render.
- Variant selectors render `label` only. An ASIN appearing in visible UI anywhere is a build failure — add a CI grep check: `grep -rE '>B0[A-Z0-9]{8}<' dist/` must return empty.
- Products without presentation-layer entries fall back to a **hidden-from-nav** state, not a raw-data render. v2 launches with the top revenue families fully authored (see 5.3); long-tail (cover colors, etc.) can remain unauthored and unlisted.
- `needs` taxonomy powers Phase 4 collection pages and the Phase 5 quiz. Keep the vocabulary controlled (define once in `content/needs.yaml` with display names + descriptions).

### 5.3 Authoring scope (v2 launch set)

Author presentation entries for the top families by 30d revenue — pull actuals from FOGO Dashboard / `mrp_daily` at implementation time. Expected set (verify):
1. Slim memory foam pillow family (incl. B0GSHC9GNB parent family — ~$139K/30d)
2. Shredded memory foam pillow family
3. Wedge pillow family (+ covers as accessories, not standalone nav items)
4. Seat cushion family
5. Lumbar cushion family
6. Bean bag / shredded foam filler family

Copy: written in brand voice (Section 7). Claude drafts, Kennon approves before merge.

---

## 6. Phase 2 — Design System

Claude Code: **run the `frontend-design` skill process for this phase** (brainstorm → token plan → critique → build). The direction below is the brief; the skill governs execution quality.

### 6.1 Brand direction: "Rested Modern"

A sleep brand should feel like the *result* of the product: calm, unhurried, quietly confident. Premium via restraint and precision, not decoration.

- **Palette direction:** anchor in deep, restful dark (ink/night navy family) + warm textile neutral (linen/oat family) + one accent with genuine character. **Explicitly avoid** the generic AI-default cream-plus-terracotta look and the near-black-plus-acid-green look. Do not reuse the dashboard's Sharpened Burnished tokens — internal tooling and consumer brand are different identities. Final hexes chosen during the frontend-design pass with justification.
- **Typography:** characterful display face (used with restraint — hero, section leads) + highly readable body face. Not Manrope (dashboard identity). License-free (Google Fonts / Fontshare acceptable).
- **Signature element:** propose one ownable device (e.g., a recurring "sleep position" iconography system, or a texture-macro photographic motif used as section dividers). One risk, executed well; everything else quiet.
- **Motion:** one orchestrated hero moment + subtle scroll reveals max. Respect `prefers-reduced-motion`. No scattered effects.
- **Quality floor:** responsive to 360px, visible keyboard focus, semantic HTML, Lighthouse ≥ 95 performance on homepage and PDPs (static Astro — no excuse otherwise).

### 6.2 Deliverables

- `src/styles/tokens.css` — full token system (color, type scale, spacing, radius, shadow).
- Component library: `Button`, `Badge`, `ReviewStars`, `TrustBar`, `ProductCard`, `VariantSelector`, `ComparisonTable`, `FaqAccordion`, `SectionHeader`, `AmazonCta`.
- `AmazonCta` is the **only** component allowed to emit outbound Amazon links (see 8.3).

---

## 7. Copy Voice

- Benefit-led, specific, unhurried. "Wake up without the neck pain" > "Comfort, engineered for every day."
- Plain verbs, sentence case, no exclamation marks, no "Xtreme" wordplay.
- Specificity is the premium signal: foam density numbers, certification names, wash instructions, years in market, review counts.
- Never over-claim: no medical claims (FDA territory), no "best pillow in the world." "Helps relieve pressure" not "cures neck pain."
- The Amazon relationship is framed as a *feature*: "Checkout on Amazon — Prime shipping, Amazon returns, and the reviews to prove it."

---

## 8. Phase 3 — Homepage Rebuild

### 8.1 Section order

1. **Hero.** Lifestyle photograph (or best interim asset), benefit headline, sub-line, primary CTA ("Find your pillow" → quiz when built; "Shop pillows" until then). Trust strip directly beneath: `★ 4.4 · [N]+ verified Amazon reviews · Made in the USA · CertiPUR-US certified`.
2. **Shop by need.** 4–5 cards from the `needs` taxonomy (Side sleepers / Back & stomach / Neck & shoulder relief / Reflux & elevation / Desk & drive). Not "shop by category" — the sleeper's problem, not our warehouse layout.
3. **Flagship product feature.** The hero family with lifestyle imagery, 2–3 benefit bullets, review aggregate, CTA to PDP.
4. **Why Xtreme Comforts.** 3–4 proof points with icons: Made in USA / a decade on Amazon / [N]+ reviews / CertiPUR-US / machine washable. Short founder-credibility line.
5. **Review wall.** 6–9 curated real Amazon review excerpts (name, star rating, product). Rotate per season.
6. **Comparison teaser.** "Premium comfort without the premium markup" — small table vs. category price anchors ($100+ DTC pillows), linking to full comparison on PDPs.
7. **Footer.** Proper brand footer: nav, certifications, contact, the Amazon-checkout disclosure moved to small print (it currently reads like an apology — it should read like logistics).

### 8.2 Acceptance criteria

- [ ] No Amazon SEO title or ASIN visible anywhere.
- [ ] Review aggregate renders from presentation-layer data with `last_verified` ≤ 90 days.
- [ ] Hero LCP image optimized (AVIF/WebP, preloaded), Lighthouse perf ≥ 95 mobile.
- [ ] All outbound CTAs go through `AmazonCta` (8.3).

### 8.3 `AmazonCta` component — attribution contract

- Props: `asin`, `store` (optional override), `variant` (primary/secondary/text).
- Resolves outbound URL: Amazon Attribution tagged URL for (asin → store) from the mapping source confirmed in Phase 0 (expected: `public.ad_landing_pages`); falls back to clean `https://www.amazon.com/dp/{asin}` if no tag exists, and logs the miss at build time.
- Emits GA4 event `outbound_amazon_click` with `asin`, `page_type`, `cta_position`.
- `rel="noopener"`, opens same tab on mobile (app-handoff friendly), new tab desktop.

---

## 9. Phase 4 — PDP & Collection Pages

### 9.1 PDP template (per product family)

1. Gallery (lifestyle-first ordering; pack shot demoted to slot 3+) + name, tagline, review stars/count, price range, variant selector (human labels), `AmazonCta` primary.
2. Benefit trio (3 columns, icon + 2 lines each) — drawn from `hero_benefit` + copy.
3. "Who it's for" — sleep-position fit guide (uses `needs`). Honest anti-fit line included ("Not for you if you sleep exclusively on your side and like a tall loft — try [X] instead"). Cross-sell that builds trust.
4. Specs & materials — foam density, dimensions, cover material, wash care, certifications, country of origin. Dense, factual, confident.
5. Comparison table (when `comparison` data authored) — vs. 2–3 named premium competitors on price / trial-returns / certification / washability. Factual claims only, sourced.
6. Review excerpts (family-specific, curated).
7. FAQ accordion (from presentation layer).
8. Sticky mobile CTA bar (name + price + `AmazonCta`) after scroll past hero.

### 9.2 Collection pages

- One route per `needs` value + one per `category`. Thin editorial intro (2–3 sentences, genuinely useful guidance), then `ProductCard` grid.
- `needs` pages are the Google Ads landing destinations — they must stand alone as pre-sell pages (intro carries persuasion weight, trust strip repeats).

### 9.3 Acceptance criteria

- [ ] Every launch-set family has a fully authored PDP; unauthored products 404 or redirect to nearest family (no raw renders).
- [ ] Sticky CTA fires the same GA4 event with `cta_position: sticky`.
- [ ] Each `needs` page reachable from homepage in one click.

---

## 10. Phase 5 — Quiz, Comparison Depth, Trust Content

**P1 — build after Phases 1–4 ship and paid traffic baseline is measured.**

1. **Pillow finder quiz.** 4–5 questions (sleep position, firmness preference, run hot?, pain points, budget). Client-side scoring against `needs` + product metadata → recommends 1 primary + 1 alternate with reasoning shown ("Because you sleep on your back and run hot..."). No backend; result CTA is `AmazonCta`. This is the single highest-converting pattern in the category (Coop, Purple both lead with it).
2. **About page rebuild.** Founder/company story, decade-on-Amazon arc, manufacturing (Made in USA — show it), why we sell through Amazon (turn the disclosure into a strength).
3. **Guarantee page.** Consolidate warranty/returns policy in brand voice (returns are Amazon's — frame as "backed by Amazon's return policy plus our XX-day comfort promise" if a promise exists; confirm with Kennon).
4. **Email capture** (footer + exit intent on collection pages): single field, "Sleep better for less — occasional deals, no spam." Store target TBD (P1 open question — likely a Supabase table + FogoRelay for sends later).

---

## 11. Explicitly Deferred (P2 parking lot)

- Bean Envy site treatment using extracted patterns from this build.
- Sleep-guide editorial/SEO content engine.
- On-site review syndication widget (live SP-API review pulls).
- A/B testing framework on landing pages (do manual variant tests via separate `needs` routes first).
- Walmart CTA variants (relevant if/when Walmart Marketplace expansion lands).

---

## 12. Implementation Order & Estimates

| Phase | Scope | Est. |
|---|---|---|
| 0 | Discovery & verification | 0.5 day |
| 1 | Presentation layer + launch-set authoring | 1.5–2 days (copy drafting dominates) |
| 2 | Design system (frontend-design skill pass) | 1 day |
| 3 | Homepage | 1 day |
| 4 | PDPs + collections | 1.5–2 days |
| 5 | Quiz + trust content (P1) | 1.5 days |

Phases 1–4 = launchable v2. Ship, point a small Google Ads budget at 2 `needs` pages, baseline CTR for 2 weeks, then build Phase 5.

---

## Appendix A — Photography Shot List

Real shoot strongly preferred; interim AI-assisted (Gemini pipeline) acceptable for launch if flagged for replacement. Consistency rules regardless of source: one lighting story (soft morning window light), one interior style (warm minimal bedroom, lived-in not staged), consistent color grade matching brand tokens.

**Per flagship family (pillows):**
1. Hero lifestyle — pillow on made bed, morning light, no people. (Homepage + PDP slot 1)
2. In-use — person sleeping, natural posture, back/side variants matching `needs`. (PDP slot 2, needs pages)
3. Texture macro — foam shred / surface weave close-up. (Signature motif candidate, section dividers)
4. Scale & hands — hands compressing foam, showing rebound. (Benefit sections)
5. Detail — zipper, tag, stitching, care label. (Specs section)
6. Wash shot — cover going into washing machine. (Washability proof)

**Wedge family:** elevation in use (reading + sleeping angle), profile shot showing incline geometry.
**Seat/lumbar:** desk context + car context.
**Brand:** Made-in-USA manufacturing photo/video if obtainable — highest-trust asset on the About page.
**UGC-style:** 3–5 phone-quality authentic shots for the review wall (sourced from actual customer imagery if rights permit, else staged casual).

---

## Appendix B — Data Integration Points (Supabase project `avlhnogtosjxdyibjipz`)

| Need | Expected source | Verify in Phase 0 |
|---|---|---|
| ASIN → store mapping | `bronze.products` (canonical, DISTINCT ON pattern) | ✔ |
| Attribution URLs | `public.ad_landing_pages` (migration pending review) | ✔ — may not be applied yet |
| Review counts/ratings | Keepa tables (`bronze.keepa_*`) | ✔ — identify exact table + freshness |
| Prices at build time | Static in presentation layer v2 (manual), or Keepa/SP-API pull | Decide in Phase 0 — manual is fine for launch |

Site build reads Supabase (if at all) at **build time only** with the `sb_publishable` key — no runtime client-side Supabase calls from the public site.
