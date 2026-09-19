-- Applied to the production project as migration `brand_sites_paid_links_view`
-- (2026-09-19). Kept here for reference / re-creation.
--
-- Paid-channel Amazon Attribution tags per brand site: every active
-- bronze.attribution_links row whose channel is NOT 'brand_site' (the organic
-- channel brand_site_products already exposes as attribution_url).
--
-- Consumed at build time by getPaidLinks() in src/lib/supabase.js. The site
-- embeds the {asin -> {channel -> url}} map and a small inline script in
-- src/layouts/Base.astro swaps Amazon CTA hrefs when the visitor arrived from a
-- paid click (gclid / gbraid / wbraid, or utm_source=google&utm_medium=cpc), so
-- Amazon Attribution reports paid and organic separately. URLs may contain
-- Google ValueTrack placeholders such as {campaignid}, {adgroupid}, {creative},
-- {keyword} — the client fills them from the landing URL's query string.
--
-- Channel naming: 'google_ads' is the one the site recognizes today.
create or replace view public.brand_site_paid_links as
select
  bs.slug as brand_slug,
  al.asin,
  al.channel,
  al.attribution_url,
  al.campaign_name
from bronze.attribution_links al
join bronze.brand_sites bs on bs.brand = al.brand
where al.is_active
  and al.channel <> 'brand_site';

-- Same lockdown as the other brand-site views (see CLAUDE.md): Supabase default
-- privileges grant WRITE on new public views to anon/authenticated, and views
-- execute DML as owner (bypassing RLS) — revoke down to SELECT.
revoke all on public.brand_site_paid_links from anon, authenticated;
grant select on public.brand_site_paid_links to anon, authenticated;

notify pgrst, 'reload schema';
