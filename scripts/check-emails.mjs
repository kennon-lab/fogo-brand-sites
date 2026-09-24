// Email content gate (EMAIL_CAPTURE_SCOPE_v1.md §7.4). Runs in `npm run build`
// after check-blog, for EVERY brand that has src/content/brands/<slug>/emails/
// (one repo, one bar), and standalone via `npm run check:emails`.
// Any FAIL stops the build. Each step is rendered through the same renderer the
// Vercel functions use, so an unfillable placeholder or a missing sender line
// is caught here, not in someone's inbox.
import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CLAIM_FAIL } from './lib/claims.mjs';
import { policyRisk } from './lib/ads-spec.mjs';
import { hasEmails, loadSequences, loadStep, loadDefaults, renderEmail } from './lib/email-render.mjs';

const BRANDS_DIR = join('src', 'content', 'brands');
const ASIN_RE = /\bB0[A-Z0-9]{8}\b/;
const EXTRA_CLAIMS = [[/\b(probiotic|gut[- ]health|detox|immunity|immune)\b/i, 'health claim']];
const REVIEW_ASK = /\b(leave|write|post|share)\b[^.!?\n]{0,40}\breview/i;
const PRICE = /\$\s?\d/;

let failures = 0;
const report = (where, F) => {
  if (F.length === 0) return;
  failures += F.length;
  for (const f of F) console.error(`  FAIL ${where}: ${f}`);
};

const brands = readdirSync(BRANDS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && hasEmails(d.name))
  .map((d) => d.name);

for (const slug of brands) {
  const seq = loadSequences(slug);
  const defaults = loadDefaults();
  const blogSlugs = new Set(
    existsSync(join(BRANDS_DIR, slug, 'blog'))
      ? readdirSync(join(BRANDS_DIR, slug, 'blog')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : []
  );
  const F0 = [];
  if (!seq.consent?.text || !seq.consent?.version) F0.push('sequences.yaml: consent.text and consent.version are required');
  if (!defaults.legal_name || !defaults.mailing_address) F0.push('email-defaults.yaml: legal_name and mailing_address are required');
  for (const [key, lm] of Object.entries(seq.lead_magnets ?? {})) {
    if (!existsSync(join(BRANDS_DIR, slug, 'downloads', basename(lm.path ?? '')))) {
      F0.push(`lead magnet "${key}": ${lm.path} has no file in downloads/`);
    }
  }
  report(`${slug}/sequences.yaml`, F0);

  const steps = [{ file: seq.confirm, track: 'general', confirm: true }];
  for (const [track, def] of Object.entries(seq.tracks ?? {})) {
    for (const s of [...(def.steps ?? []), ...(def.fallback ?? [])]) steps.push({ file: s.file, track });
  }

  const origin = 'https://www.example.com';
  const vars = {
    confirm_url: `${origin}/subscribe/confirm/?t=x`,
    lead_magnet_url: `${origin}/downloads/x.pdf`,
    lead_magnet_title: 'Guide',
    ...Object.fromEntries(Object.keys(seq.lead_magnets ?? {}).map((k) => [`lead_magnet_url:${k}`, `${origin}/downloads/${k}.pdf`])),
    ...Object.fromEntries(Object.keys(seq.tracks ?? {}).map((t) => [`track_link:${t}`, `${origin}/api/track?t=${t}`])),
  };
  const brand = { slug, brand: slug, domain: 'example.com' };

  for (const { file, track, confirm } of steps) {
    const F = [];
    let step;
    try {
      step = loadStep(slug, file);
    } catch (e) {
      report(`${slug}/${file}`, [`cannot load: ${e.message}`]);
      continue;
    }
    if (!step.subject) F.push('subject is required');
    else if (step.subject.length > 60) F.push(`subject is ${step.subject.length} chars (max 60)`);
    if (!step.preheader) F.push('preheader is required');
    else if (step.preheader.length > 90) F.push(`preheader is ${step.preheader.length} chars (max 90)`);
    if (!['outbound', 'broadcast'].includes(step.stream)) F.push('stream must be outbound or broadcast');
    if (confirm && (step.stream !== 'outbound' || step.cta?.href !== '{{confirm_url}}')) {
      F.push('confirm email must be stream: outbound with cta.href "{{confirm_url}}" and nothing to sell');
    }
    if (!confirm && step.stream === 'outbound') F.push('only the confirm email may use the outbound (transactional) stream');
    const risk = step.subject && policyRisk(step.subject);
    if (risk) F.push(`subject contains policy-risk term "${risk}"`);

    const hrefs = [...step.body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).concat(step.cta?.href ? [step.cta.href] : []);
    const text = `${step.subject}\n${step.preheader}\n${step.body.replace(/\]\([^)]+\)/g, ']')}`;
    for (const [re, label] of [...CLAIM_FAIL, ...EXTRA_CLAIMS]) {
      const m = text.match(re);
      if (m) F.push(`${label}: "${m[0].trim()}"`);
    }
    if (ASIN_RE.test(text)) F.push('ASIN printed in text (link to amazon:<ASIN> or /products/<ASIN>/ instead)');
    if (REVIEW_ASK.test(text)) F.push('review request (never ask for Amazon reviews in email)');
    if (PRICE.test(text)) F.push('price in email (prices change after send)');
    if (confirm && hrefs.some((h) => h.startsWith('amazon:'))) F.push('confirm email must not link to Amazon');
    for (const h of hrefs) {
      if (/amazon\.com/i.test(h)) F.push(`raw Amazon link ${h} (use amazon:<ASIN>)`);
      const blog = h.match(/^\/blog\/([^/?#]+)\/?/);
      if (blog && !blogSlugs.has(blog[1])) F.push(`link to unknown post ${h}`);
      if (/^\/products\//.test(h) && !/^\/products\/B0[A-Z0-9]{8}\/$/.test(h)) F.push(`product link ${h} must be /products/<ASIN>/`);
    }
    try {
      renderEmail({ step, brand, defaults, vars, track, stepKey: 'check' });
    } catch (e) {
      F.push(e.message.replace(/^\[email-render\]\s*/, ''));
    }
    report(`${slug}/${file}`, F);
  }
  console.log(`[check-emails] ${slug}: ${steps.length} email(s) checked`);
}

if (failures > 0) {
  console.error(`[check-emails] ${failures} failure(s). Fix before building.`);
  process.exit(1);
}
console.log(`[check-emails] OK (${brands.length} brand(s) with email content).`);
