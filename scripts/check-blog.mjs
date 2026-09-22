// Blog content gate — runs first in `npm run build` and standalone via
// `npm run check:blog [-- --brand=<slug>]`. Every post in
// src/content/brands/*/blog/*.md is checked (all brands: one repo, one bar);
// any FAIL exits 1 so a weak post never ships from any brand's deploy hook.
//
// What it enforces (F = fail, W = warn):
//   search brief   F target_keyword set; in the title and in the body
//                  W not in the description / not in the first 200 words
//   answerability  F >= 2 FAQ items (question + answer)   W no `summary`
//                  W no question-style H2   W under 600 words
//   purchase paths F >= 3 routes to Amazon: early card + mid-post cards
//                  (cta_after_sections) + inline /products/ links + the
//                  bottom strip (related_asins). F primary_asin not listed
//                  in related_asins. F cta_after_sections heading missing.
//   hygiene        F ASIN in visible text, direct amazon.com link, remote
//                  image, H1 in body, < 2 H2s, broken /blog/<slug>/ link
//                  W description outside 70–200 chars, title > 70 chars
//   claims         F disease / FDA / "clinically proven" language
//                  W guarantee / #1 / best-selling superlatives
//   ads block      F headline/description/callout over Google's limits or
//                  tripping its editorial rules (scripts/lib/ads-copy.mjs)
// Pure Node — no Astro, no network — so it runs in a second anywhere.
import { listPosts, plainText, h2s as headingsOf } from './lib/posts.mjs';
import { CLAIM_FAIL, CLAIM_WARN } from './lib/claims.mjs';
import { validateAd, keywordIssues } from './lib/ads-copy.mjs';
import { policyRisk } from './lib/ads-spec.mjs';

const args = process.argv.slice(2);
const brandArg = args.find((a) => a.startsWith('--brand='))?.slice('--brand='.length) ?? null;

const ASIN_RE = /\bB0[A-Z0-9]{8}\b/g;
const MIN_PURCHASE_PATHS = 3;
const MIN_FAQ = 2;
const MIN_WORDS = 600;

const posts = listPosts({ brand: brandArg, includeDrafts: true });

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const words = (s) => s.split(/\s+/).filter(Boolean);

const slugsByBrand = new Map();
for (const p of posts) {
  if (!slugsByBrand.has(p.brand)) slugsByBrand.set(p.brand, new Set());
  slugsByBrand.get(p.brand).add(p.slug);
}

let failures = 0;
let warnings = 0;
let checked = 0;
let skipped = 0;

for (const post of posts) {
  const F = [];
  const W = [];
  if (!post.fm) {
    report(post, ['no YAML frontmatter block'], []);
    failures++;
    continue;
  }
  const { fm, body } = post;
  if (fm.draft === true) {
    skipped++;
    continue;
  }
  checked++;

  // ---- frontmatter basics ------------------------------------------------
  const title = String(fm.title ?? '');
  const description = String(fm.description ?? '');
  if (!title) F.push('missing title');
  else if (title.length > 70) W.push(`title is ${title.length} chars (>70 gets truncated in SERPs)`);
  if (!description) F.push('missing description');
  else if (description.length > 200) F.push(`description is ${description.length} chars (schema max 200)`);
  else if (description.length < 70) W.push(`description is ${description.length} chars (<70 wastes the snippet)`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fm.date ?? ''))) F.push('date must be a quoted YYYY-MM-DD string');
  if (fm.updated != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm.updated))) F.push('updated must be YYYY-MM-DD');

  // ---- search brief ------------------------------------------------------
  const kw = norm(fm.target_keyword);
  const text = plainText(body);
  const textN = norm(text);
  if (kw.length < 3) {
    F.push('target_keyword is required (>= 3 chars)');
  } else {
    if (!norm(title).includes(kw)) F.push(`target_keyword "${fm.target_keyword}" is not in the title`);
    if (!textN.includes(kw)) F.push(`target_keyword "${fm.target_keyword}" does not appear in the body`);
    else if (!norm(words(text).slice(0, 200).join(' ')).includes(kw)) W.push('target_keyword is not in the first 200 words');
    if (!norm(description).includes(kw)) W.push('target_keyword is not in the description');
  }
  if (fm.secondary_keywords != null && !Array.isArray(fm.secondary_keywords)) F.push('secondary_keywords must be a list');
  if (fm.search_intent != null && !['informational', 'commercial', 'transactional'].includes(fm.search_intent)) {
    F.push(`search_intent "${fm.search_intent}" is not informational | commercial | transactional`);
  }

  // ---- structure ---------------------------------------------------------
  const lines = body.split(/\r?\n/);
  const h1s = lines.filter((l) => /^#\s+/.test(l));
  const h2s = headingsOf(body);
  if (h1s.length > 0) F.push('body contains an H1 (# …) — the title is the H1');
  if (h2s.length < 2) F.push(`only ${h2s.length} H2 section(s); posts need at least 2`);
  if (h2s.length > 0 && !h2s.some((h) => h.includes('?'))) W.push('no question-style H2 (answer engines lift these as direct answers)');
  const wc = words(text).length;
  if (wc < MIN_WORDS) W.push(`${wc} words (<${MIN_WORDS})`);
  if (!fm.summary) W.push('no summary (the "Quick answer" box + schema abstract)');
  else if (String(fm.summary).length > 400) F.push('summary over 400 chars');

  // ---- answerability -----------------------------------------------------
  const faq = Array.isArray(fm.faq) ? fm.faq : [];
  if (fm.faq != null && !Array.isArray(fm.faq)) F.push('faq must be a list of { q, a }');
  if (faq.length < MIN_FAQ) F.push(`${faq.length} FAQ item(s); need at least ${MIN_FAQ}`);
  faq.forEach((f, i) => {
    if (!f || typeof f !== 'object' || !f.q || !f.a) F.push(`faq[${i}] needs both q and a`);
    else {
      if (!String(f.q).trim().endsWith('?')) W.push(`faq[${i}] question should end with "?"`);
      if (words(String(f.a)).length < 15) W.push(`faq[${i}] answer is very short (<15 words)`);
    }
  });

  // ---- hygiene -----------------------------------------------------------
  const asinHits = [...new Set(text.match(ASIN_RE) ?? [])];
  if (asinHits.length > 0) F.push(`ASIN in visible text: ${asinHits.join(' ')} (link to /products/<asin>/ instead)`);
  if (/\]\(https?:\/\/(www\.)?amazon\./i.test(body) || /https?:\/\/(www\.)?amazon\.[a-z.]+\/\S+/i.test(text)) {
    F.push('direct amazon.com link in the body — every purchase link must be a /products/ page or a CTA (attribution)');
  }
  if (/!\[[^\]]*\]\(\s*https?:\/\//i.test(body) || /<img\b/i.test(body)) F.push('inline image in the body (only hero_image_path is allowed)');
  const blogLinks = [...body.matchAll(/\]\(\/blog\/([^/)#?]+)\/?[^)]*\)/g)].map((m) => m[1]);
  const known = slugsByBrand.get(post.brand) ?? new Set();
  for (const s of blogLinks) if (!known.has(s)) F.push(`links to /blog/${s}/ which does not exist for ${post.brand}`);
  if (blogLinks.length === 0 && known.size > 1) W.push('no link to another post on this blog');

  // ---- purchase paths ----------------------------------------------------
  const related = Array.isArray(fm.related_asins) ? fm.related_asins : [];
  if (related.length === 0) F.push('related_asins is empty — a post must feature at least one product');
  for (const a of related) if (!/^B0[A-Z0-9]{8}$/.test(String(a))) F.push(`related_asins entry "${a}" is not an ASIN`);
  const primary = fm.primary_asin ?? related[0] ?? null;
  if (fm.primary_asin && !related.includes(fm.primary_asin)) F.push(`primary_asin ${fm.primary_asin} must also be listed in related_asins`);
  const ctaEarly = fm.cta_early !== false && primary ? 1 : 0;
  const ctaAfter = Array.isArray(fm.cta_after_sections) ? fm.cta_after_sections : [];
  if (fm.cta_after_sections != null && !Array.isArray(fm.cta_after_sections)) F.push('cta_after_sections must be a list of H2 texts');
  const h2Norm = h2s.map(norm);
  for (const h of ctaAfter) {
    if (!h2Norm.includes(norm(h))) F.push(`cta_after_sections heading "${h}" does not match any H2`);
  }
  const inlineProductLinks = (body.match(/\]\(\/products\/[^)]*\)/g) ?? []).length;
  const strip = related.length > 0 ? 1 : 0;
  const paths = ctaEarly + (primary ? ctaAfter.length : 0) + inlineProductLinks + strip;
  if (paths < MIN_PURCHASE_PATHS) {
    F.push(
      `${paths} purchase path(s) (early card ${ctaEarly} + mid cards ${primary ? ctaAfter.length : 0} + inline /products/ links ${inlineProductLinks} + bottom strip ${strip}); need ${MIN_PURCHASE_PATHS}`
    );
  }

  // ---- Google Ads brief (optional) ------------------------------------------
  if (fm.ads != null) {
    if (typeof fm.ads !== 'object' || Array.isArray(fm.ads)) F.push('ads must be a map');
    else {
      for (const r of validateAd({
        headlines: fm.ads.headlines ?? [],
        descriptions: fm.ads.descriptions ?? [],
        callouts: fm.ads.callouts ?? [],
        sitelinks: fm.ads.sitelink ? [{ text: fm.ads.sitelink }] : [],
        path1: fm.ads.path1,
        path2: fm.ads.path2,
      })) {
        if (/^need at least/.test(r.issues[0]) ) continue; // generator fills the rest
        F.push(`ads ${r.where} "${r.text}": ${r.issues.join(', ')}`);
      }
      for (const k of [...(fm.ads.seeds ?? []), ...(fm.ads.negatives ?? [])]) {
        const issues = keywordIssues(String(k));
        if (issues.length) F.push(`ads keyword "${k}": ${issues.join(', ')}`);
      }
    }
  }
  for (const k of [kw, ...(Array.isArray(fm.secondary_keywords) ? fm.secondary_keywords : [])]) {
    if (!k) continue;
    const issues = keywordIssues(String(k));
    if (issues.length) W.push(`keyword "${k}" is not usable as a Google keyword: ${issues.join(', ')}`);
    const risk = policyRisk(String(k));
    if (risk) W.push(`keyword "${k}" won't be bid on in Google Ads (policy-risk term "${risk}") — fine for SEO`);
  }

  // ---- claims ------------------------------------------------------------
  const claimText = `${title}\n${description}\n${fm.summary ?? ''}\n${text}\n${faq.map((f) => `${f?.q ?? ''} ${f?.a ?? ''}`).join('\n')}`;
  for (const [re, label] of CLAIM_FAIL) {
    const m = claimText.match(re);
    if (m) F.push(`${label}: "${m[0].trim()}"`);
  }
  for (const [re, label] of CLAIM_WARN) {
    const m = claimText.match(re);
    if (m) W.push(`${label}: "${m[0].trim()}"`);
  }

  failures += F.length;
  warnings += W.length;
  report(post, F, W);
}

function report(post, F, W) {
  if (F.length === 0 && W.length === 0) return;
  console.log(`\n${post.brand}/${post.slug}`);
  for (const f of F) console.log(`  FAIL  ${f}`);
  for (const w of W) console.log(`  warn  ${w}`);
}

const scope = brandArg ? ` for ${brandArg}` : '';
if (posts.length === 0) {
  console.log(`[check-blog] no posts found${scope}.`);
} else if (failures > 0) {
  console.error(`\n[check-blog] FAIL — ${failures} problem(s) across ${checked} post(s)${scope} (${warnings} warning(s), ${skipped} draft(s) skipped).`);
  process.exit(1);
} else {
  console.log(`\n[check-blog] OK — ${checked} post(s)${scope} pass (${warnings} warning(s), ${skipped} draft(s) skipped).`);
}
