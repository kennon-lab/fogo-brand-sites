// Blog post loader shared by the content gate and the Google Ads generator:
// reads src/content/brands/<slug>/blog/*.md, parses the YAML frontmatter with
// the same library Astro uses, and exposes a plain-text view of the body.
// Pure Node — no Astro runtime, so scripts stay fast and offline-capable.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

export const CONTENT_ROOT = join('src', 'content', 'brands');

/** { fm, body } from a markdown file's text, or null when there's no frontmatter block. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { fm: YAML.parse(m[1]) ?? {}, body: m[2] };
}

/**
 * Every post as { brand, slug, path, fm, body }. `brand` filters to one slug;
 * drafts are skipped unless includeDrafts. Files without frontmatter come back
 * with fm = null so callers can report them.
 */
export function listPosts({ brand = null, includeDrafts = false } = {}) {
  const posts = [];
  if (!existsSync(CONTENT_ROOT)) return posts;
  for (const dir of readdirSync(CONTENT_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (brand && dir.name !== brand) continue;
    const blogDir = join(CONTENT_ROOT, dir.name, 'blog');
    if (!existsSync(blogDir)) continue;
    for (const f of readdirSync(blogDir)) {
      if (!f.endsWith('.md')) continue;
      const path = join(blogDir, f);
      const parsed = parseFrontmatter(readFileSync(path, 'utf8'));
      const post = { brand: dir.name, slug: f.replace(/\.md$/, ''), path, fm: parsed?.fm ?? null, body: parsed?.body ?? '' };
      if (!includeDrafts && post.fm?.draft === true) continue;
      posts.push(post);
    }
  }
  return posts.sort((a, b) => a.brand.localeCompare(b.brand) || a.slug.localeCompare(b.slug));
}

/** Markdown body → plain-ish text (code, link targets, images, emphasis, heading hashes removed). */
export function plainText(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>]/g, '');
}

/** H2 texts in order. */
export function h2s(body) {
  return body
    .split(/\r?\n/)
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, '').trim());
}
