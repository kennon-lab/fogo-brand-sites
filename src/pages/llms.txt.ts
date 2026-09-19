import type { APIRoute } from 'astro';
import { getBrand } from '../lib/supabase.js';
import { getBlogPosts, getMergedCatalog, getSiteContent } from '../lib/content.js';
import { getTapeCatalogIfAny } from '../lib/tapeking.js';

// /llms.txt — the llmstxt.org convention: a short markdown summary of the site
// with links to the pages worth reading, so LLM agents and answer engines can
// find the guides and product pages without crawling everything. Built from
// the same data as the pages (brand row, catalog, posts); nothing is
// hand-maintained.
export const GET: APIRoute = async ({ site }) => {
  const abs = (path: string) => new URL(path, site).href;
  const [brand, posts, merged, siteContent, tape] = await Promise.all([
    getBrand(),
    getBlogPosts(),
    getMergedCatalog(),
    getSiteContent(),
    getTapeCatalogIfAny(),
  ]);

  const out: string[] = [`# ${brand.brand}`, ''];
  if (brand.tagline) out.push(`> ${brand.tagline}`, '');
  out.push(
    `${brand.brand} is an Amazon-native brand. This is the official brand site: product guides, ` +
      `how-tos and the full catalog. Every product is sold and shipped by Amazon.com — product pages ` +
      `link straight to the Amazon listing.`,
    ''
  );

  // Product pages, mirroring the PDP routing in src/pages/products/[slug].astro.
  const products: string[] = [];
  if (tape) {
    for (const line of tape.lines) {
      if (line.pdp === false) continue;
      products.push(`- [${line.name}](${abs(`/products/${line.slug}/`)}): ${line.blurb}`);
    }
  } else {
    const authoredBrand = merged.some((g) => g.authored);
    for (const g of merged) {
      if (authoredBrand) {
        if (!g.authored) continue;
        products.push(`- [${g.authored.display_name}](${abs(`/products/${g.slug}/`)}): ${g.authored.tagline}`);
      } else {
        for (const c of g.children) {
          products.push(`- [${c.display_title}](${abs(`/products/${c.asin}/`)})`);
        }
      }
    }
  }
  if (products.length > 0) out.push('## Products', '', `- [All products](${abs('/products/')})`, ...products, '');

  if (posts.length > 0) {
    out.push('## Guides', '', `- [Blog index](${abs('/blog/')})`);
    for (const p of posts) {
      out.push(`- [${p.title}](${abs(`/blog/${p.slug}/`)}): ${p.description}`);
    }
    out.push('');
  }

  out.push('## About', '', `- [About ${brand.brand}](${abs('/about/')})`, `- [Contact](${abs('/contact/')})`);
  if (siteContent?.warranty) out.push(`- [Warranty](${abs('/warranty/')})`);
  out.push('');

  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
