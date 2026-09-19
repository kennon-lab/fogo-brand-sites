import type { APIRoute } from 'astro';

// Everything is crawlable. AI / answer-engine crawlers are listed explicitly
// so the intent is unambiguous (some hosts and CDNs ship deny-by-default
// rules for these agents): the guides exist to be cited.
const AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'Bingbot',
  'CCBot',
];

export const GET: APIRoute = ({ site }) => {
  const sitemapUrl = new URL('sitemap-index.xml', site).href;
  const llmsUrl = new URL('llms.txt', site).href;
  const lines = ['User-agent: *', 'Allow: /', ''];
  for (const agent of AI_AGENTS) lines.push(`User-agent: ${agent}`, 'Allow: /', '');
  lines.push(`Sitemap: ${sitemapUrl}`, `# Site summary for LLM agents: ${llmsUrl}`, '');
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
