// Brand-site email renderer (EMAIL_CAPTURE_SCOPE_v1.md §6.5, §7.3).
// Shared by the Vercel functions (api/*), the content gate (check-emails) and
// preview tooling, so the gate checks exactly what gets sent.
//
// Content lives in src/content/brands/<slug>/emails/: sequences.yaml plus one
// markdown file per step (frontmatter: subject, preheader, stream, cta, optional
// primary_asin). Link conventions are documented at the top of sequences.yaml.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { micromark } from 'micromark';

export const CONTENT_ROOT = join('src', 'content');

const emailsDir = (root, slug) => join(root, CONTENT_ROOT, 'brands', slug, 'emails');

export function hasEmails(slug, root = process.cwd()) {
  return existsSync(join(emailsDir(root, slug), 'sequences.yaml'));
}

export function loadSequences(slug, root = process.cwd()) {
  return YAML.parse(readFileSync(join(emailsDir(root, slug), 'sequences.yaml'), 'utf8'));
}

export function loadStep(slug, file, root = process.cwd()) {
  const raw = readFileSync(join(emailsDir(root, slug), file), 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`[email-render] ${slug}/${file}: missing frontmatter`);
  return { ...YAML.parse(m[1]), body: m[2].trim(), file };
}

export function loadDefaults(root = process.cwd()) {
  return YAML.parse(readFileSync(join(root, CONTENT_ROOT, 'email-defaults.yaml'), 'utf8')) ?? {};
}

/** Sender line parts; a brand-row override wins over the portfolio default. */
export function senderIdentity(brand, defaults) {
  return {
    legal_name: brand.legal_name || defaults.legal_name || '',
    mailing_address: brand.mailing_address || defaults.mailing_address || '',
  };
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PLACEHOLDER = /\{\{\s*([a-z_]+(?::[a-z_]+)?)\s*\}\}/g;

/** Replaces {{name}} / {{name:key}} from vars; throws on any unknown placeholder. */
export function fillPlaceholders(text, vars, where) {
  return String(text).replace(PLACEHOLDER, (all, key) => {
    if (!(key in vars)) throw new Error(`[email-render] ${where}: no value for ${all}`);
    return vars[key];
  });
}

/** Final URL for a link written in step content. */
export function resolveHref(href, { origin, utm, resolveAmazon }) {
  const amazon = href.match(/^amazon:(B0[A-Z0-9]{8})$/);
  if (amazon) return resolveAmazon?.(amazon[1]) || `https://www.amazon.com/dp/${amazon[1]}`;
  if (href.startsWith('/')) {
    const u = new URL(href, origin);
    for (const [k, v] of Object.entries(utm ?? {})) u.searchParams.set(k, v);
    return u.href;
  }
  return href;
}

// Inline styles for the few tags markdown produces (email clients ignore <style>).
const TAG_STYLES = {
  p: 'margin:0 0 16px;',
  h3: 'margin:24px 0 8px;font-size:18px;line-height:1.3;font-weight:700;',
  ul: 'margin:0 0 16px;padding-left:22px;',
  ol: 'margin:0 0 16px;padding-left:22px;',
  li: 'margin:0 0 8px;',
  strong: 'font-weight:700;',
};

function styleHtml(html, linkColor) {
  let out = html;
  for (const [tag, style] of Object.entries(TAG_STYLES)) {
    out = out.replace(new RegExp(`<${tag}>`, 'g'), `<${tag} style="${style}">`);
  }
  return out.replace(/<a href=/g, `<a style="color:${linkColor};text-decoration:underline;" href=`);
}

function markdownToText(md, resolve) {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `${label} (${resolve(href)})`)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^###\s+/gm, '')
    .replace(/\\\n/g, '\n');
}

/**
 * Renders one step to { subject, preheader, stream, html, text, template_hash }.
 *   brand     brand_sites row (brand, domain, primary_color, secondary_color, overrides)
 *   defaults  email-defaults.yaml
 *   vars      placeholder values (confirm_url, lead_magnet_url, lead_magnet_url:<k>, …)
 *   track, stepKey   feed the UTM tags on broadcast site links
 *   logoUrl   absolute URL of the header logo; text wordmark when absent
 */
export function renderEmail({ step, brand, defaults, vars = {}, track = 'general', stepKey = 'x', resolveAmazon, logoUrl }) {
  const where = `${brand.slug}/${step.file}`;
  const origin = `https://www.${brand.domain.replace(/^www\./, '')}`;
  const marketing = step.stream !== 'outbound';
  const utm = marketing
    ? { utm_source: 'email', utm_medium: 'drip', utm_campaign: `fbs-${brand.slug}-${track}`, utm_content: stepKey }
    : null;
  const resolve = (href) => resolveHref(fillPlaceholders(href, vars, where), { origin, utm, resolveAmazon });

  const subject = fillPlaceholders(step.subject, vars, where);
  const preheader = fillPlaceholders(step.preheader ?? '', vars, where);
  const body = fillPlaceholders(step.body, vars, where);
  const { legal_name, mailing_address } = senderIdentity(brand, defaults);
  if (!legal_name || !mailing_address) {
    throw new Error(`[email-render] ${where}: sender identity incomplete (legal_name / mailing_address)`);
  }

  const ink = '#373131';
  const accent = brand.primary_color || '#86BDC2';
  const band = brand.secondary_color || ink;
  const linkColor = '#2F6E75';

  const bodyHtml = styleHtml(
    micromark(body, { allowDangerousProtocol: true }).replace(/href="([^"]*)"/g, (_, h) => `href="${esc(resolve(h.replace(/&amp;/g, '&')))}"`),
    linkColor
  );
  const cta = step.cta
    ? { label: fillPlaceholders(step.cta.label, vars, where), url: resolve(step.cta.href) }
    : null;

  const whyLine = marketing
    ? `You're receiving this because you signed up at ${brand.domain}.`
    : `You're getting this because this address was entered at ${brand.domain}. If that wasn't you, you can ignore this email.`;
  const senderLine = `${brand.brand} is a brand of ${legal_name}, ${mailing_address}.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F4F2F1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F2F1;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;">
<tr><td style="background:${band};padding:18px 28px;">${
    logoUrl
      ? `<img src="${esc(logoUrl)}" alt="${esc(brand.brand)}" height="36" style="display:block;height:36px;width:auto;border:0;">`
      : `<span style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:800;letter-spacing:3px;color:${accent};text-transform:uppercase;">${esc(brand.brand)}</span>`
  }</td></tr>
<tr><td style="padding:28px 28px 8px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${ink};">
${bodyHtml}
${
    cta
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="background:${accent};border-radius:6px;"><a href="${esc(cta.url)}" style="display:inline-block;padding:13px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${ink};text-decoration:none;">${esc(cta.label)}</a></td></tr></table>`
      : ''
  }
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #E3DEDC;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6B6464;">
${esc(whyLine)} ${esc(senderLine)}${marketing ? `<br><a href="{{{ pm:unsubscribe }}}" style="color:#6B6464;text-decoration:underline;">Unsubscribe</a>` : ''}
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    markdownToText(body, resolve),
    cta ? `${cta.label}: ${cta.url}` : '',
    '--',
    `${whyLine} ${senderLine}`,
    marketing ? 'Unsubscribe: {{{ pm:unsubscribe }}}' : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const template_hash = createHash('sha256').update(`${subject}\n${preheader}\n${step.body}`).digest('hex').slice(0, 16);
  return { subject, preheader, stream: marketing ? 'broadcast' : 'outbound', html, text, template_hash };
}
