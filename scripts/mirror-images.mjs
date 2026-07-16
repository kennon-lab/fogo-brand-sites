// Mirrors Amazon-hosted listing images into the brand-site-images Supabase
// Storage bucket and records public URLs in bronze.brand_site_images (via the
// writable public.brand_site_images view). Sites NEVER hotlink Amazon CDN —
// this script is the only source of image URLs the build will use.
//
// Usage:  node scripts/mirror-images.mjs --brand=bean-envy
// Env:    SUPABASE_URL, SUPABASE_ANON_KEY (reads), SUPABASE_SERVICE_ROLE_KEY
//         (storage upload + table writes). Loaded from .env automatically.
//
// Re-run whenever a brand's catalog or listing images change.

import process from 'node:process';

try {
  process.loadEnvFile('.env');
} catch {
  // .env optional if vars are already exported
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'brand-site-images';

const brandArg = process.argv.find((a) => a.startsWith('--brand='));
const slug = brandArg ? brandArg.split('=')[1] : process.env.BRAND_SLUG;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required.');
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required (storage uploads + bronze.brand_site_images writes).');
  process.exit(1);
}
if (!slug) {
  console.error('Pass --brand=<slug> (or set BRAND_SLUG).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(pathAndQuery, init = {}) {
  const key = init.write ? SERVICE_KEY : ANON_KEY;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}${init.method ? '' : `${sep}limit=10000`}`;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${pathAndQuery} → ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function extFromContentType(ct) {
  if (!ct) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

const products = await rest(`brand_site_products?brand_slug=eq.${encodeURIComponent(slug)}`);
if (products.length === 0) {
  console.error(`No products found for brand_slug=${slug}. Is the brand_sites row inserted?`);
  process.exit(1);
}
console.log(`Mirroring images for ${products.length} ASINs (brand: ${slug})`);

let totalUploaded = 0;
let totalSkipped = 0;
const dbFailedRows = []; // rows we couldn't write via PostgREST (e.g. key lacks REST access)

for (const p of products) {
  const sources = [p.main_image_url, ...(Array.isArray(p.alt_image_urls) ? p.alt_image_urls : [])]
    .filter(Boolean)
    .filter((url, i, arr) => arr.indexOf(url) === i);

  if (sources.length === 0) {
    console.log(`  ${p.asin}: no source images — will render text-only`);
    continue;
  }

  const rows = [];
  for (let position = 0; position < sources.length; position++) {
    const sourceUrl = sources[position];
    try {
      const imgRes = await fetch(sourceUrl);
      if (!imgRes.ok) {
        console.warn(`  ${p.asin}[${position}]: download failed (${imgRes.status}) ${sourceUrl}`);
        totalSkipped++;
        continue;
      }
      const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
      const ext = extFromContentType(contentType);
      const bytes = Buffer.from(await imgRes.arrayBuffer());

      const objectPath = `${slug}/${p.asin}/${position}.${ext}`;
      const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!upRes.ok) {
        console.warn(`  ${p.asin}[${position}]: upload failed (${upRes.status}) ${await upRes.text()}`);
        totalSkipped++;
        continue;
      }

      rows.push({
        asin: p.asin,
        position,
        storage_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`,
        source_url: sourceUrl,
      });
      totalUploaded++;
      await sleep(150);
    } catch (err) {
      console.warn(`  ${p.asin}[${position}]: ${err.message}`);
      totalSkipped++;
    }
  }

  if (rows.length > 0) {
    try {
      // Replace this ASIN's rows wholesale so positions never go stale.
      await rest(`brand_site_images?asin=eq.${encodeURIComponent(p.asin)}`, { method: 'DELETE', write: true });
      await rest('brand_site_images', {
        method: 'POST',
        write: true,
        headers: { Prefer: 'return=minimal' },
        body: rows,
      });
      console.log(`  ${p.asin}: ${rows.length} images mirrored`);
    } catch (err) {
      console.warn(`  ${p.asin}: uploaded ${rows.length} images but DB write failed — ${err.message}`);
      dbFailedRows.push(...rows);
    }
  }
}

if (dbFailedRows.length > 0) {
  const { writeFileSync } = await import('node:fs');
  const manifestPath = new URL('./mirror-manifest.json', import.meta.url);
  writeFileSync(manifestPath, JSON.stringify(dbFailedRows, null, 2));
  console.warn(
    `\n${dbFailedRows.length} rows could not be written to bronze.brand_site_images (key lacks PostgREST access).` +
      `\nSaved to scripts/mirror-manifest.json — insert them manually, then delete the manifest.`
  );
  process.exitCode = 2;
}

console.log(`Done. ${totalUploaded} uploaded, ${totalSkipped} skipped.`);
