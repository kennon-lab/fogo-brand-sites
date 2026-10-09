-- Applied to the production project as migration `brand_sites_hide_deploy_hook`.
--
-- Vercel deploy hook URLs are unauthenticated build triggers, so they must not
-- be readable with the publishable (anon) key. Two read paths existed:
--   1. public.brand_sites exposed vercel_deploy_hook_url to anon/authenticated.
--   2. bronze is in pgrst.db_schemas and bronze.brand_sites has an anon SELECT
--      policy, so `Accept-Profile: bronze` returned the column too.
-- After this, only service_role (scripts/rebuild-all.ps1) can read the hook.

-- 1. Recreate the public view without the hook column (other columns keep
--    their order). Nothing depends on public.brand_sites.
DROP VIEW public.brand_sites;

CREATE VIEW public.brand_sites AS
SELECT brand,
    slug,
    domain,
    store,
    tagline,
    about_html,
    logo_path,
    primary_color,
    secondary_color,
    contact_email,
    google_analytics_id,
    is_live,
    updated_at,
    hero_image_path,
    about_banner_path,
    feature_tiles,
    font_heading,
    font_body,
    hero_style,
    favicon_path,
    google_ads_customer_id,
    email_enabled,
    email_from_name,
    email_from_address,
    legal_name,
    mailing_address
   FROM bronze.brand_sites;

-- Same lockdown as brand_sites_phase1_view_grants_lockdown: default privileges
-- grant ALL on new public views, and DML through the view runs as postgres
-- (bypassing RLS), so anon/authenticated get SELECT only.
REVOKE ALL ON public.brand_sites FROM anon, authenticated;
GRANT SELECT ON public.brand_sites TO anon, authenticated;
GRANT ALL ON public.brand_sites TO service_role;

-- 2. Base table: column-level SELECT for anon/authenticated, every column
--    except vercel_deploy_hook_url. The public views run as their owner, so
--    they are unaffected. NOTE: a column added to bronze.brand_sites later is
--    NOT readable by anon via the bronze schema until granted here as well.
--    Also drop the unused anon/authenticated INSERT/UPDATE grants (RLS has no
--    write policy for those roles, so nothing relied on them).
REVOKE SELECT, INSERT, UPDATE ON bronze.brand_sites FROM anon, authenticated;
GRANT SELECT (brand, slug, domain, store, tagline, about_html, logo_path,
    primary_color, secondary_color, contact_email, google_analytics_id, is_live,
    updated_at, hero_image_path, about_banner_path, feature_tiles, font_heading,
    font_body, hero_style, favicon_path, google_ads_customer_id, email_enabled,
    email_from_name, email_from_address, legal_name, mailing_address)
  ON bronze.brand_sites TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
