// Brand presentation layer: authored, human-facing content that sits on top of
// the Amazon-derived catalog data (public.brand_site_products). Amazon data
// stays the source of truth for price / availability / ASIN mapping; entries
// here own display names, taglines, variant labels, long copy, FAQs, etc.
//
// Layout: src/content/brands/<brand-slug>/{site.yaml, needs.yaml, products/*.yaml}
// A brand with no entries ("unauthored") renders exactly as v1 — every v2
// surface gates on isAuthoredBrand() in src/lib/content.js.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const ASIN = /^B0[A-Z0-9]{8}$/;

const BADGES = z.enum([
  'made-in-usa',
  'certipur',
  'greenguard',
  'oeko-tex',
  'machine-washable',
  'warranty',
  'prime',
]);

const products = defineCollection({
  loader: glob({ pattern: '*/products/*.yaml', base: './src/content/brands' }),
  schema: ({ image }) =>
    z.object({
      // groupKey() value: parent_asin, or the asin itself for standalone products.
      family_key: z.string().regex(ASIN),
      display_name: z.string(),
      tagline: z.string(),
      category: z.enum(['pillows', 'wedge', 'seat-lumbar', 'filler']),
      // Slugs from this brand's needs.yaml — cross-validated at build in content.js.
      needs: z.array(z.string()).default([]),
      hero_benefit: z.string(),
      description_short: z.string(),
      description_long: z.string(),
      badges: z.array(BADGES).default([]),
      // false = accessory (e.g. wedge covers): PDP exists but hidden from nav/grids.
      nav: z.boolean().default(true),
      accessory_of: z.string().optional(), // family slug this accessorizes
      benefits: z
        .array(z.object({ icon: z.string(), title: z.string(), body: z.string() }))
        .length(3)
        .optional(),
      who_its_for: z
        .object({
          fits: z.array(z.string()),
          anti_fit: z.string().optional(), // honest "not for you if…" line
          anti_fit_alternative: z.string().optional(), // family slug to point at instead
        })
        .optional(),
      specs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
      variants: z
        .array(
          z.object({
            asin: z.string().regex(ASIN),
            label: z.string(), // human label — an ASIN must never render in UI
          })
        )
        .min(1),
      comparison: z
        .object({
          claim_note: z.string().optional(), // sourcing note for us, never rendered
          competitor_names: z.array(z.string()).max(3),
          rows: z.array(
            z.object({ feature: z.string(), us: z.string(), competitors: z.array(z.string()) })
          ),
        })
        .optional(),
      faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
      // Real, verified Amazon review quotes only — approved before merge.
      review_excerpts: z
        .array(z.object({ name: z.string(), rating: z.number().min(1).max(5), text: z.string() }))
        .default([]),
      images: z
        .object({
          hero_lifestyle: image().optional(),
          gallery: z.array(image()).default([]), // lifestyle-first; mirrored pack shots append after
        })
        .default({}),
    }),
});

const needs = defineCollection({
  loader: glob({ pattern: '*/needs.yaml', base: './src/content/brands' }),
  schema: z.object({
    needs: z.array(
      z.object({
        slug: z.string(),
        display: z.string(),
        short: z.string(), // card copy on the homepage "Shop by need" grid
        intro: z.string(), // collection-page editorial intro (2–3 sentences)
      })
    ),
    // Category collection pages (scope §9.2: one route per category). Slugs
    // must match the products schema `category` enum values.
    categories: z
      .array(
        z.object({
          slug: z.enum(['pillows', 'wedge', 'seat-lumbar', 'filler']),
          display: z.string(),
          intro: z.string(),
        })
      )
      .default([]),
  }),
});

const site = defineCollection({
  loader: glob({ pattern: '*/site.yaml', base: './src/content/brands' }),
  schema: ({ image }) =>
    z.object({
      hero: z.object({
        headline: z.string(),
        subline: z.string(),
        cta_label: z.string(),
        cta_href: z.string(),
        image: image().optional(),
      }),
      trust: z.object({ claims: z.array(z.string()) }), // stars/count injected from live data
      flagship: z.string(), // family slug featured on the homepage
      why_us: z.array(z.object({ icon: z.string(), title: z.string(), body: z.string() })),
      founder_line: z.string().optional(),
      // Real, verified Amazon review quotes only; the wall renders nothing until populated.
      review_wall: z
        .array(
          z.object({ name: z.string(), rating: z.number().min(1).max(5), text: z.string(), product: z.string() })
        )
        .default([]),
      comparison_teaser: z.object({ headline: z.string(), body: z.string() }).optional(),
      nav: z.array(z.object({ label: z.string(), href: z.string() })),
      footer_disclosure: z.string(),
    }),
});

// Spec-forward line catalog (Tape King rebuild, TAPEKING_SITE_SCOPE.md §6):
// one file per brand describing product LINES (nav + homepage grid + future
// line PDPs) and every sellable SKU keyed by ASIN. Price and attribution_url
// are deliberately absent — they sync from bronze via brand_site_products at
// build; per-roll / per-yard math is derived in src/lib/tapeking.js, never
// stored. Amazon SEO titles never render; display copy lives here.
const catalog = defineCollection({
  loader: glob({ pattern: '*/catalog.yaml', base: './src/content/brands' }),
  schema: z.object({
    lines: z.array(
      z.object({
        slug: z.string(), // line-PDP route (/products/<slug>/) + anchor id
        name: z.string(), // display name, e.g. "Standard Clear"
        blurb: z.string(), // one-liner under the name (cards, compare table)
        // Parent ASIN(s) the line spans — informational, used for review
        // aggregation; grouping itself is by the per-SKU `line` field.
        family_keys: z.array(z.string().regex(/^B0[A-Z0-9]{8}$/)).default([]),
        representative_asin: z.string().regex(/^B0[A-Z0-9]{8}$/), // card image + gallery source
        // Mono spec chip on cards, e.g. `2.7 MIL · 2" × 60 YD`. Omit to derive
        // from the representative SKU's mil/width/yards; non-tape lines
        // (dispensers, knives) must set it explicitly.
        spec_override: z.string().optional(),
        film_label: z.string().optional(), // compare-table "Film" cell when mil alone is wrong (e.g. CLOTH)
        consumable: z.boolean().default(true), // false = no S&S callout (knives/dispensers)
        // ---- PDP fields (scope §3 PDP section order) ----
        // false = no line PDP yet; the line's ASINs keep their v1 pages
        // (dispensers until §5.2 widths are confirmed with Kennon).
        pdp: z.boolean().default(true),
        title: z.string().optional(), // PDP h1, defaults to `name`
        sub: z.string().optional(), // lede under the h1
        crumb: z.string().optional(), // breadcrumb group label, e.g. "Packing Tape"
        chips: z.array(z.string()).default([]), // mono spec chips; empty = derive from representative SKU
        // Format-tab order + per-format note; keys must match SKU format_key
        // values. A line with one format renders no tab row.
        formats: z
          .array(
            z.object({
              key: z.string(),
              note: z.string().optional(),
              default_asin: z.string().regex(/^B0[A-Z0-9]{8}$/).optional(), // pre-selected rung
            })
          )
          .default([]),
        specs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
        // Real, verified Amazon review quotes only (verbatim, Kennon-approved
        // — see REVIEW_EXCERPT_CANDIDATES.md). Renders nothing while empty.
        review_excerpts: z
          .array(z.object({ name: z.string(), rating: z.number().min(1).max(5), text: z.string() }))
          .default([]),
        cross_sell: z.array(z.string()).default([]), // line slugs, e.g. dispenser ↔ tape
      })
    ),
    // Affiliate-brand listings (e.g. Grizzly Power on tapeking.com): standalone
    // static listing pages, never linked from nav/homepage grids. Price and
    // attribution sync from bronze via public.brand_site_affiliate_products;
    // the bronze.brand_site_affiliates mapping row must exist for the ASIN.
    affiliates: z
      .array(
        z.object({
          asin: z.string().regex(/^B0[A-Z0-9]{8}$/),
          slug: z.string(), // page route: /products/<slug>/
          brand_name: z.string(), // e.g. "Grizzly Power" — breadcrumb + disclosure
          display_name: z.string(), // human name — Amazon SEO title never renders
          sub: z.string(),
          upc: z.string().regex(/^\d{12,14}$/).optional(), // rendered in specs + JSON-LD gtin
          pack_count: z.number().int().positive().nullable().default(null), // enables per-roll math
          roll_yards: z.number().positive().nullable().default(null), // enables per-yard math
          chips: z.array(z.string()).default([]),
          specs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
        })
      )
      .default([]),
    skus: z.array(
      z.object({
        asin: z.string().regex(/^B0[A-Z0-9]{8}$/),
        line: z.string(), // must match a lines[].slug — validated in tapeking.js
        format_key: z.string(), // PDP format-tab bucket, e.g. std | xl | wide | quiet
        format_label: z.string(), // human tab label, e.g. `2" × 60 YD`
        display_name: z.string(), // human name — Amazon SEO title never renders
        pack_count: z.number().int().positive(),
        roll_yards: z.number().positive().nullable(), // null = not a tape (dispenser/knife)
        mil: z.number().positive().nullable(),
        width_in: z.number().positive().nullable(), // null = unverified (dispensers, scope §5.2)
        hidden: z.boolean().default(false), // future use — all rungs display at launch
        rung_label: z.string().optional(), // overrides the derived pack-size label on the ladder
        notes: z.string().optional(), // internal only, never rendered
      })
    ),
  }),
});

export const collections = { products, needs, site, catalog };
