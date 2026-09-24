// Postbuild guard: no ASIN may appear in rendered text anywhere on the site.
// An ASIN in visible UI is the loudest "reseller catalog" tell (v2 scope §5.2).
//
// Strict (build fails) only for brands with authored presentation content
// (src/content/brands/<slug>/products/*.yaml); unauthored v1 brands can
// legitimately show ASIN variant chips via the variantLabel() fallback, so
// they get a warning instead.
//
// We scan text nodes only: <script>/<style> bodies are stripped first (JSON-LD
// legitimately carries sku=asin), then all tags (attributes like data-asin and
// hrefs vanish with them). This catches ASINs embedded mid-text, which the
// scope's `>B0…<` grep would miss.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Local convenience; on Vercel there is no .env (env comes from the project).
// Note process.loadEnvFile never overrides inherited env vars, so a shell
// BRAND_SLUG wins — same precedence the build itself uses.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — fine */
}

const BRAND_SLUG = process.env.BRAND_SLUG ?? '';
const DIST = 'dist';

const contentDir = join('src', 'content', 'brands', BRAND_SLUG, 'products');
const strict =
  BRAND_SLUG !== '' && existsSync(contentDir) && readdirSync(contentDir).some((f) => /\.ya?ml$/.test(f));

if (!existsSync(DIST)) {
  console.error('[check-dist] dist/ not found — run astro build first.');
  process.exit(1);
}

const htmlFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.html')) htmlFiles.push(p);
  }
})(DIST);

// Secrets guard (EMAIL_CAPTURE_SCOPE_v1.md §7.6): the Supabase secret key and
// the Postmark token live only in Vercel Function env and must never reach
// the static output. Scans every text file, not just HTML.
const secretValues = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.POSTMARK_SERVER_TOKEN, process.env.EMAIL_TOKEN_PEPPER]
  .filter((v) => v && v.length >= 12);
const leaks = [];
(function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) scan(p);
    else if (/\.(html|js|mjs|css|json|txt|xml)$/.test(entry.name)) {
      const text = readFileSync(p, 'utf8');
      if (/sb_secret_[A-Za-z0-9]/.test(text) || secretValues.some((v) => text.includes(v))) leaks.push(p);
    }
  }
})(DIST);
if (leaks.length > 0) {
  console.error(`[check-dist] FAIL — secret key material in built output:\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}

const offenders = [];
for (const file of htmlFiles) {
  const text = readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const hits = text.match(/B0[A-Z0-9]{8}/g);
  if (hits) offenders.push(`  ${file}: ${[...new Set(hits)].join(' ')}`);
}

if (offenders.length > 0) {
  if (strict) {
    console.error(`[check-dist] FAIL — ASINs in rendered text (authored brand "${BRAND_SLUG}"):\n${offenders.join('\n')}`);
    process.exit(1);
  }
  console.warn(`[check-dist] ASINs in rendered text (allowed for unauthored brand "${BRAND_SLUG}"):\n${offenders.join('\n')}`);
} else {
  console.log(`[check-dist] OK — no ASINs in rendered text across ${htmlFiles.length} pages.`);
}
