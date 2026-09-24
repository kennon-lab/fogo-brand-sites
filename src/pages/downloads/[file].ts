// Lead-magnet PDFs (EMAIL_CAPTURE_SCOPE_v1.md §4.3). Each brand's committed
// PDFs in src/content/brands/<slug>/downloads/ are emitted as static files at
// the path named in its emails/sequences.yaml — per brand, so one brand's
// guides never ship on another brand's site (public/ is shared by every build).
import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getBrand } from '../../lib/supabase.js';
import { getEmailConfig } from '../../lib/email.js';

export async function getStaticPaths() {
  const config = await getEmailConfig();
  if (!config) return [];
  const brand = await getBrand();
  return Object.values(config.leadMagnets).map((lm: { path: string }) => {
    const file = basename(lm.path);
    return {
      params: { file },
      props: { source: join('src', 'content', 'brands', brand.slug, 'downloads', file) },
    };
  });
}

export const GET: APIRoute = ({ props }) =>
  new Response(readFileSync(props.source as string), { headers: { 'Content-Type': 'application/pdf' } });
