-- Email capture (EMAIL_CAPTURE_SCOPE_v1.md §7.2). Additive only.
--
-- PII lives in bronze.email_* and is deliberately NOT readable by anon or
-- authenticated (a documented exception to the usual bronze RLS pattern).
-- The Vercel functions reach it only through the SECURITY DEFINER RPCs below,
-- which are executable by service_role alone.

-- 1. Brand config -------------------------------------------------------------
alter table bronze.brand_sites
  add column if not exists email_enabled boolean not null default false,
  add column if not exists email_from_name text,
  add column if not exists email_from_address text,
  add column if not exists legal_name text,        -- override of src/content/email-defaults.yaml
  add column if not exists mailing_address text;   -- override of src/content/email-defaults.yaml

-- Appends the new columns; existing column order is unchanged, so this is a
-- valid CREATE OR REPLACE and the existing SELECT-only grants carry over.
create or replace view public.brand_sites as
select brand, slug, domain, store, tagline, about_html, logo_path, primary_color, secondary_color,
       contact_email, google_analytics_id, is_live, vercel_deploy_hook_url, updated_at,
       hero_image_path, about_banner_path, feature_tiles, font_heading, font_body, hero_style,
       favicon_path, google_ads_customer_id,
       email_enabled, email_from_name, email_from_address, legal_name, mailing_address
from bronze.brand_sites;

-- 2. Tables -------------------------------------------------------------------
create table if not exists bronze.email_subscribers (
  id uuid primary key default gen_random_uuid(),
  brand_slug text not null references bronze.brand_sites(slug),
  email text not null,
  status text not null default 'pending'
    check (status in ('pending','active','unsubscribed','bounced','complained')),
  track text not null default 'general',
  track_changed_at timestamptz,
  source_type text,
  source_path text,
  paid_snapshot jsonb,
  consent_text text not null,
  consent_version text not null,
  consent_at timestamptz not null default now(),
  ip_hash text,
  user_agent text,
  token_hash text not null,
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists email_subscribers_brand_email_uq
  on bronze.email_subscribers (brand_slug, lower(email));
create index if not exists email_subscribers_token_idx on bronze.email_subscribers (token_hash);
create index if not exists email_subscribers_ip_recent_idx on bronze.email_subscribers (ip_hash, created_at);

create table if not exists bronze.email_suppressions (
  brand_slug text not null references bronze.brand_sites(slug),
  email_hash text not null,               -- sha256(lower(email)); set on deletion requests
  reason text not null default 'deletion_request',
  created_at timestamptz not null default now(),
  primary key (brand_slug, email_hash)
);

create table if not exists bronze.email_sends (
  id bigserial primary key,
  subscriber_id uuid not null references bronze.email_subscribers(id) on delete cascade,
  sequence text not null,
  step int not null,
  template_hash text not null,
  provider_message_id text,
  sent_at timestamptz not null default now(),
  status text,
  unique (subscriber_id, sequence, step)
);

create table if not exists bronze.email_events (
  id bigserial primary key,
  provider_message_id text,
  subscriber_id uuid references bronze.email_subscribers(id) on delete set null,
  type text not null,
  url text,
  payload jsonb,
  occurred_at timestamptz not null default now()
);

-- 3. RLS: service_role only ----------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['email_subscribers','email_suppressions','email_sends','email_events'] loop
    execute format('alter table bronze.%I enable row level security', t);
    execute format('revoke all on bronze.%I from anon, authenticated', t);
    execute format('drop policy if exists service_role_all on bronze.%I', t);
    execute format('create policy service_role_all on bronze.%I for all to service_role using (true) with check (true)', t);
    execute format('grant all on bronze.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence bronze.email_sends_id_seq, bronze.email_events_id_seq to service_role;

-- 4. RPCs (called by api/subscribe.js and api/confirm.js) ----------------------

-- Returns the action the caller should take:
--   send_confirm  row created or refreshed; email the confirm link
--   throttled     pending and a confirm went out < 10 min ago
--   rate_limited  >= 5 signups from this ip_hash in the last hour
--   noop          already active, bounced/complained, or suppressed
-- The caller shows the same "check your inbox" page for every outcome so the
-- form can't be used to probe which addresses are subscribed.
create or replace function public.email_subscribe(
  p_brand_slug text, p_email text, p_email_hash text, p_track text,
  p_source_type text, p_source_path text, p_paid_snapshot jsonb,
  p_consent_text text, p_consent_version text,
  p_ip_hash text, p_user_agent text, p_token_hash text
) returns table (action text, subscriber_id uuid)
language plpgsql security definer set search_path = '' as $$
declare r bronze.email_subscribers%rowtype;
begin
  if exists (select 1 from bronze.email_suppressions s
             where s.brand_slug = p_brand_slug and s.email_hash = p_email_hash) then
    return query select 'noop'::text, null::uuid; return;
  end if;

  if p_ip_hash is not null and (select count(*) from bronze.email_subscribers s
      where s.ip_hash = p_ip_hash and s.created_at > now() - interval '1 hour') >= 5 then
    return query select 'rate_limited'::text, null::uuid; return;
  end if;

  select * into r from bronze.email_subscribers s
   where s.brand_slug = p_brand_slug and lower(s.email) = lower(p_email) for update;

  if not found then
    insert into bronze.email_subscribers
      (brand_slug, email, track, source_type, source_path, paid_snapshot, consent_text,
       consent_version, ip_hash, user_agent, token_hash, confirm_sent_at)
    values (p_brand_slug, p_email, coalesce(p_track, 'general'), p_source_type, p_source_path,
            p_paid_snapshot, p_consent_text, p_consent_version, p_ip_hash, p_user_agent,
            p_token_hash, now())
    returning * into r;
    return query select 'send_confirm'::text, r.id; return;
  end if;

  if r.status in ('active', 'bounced', 'complained') then
    return query select 'noop'::text, r.id; return;
  end if;

  if r.status = 'pending' and r.confirm_sent_at > now() - interval '10 minutes' then
    return query select 'throttled'::text, r.id; return;
  end if;

  -- pending (resend) or unsubscribed (explicit re-opt-in via the form)
  update bronze.email_subscribers s set
    status = 'pending', track = coalesce(p_track, s.track), source_type = p_source_type,
    source_path = p_source_path, paid_snapshot = p_paid_snapshot, consent_text = p_consent_text,
    consent_version = p_consent_version, consent_at = now(), ip_hash = p_ip_hash,
    user_agent = p_user_agent, token_hash = p_token_hash, confirm_sent_at = now(),
    updated_at = now()
  where s.id = r.id;
  return query select 'send_confirm'::text, r.id;
end $$;

-- Result: confirmed | already | expired | invalid. Links expire 7 days after
-- the confirm email was sent.
create or replace function public.email_confirm(p_token_hash text)
returns table (result text, subscriber_id uuid, brand_slug text, email text, track text,
               was_unsubscribed boolean)
language plpgsql security definer set search_path = '' as $$
declare r bronze.email_subscribers%rowtype;
begin
  select * into r from bronze.email_subscribers s where s.token_hash = p_token_hash for update;
  if not found then
    return query select 'invalid'::text, null::uuid, null::text, null::text, null::text, false; return;
  end if;
  if r.status = 'active' then
    return query select 'already'::text, r.id, r.brand_slug, r.email, r.track, false; return;
  end if;
  if r.status <> 'pending' then
    return query select 'invalid'::text, null::uuid, null::text, null::text, null::text, false; return;
  end if;
  if r.confirm_sent_at < now() - interval '7 days' then
    return query select 'expired'::text, r.id, r.brand_slug, null::text, r.track, false; return;
  end if;
  update bronze.email_subscribers s set status = 'active', confirmed_at = now(),
         unsubscribed_at = null, updated_at = now()
   where s.id = r.id;
  return query select 'confirmed'::text, r.id, r.brand_slug, r.email, r.track,
                      (r.unsubscribed_at is not null);
end $$;

revoke all on function public.email_subscribe(text,text,text,text,text,text,jsonb,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.email_confirm(text) from public, anon, authenticated;
grant execute on function public.email_subscribe(text,text,text,text,text,text,jsonb,text,text,text,text,text) to service_role;
grant execute on function public.email_confirm(text) to service_role;

notify pgrst, 'reload schema';
