-- Tape King QR free-dispenser funnel, Phase 1 (TAPEKING_DISPENSER_FUNNEL_SCOPE.md,
-- "Data model"). Applied to the production project as migration
-- `tk_dispenser_funnel_phase1` (2026-10-23). Kept here for reference / re-creation.
--
-- Verified against live Supabase before writing (2026-10-23): no `marketing`
-- schema existed; pgrst.db_schemas = public,bronze,cashflow,silver (marketing stays
-- OUT of it, so no table here is reachable through PostgREST); citext is not
-- installed; pg_cron + pg_net are. The unused generic email-capture tables
-- (bronze.email_*, migration email_capture_tables) are left alone — this funnel
-- keeps its own tables as the scope specifies.
--
-- Differences from the scope's draft SQL:
-- * email is lowercased text (check constraint) instead of citext: citext's `=`
--   lives in schema extensions, so functions pinned to search_path '' would
--   silently fall back to case-sensitive text comparison.
-- * tk_claims adds claim_token_hash (step 2 is authorized by a random token that
--   only a Turnstile-verified step 1 hands out), completed_at (step 2 saved — the
--   "claim date" for the drip and the monthly cap), street_hash (ZIP + street line
--   without the unit, for the 3+-claims-per-street review flag) and user_agent.
-- * tk_email_steps: offset_days → `delay interval` (Flow B fires 2 hours after
--   step 1), anchor 'start' | 'claim' | 'runout', repeat_min = Flow D's cycle floor.
-- * tk_email_sends adds occurrence, so Flow D's repeats are separate rows under the
--   idempotency key (claim_id, step_key, occurrence).
-- * tk_consent_versions stores the exact consent text per version (claims FK it).
-- * tk_submit_log backs the rate limits (rejected attempts count too).
-- * The RPCs the Edge Functions call are public.tk_* (PostgREST only serves
--   exposed schemas), SECURITY INVOKER and executable by service_role only.

create schema if not exists marketing;
revoke all on schema marketing from public, anon, authenticated;
grant usage on schema marketing to service_role;

create type marketing.claim_status as enum (
  'started',          -- step 1 done, no address yet
  'pending_review',   -- flagged by anti-abuse rules (or auto_approve off)
  'approved',         -- ready to ship
  'rejected',
  'fulfillment_submitted',
  'shipped',
  'delivered',
  'cancelled'
);

-- ---------------------------------------------------------------- tables

create table marketing.program_config (
  key text primary key,
  value jsonb not null,
  note text,
  updated_at timestamptz not null default now()
);

create table marketing.tk_consent_versions (
  version text primary key,
  consent_text text not null,
  created_at timestamptz not null default now()
);

create table marketing.tk_claims (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status marketing.claim_status not null default 'started',
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  first_name text not null,
  company text,
  use_case text not null
    check (use_case in ('shipping_ecommerce', 'warehouse_freight', 'moving', 'office', 'events_av', 'home')),
  monthly_rolls_band text not null check (monthly_rolls_band in ('le1', '2_5', '6_20', '21_50', '50_plus')),
  segment text not null check (segment in ('biz_high', 'biz_core', 'light')), -- set by marketing.tk_segment()
  runout_at date,               -- est. restock date from volume band (set when step 2 lands)
  purchase_channel text check (purchase_channel in ('amazon', 'amazon_business', 'office_store', 'other')),
  ship_name text,
  address1 text,
  address2 text,
  city text,
  state char(2) check (state ~ '^[A-Z]{2}$'),
  zip text check (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
  address_hash text,            -- HMAC-SHA256 of the normalized address (street + unit + ZIP5)
  street_hash text,             -- HMAC-SHA256 of ZIP5 + street line without the unit
  sku_code text,
  lot text,
  src text,
  utm jsonb,
  consent_at timestamptz not null,
  consent_text_version text not null references marketing.tk_consent_versions (version),
  unsubscribed_at timestamptz,  -- set from the Postmark webhook (Phase 3)
  ip_hash text,
  user_agent text,
  claim_token_hash text not null,
  completed_at timestamptz,     -- step 2 saved
  review_flags text[] not null default '{}',
  reject_reason text,
  shipstation_order_id text,
  dispenser_sku text,
  carrier text,
  tracking_number text,
  shipped_at timestamptz,
  delivered_at timestamptz
);

create unique index tk_claims_email_uq on marketing.tk_claims (email);
create unique index tk_claims_address_uq on marketing.tk_claims (address_hash)
  where address_hash is not null and status <> 'rejected';
create index tk_claims_street_idx on marketing.tk_claims (street_hash, completed_at) where street_hash is not null;
create index tk_claims_completed_idx on marketing.tk_claims (completed_at) where completed_at is not null;
create index tk_claims_status_idx on marketing.tk_claims (status, created_at);

create table marketing.tk_scans (
  id bigint generated always as identity primary key,
  scanned_at timestamptz not null default now(),
  sku_code text,                -- base code (sc, ut, …); unknown codes are logged raw
  lot text,
  ip_hash text,
  user_agent text
);
create index tk_scans_scanned_idx on marketing.tk_scans (scanned_at);
create index tk_scans_ip_idx on marketing.tk_scans (ip_hash, scanned_at);

create table marketing.tk_claim_events (
  id bigint generated always as identity primary key,
  claim_id uuid references marketing.tk_claims (id),
  at timestamptz not null default now(),
  event text not null,          -- status changes, ShipStation responses
  detail jsonb
);
create index tk_claim_events_claim_idx on marketing.tk_claim_events (claim_id, at);

-- Drip definition: one row per email in each flow.
create table marketing.tk_email_steps (
  step_key text primary key,    -- e.g. 'A3_biz'
  flow text not null check (flow in ('A', 'B', 'D')),
  segments text[] not null check (segments <@ array['biz_high', 'biz_core', 'light'] and cardinality(segments) > 0),
  -- start = step 1 time, claim = step 2 time (completed_at), runout = runout_at 09:00 CT
  anchor text not null default 'claim' check (anchor in ('start', 'claim', 'runout')),
  delay interval not null default interval '0',
  -- Flow D: added on top of the anchor as greatest(run-out cycle, repeat_min); tk-drip
  -- re-arms the next occurrence after each send.
  repeat_min interval,
  postmark_template_alias text not null,
  attribution_tag text not null,
  active boolean not null default true
);

-- One row per scheduled email per claimant (per occurrence for Flow D).
create table marketing.tk_email_sends (
  id bigint generated always as identity primary key,
  claim_id uuid not null references marketing.tk_claims (id),
  step_key text not null references marketing.tk_email_steps (step_key),
  occurrence int not null default 1,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'skipped', 'failed', 'cancelled')),
  sent_at timestamptz,
  postmark_message_id text,
  error text,
  created_at timestamptz not null default now(),
  unique (claim_id, step_key, occurrence) -- idempotency: never double-send
);
create index tk_email_sends_due on marketing.tk_email_sends (scheduled_for) where status = 'scheduled';
create index tk_email_sends_message_idx on marketing.tk_email_sends (postmark_message_id) where postmark_message_id is not null;

-- Raw Postmark webhook events (Phase 3).
create table marketing.tk_email_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  postmark_message_id text,
  record_type text not null,    -- Delivery | Open | Click | Bounce | SpamComplaint | SubscriptionChange
  email text,
  payload jsonb not null
);
create index tk_email_events_message_idx on marketing.tk_email_events (postmark_message_id);

-- Every claim-form submit (accepted or not) — the rate limits count these.
create table marketing.tk_submit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  action text not null check (action in ('start', 'address')),
  ip_hash text,
  claim_id uuid,
  result text not null
);
create index tk_submit_log_ip_idx on marketing.tk_submit_log (ip_hash, at);
create index tk_submit_log_claim_idx on marketing.tk_submit_log (claim_id, at) where claim_id is not null;

-- RLS on, no anon/authenticated policies: only service_role (Edge Functions, the
-- dashboard's server path) touches this schema, and it bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['program_config', 'tk_consent_versions', 'tk_claims', 'tk_scans', 'tk_claim_events',
                           'tk_email_steps', 'tk_email_sends', 'tk_email_events', 'tk_submit_log'] loop
    execute format('alter table marketing.%I enable row level security', t);
    execute format('revoke all on marketing.%I from public, anon, authenticated', t);
    execute format('grant all on marketing.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema marketing to service_role;
alter default privileges in schema marketing revoke all on tables from public, anon, authenticated;
alter default privileges in schema marketing revoke all on sequences from public, anon, authenticated;
alter default privileges in schema marketing revoke all on functions from public, anon, authenticated;

create function marketing.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger tk_claims_touch before update on marketing.tk_claims
  for each row execute function marketing.touch_updated_at();
create trigger program_config_touch before update on marketing.program_config
  for each row execute function marketing.touch_updated_at();

-- ---------------------------------------------------------------- helpers

create function marketing.cfg(p_key text) returns jsonb
language sql stable set search_path = '' as $$
  select c.value from marketing.program_config c where c.key = p_key
$$;

-- Business use cases = shipping_ecommerce, warehouse_freight, office, events_av.
-- Light/home = moving, home, or 1-or-less rolls a month regardless of use case.
create function marketing.tk_segment(p_use_case text, p_band text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_use_case in ('moving', 'home') or p_band = 'le1' then 'light'
    when p_band in ('21_50', '50_plus') then 'biz_high'
    else 'biz_core'
  end
$$;

-- Days a 6-roll pack lasts at the band's stated volume (program_config).
create function marketing.tk_runout_days(p_band text) returns integer
language sql stable set search_path = '' as $$
  select coalesce((marketing.cfg('runout_days_by_band') ->> p_band)::int, 30)
$$;

-- Completed claims this calendar month (America/Chicago); rejected/cancelled excluded.
create function marketing.tk_month_claims() returns integer
language sql stable set search_path = '' as $$
  select count(*)::int
  from marketing.tk_claims c
  where c.completed_at >= (date_trunc('month', now() at time zone 'America/Chicago') at time zone 'America/Chicago')
    and c.status not in ('rejected', 'cancelled')
$$;

-- open | ended (kill switch: claims_enabled false or missing) | paused (monthly cap hit)
create function marketing.tk_offer_state() returns text
language sql stable set search_path = '' as $$
  select case
    when coalesce((marketing.cfg('claims_enabled'))::boolean, false) is not true then 'ended'
    when marketing.tk_month_claims() >= coalesce((marketing.cfg('monthly_cap'))::int, 0) then 'paused'
    else 'open'
  end
$$;

-- Schedules a claim's sends for one flow: one row per active step whose segments
-- include the claim's segment. Re-running re-arms rows that have not gone out
-- (scheduled / cancelled) and never touches sent ones.
create function marketing.tk_enroll(p_claim_id uuid, p_flow text) returns integer
language plpgsql set search_path = '' as $$
declare n integer;
begin
  insert into marketing.tk_email_sends (claim_id, step_key, occurrence, scheduled_for)
  select c.id, s.step_key, 1,
         case s.anchor
           when 'start' then now()
           when 'claim' then c.completed_at
           else (c.runout_at + time '09:00') at time zone 'America/Chicago'
         end
         + s.delay
         + case when s.repeat_min is null then interval '0'
                else greatest(make_interval(days => marketing.tk_runout_days(c.monthly_rolls_band)), s.repeat_min)
           end
  from marketing.tk_claims c
  join marketing.tk_email_steps s on s.flow = p_flow and s.active and c.segment = any (s.segments)
  where c.id = p_claim_id
    and (s.anchor <> 'claim' or c.completed_at is not null)
    and (s.anchor <> 'runout' or c.runout_at is not null)
  on conflict (claim_id, step_key, occurrence) do update
    set scheduled_for = excluded.scheduled_for, status = 'scheduled', error = null
    where marketing.tk_email_sends.status in ('scheduled', 'cancelled');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- RPCs (tk-claim / tk-scan)

-- What the /claim page needs at load: offer state, the active dispenser's public
-- fields and the current consent text.
create function public.tk_claim_config() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'state', marketing.tk_offer_state(),
    'dispenser', marketing.cfg('dispensers') -> (marketing.cfg('active_dispenser_sku') #>> '{}'),
    'consent', (
      select jsonb_build_object('version', v.version, 'text', v.consent_text)
      from marketing.tk_consent_versions v
      where v.version = marketing.cfg('consent_version') #>> '{}'
    )
  )
$$;

-- Step 1. p: email, first_name, use_case, monthly_rolls_band, company, purchase_channel,
-- consent_text_version, sku_code, lot, src, utm, ip_hash, user_agent, token_hash
-- (validated and normalized by tk-claim). Result: started | resumed (an unfinished
-- claim for this email gets the new answers and a new token) | already_claimed |
-- ended | paused | rate_limited.
create function public.tk_claim_start(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_ip text := nullif(p ->> 'ip_hash', '');
  v_seg text := marketing.tk_segment(p ->> 'use_case', p ->> 'monthly_rolls_band');
  v_claim marketing.tk_claims%rowtype;
  v_state text;
  v_result text;
begin
  if v_ip is not null and (
    select count(*) from marketing.tk_submit_log l
    where l.ip_hash = v_ip and l.action = 'start' and l.at > now() - interval '1 hour'
  ) >= coalesce((marketing.cfg('rate_limit_per_hour'))::int, 3) then
    v_result := 'rate_limited';
  else
    v_state := marketing.tk_offer_state();
    if v_state <> 'open' then
      v_result := v_state;
    else
      select * into v_claim from marketing.tk_claims c where c.email = lower(btrim(p ->> 'email')) for update;
      if found and v_claim.status <> 'started' then
        v_result := 'already_claimed';
        v_claim := null;
      elsif found then
        update marketing.tk_claims c set
          first_name = p ->> 'first_name',
          company = nullif(p ->> 'company', ''),
          use_case = p ->> 'use_case',
          monthly_rolls_band = p ->> 'monthly_rolls_band',
          segment = v_seg,
          purchase_channel = nullif(p ->> 'purchase_channel', ''),
          sku_code = coalesce(nullif(p ->> 'sku_code', ''), c.sku_code),
          lot = coalesce(nullif(p ->> 'lot', ''), c.lot),
          src = coalesce(nullif(p ->> 'src', ''), c.src),
          utm = coalesce(nullif(p -> 'utm', '{}'::jsonb), c.utm),
          consent_at = now(),
          consent_text_version = p ->> 'consent_text_version',
          ip_hash = v_ip,
          user_agent = nullif(p ->> 'user_agent', ''),
          claim_token_hash = p ->> 'token_hash'
        where c.id = v_claim.id;
        perform marketing.tk_enroll(v_claim.id, 'B');
        insert into marketing.tk_claim_events (claim_id, event, detail)
        values (v_claim.id, 'step1_resumed', jsonb_build_object('segment', v_seg));
        v_result := 'resumed';
      else
        begin
          insert into marketing.tk_claims (
            email, first_name, company, use_case, monthly_rolls_band, segment, purchase_channel,
            sku_code, lot, src, utm, consent_at, consent_text_version, ip_hash, user_agent, claim_token_hash)
          values (
            lower(btrim(p ->> 'email')), p ->> 'first_name', nullif(p ->> 'company', ''), p ->> 'use_case',
            p ->> 'monthly_rolls_band', v_seg, nullif(p ->> 'purchase_channel', ''),
            nullif(p ->> 'sku_code', ''), nullif(p ->> 'lot', ''), nullif(p ->> 'src', ''),
            nullif(p -> 'utm', '{}'::jsonb), now(), p ->> 'consent_text_version', v_ip,
            nullif(p ->> 'user_agent', ''), p ->> 'token_hash')
          returning * into v_claim;
          perform marketing.tk_enroll(v_claim.id, 'B');
          insert into marketing.tk_claim_events (claim_id, event, detail)
          values (v_claim.id, 'step1_started',
                  jsonb_build_object('segment', v_seg, 'sku_code', v_claim.sku_code, 'src', v_claim.src));
          v_result := 'started';
        exception when unique_violation then
          v_result := 'already_claimed'; -- same email raced in from a second tab
          v_claim := null;
        end;
      end if;
    end if;
  end if;

  insert into marketing.tk_submit_log (action, ip_hash, claim_id, result)
  values ('start', v_ip, v_claim.id, v_result);
  return jsonb_build_object('result', v_result, 'claim_id', v_claim.id);
end $$;

-- Step 2. p: claim_id, token_hash, ship_name, address1, address2, city, state, zip,
-- address_hash, street_hash, flags (text[] computed by tk-claim, e.g.
-- zip_state_mismatch), ip_hash. Result: ok | invalid (unknown claim / wrong token) |
-- already_claimed (address in use) | ended | paused | rate_limited. A claim that
-- already finished step 2 answers ok and changes nothing (double tap, back button).
create function public.tk_claim_address(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_claim marketing.tk_claims%rowtype;
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(p -> 'flags')), '{}');
  v_status marketing.claim_status;
  v_state text;
  v_days int;
  v_result text;
begin
  begin
    v_id := (p ->> 'claim_id')::uuid;
  exception when others then
    v_id := null;
  end;
  select * into v_claim from marketing.tk_claims c where c.id = v_id for update;

  if not found or v_claim.claim_token_hash is distinct from (p ->> 'token_hash') then
    v_result := 'invalid';
    v_claim := null;
  elsif (
    select count(*) from marketing.tk_submit_log l
    where l.claim_id = v_claim.id and l.action = 'address' and l.at > now() - interval '1 hour'
  ) >= 5 then
    v_result := 'rate_limited';
  elsif v_claim.status <> 'started' then
    v_result := 'ok';
  else
    v_state := marketing.tk_offer_state();
    if v_state <> 'open' then
      v_result := v_state;
    elsif exists (
      select 1 from marketing.tk_claims c
      where c.address_hash = p ->> 'address_hash' and c.id <> v_claim.id and c.status <> 'rejected'
    ) then
      v_result := 'already_claimed';
    else
      if split_part(v_claim.email, '@', 2) in (
        select jsonb_array_elements_text(coalesce(marketing.cfg('disposable_domains'), '[]'::jsonb))
      ) then
        v_flags := array_append(v_flags, 'disposable_email');
      end if;
      if (
        select count(*) from marketing.tk_claims c
        where c.street_hash = p ->> 'street_hash' and c.id <> v_claim.id and c.status <> 'rejected'
          and c.completed_at > now() - interval '30 days'
      ) >= 2 then
        v_flags := array_append(v_flags, 'street_cluster'); -- this would be the 3rd in 30 days
      end if;
      v_status := case
        when cardinality(v_flags) > 0 or coalesce((marketing.cfg('auto_approve'))::boolean, false) is not true
          then 'pending_review'
        else 'approved'
      end;
      v_days := greatest(marketing.tk_runout_days(v_claim.monthly_rolls_band),
                         coalesce((marketing.cfg('runout_min_days'))::int, 0));
      begin
        update marketing.tk_claims c set
          ship_name = p ->> 'ship_name',
          address1 = p ->> 'address1',
          address2 = nullif(p ->> 'address2', ''),
          city = p ->> 'city',
          state = p ->> 'state',
          zip = p ->> 'zip',
          address_hash = p ->> 'address_hash',
          street_hash = p ->> 'street_hash',
          status = v_status,
          review_flags = v_flags,
          completed_at = now(),
          runout_at = (now() at time zone 'America/Chicago')::date + v_days,
          dispenser_sku = marketing.cfg('active_dispenser_sku') #>> '{}'
        where c.id = v_claim.id;
        update marketing.tk_email_sends s set status = 'cancelled'
        where s.claim_id = v_claim.id and s.status = 'scheduled'
          and s.step_key in (select st.step_key from marketing.tk_email_steps st where st.flow = 'B');
        perform marketing.tk_enroll(v_claim.id, 'A');
        perform marketing.tk_enroll(v_claim.id, 'D');
        insert into marketing.tk_claim_events (claim_id, event, detail)
        values (v_claim.id, 'step2_completed',
                jsonb_build_object('status', v_status, 'review_flags', to_jsonb(v_flags),
                                   'dispenser_sku', marketing.cfg('active_dispenser_sku') #>> '{}'));
        v_result := 'ok';
      exception when unique_violation then
        v_result := 'already_claimed'; -- the address landed in a concurrent claim
      end;
    end if;
  end if;

  insert into marketing.tk_submit_log (action, ip_hash, claim_id, result)
  values ('address', nullif(p ->> 'ip_hash', ''), v_claim.id, v_result);
  return jsonb_build_object('result', v_result);
end $$;

-- QR scan. p: sku_code, lot, ip_hash, user_agent. Over the per-IP hourly limit the
-- scan is dropped (a stuck page or a script, not a person).
create function public.tk_log_scan(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_ip text := nullif(p ->> 'ip_hash', '');
begin
  if v_ip is not null and (
    select count(*) from marketing.tk_scans s where s.ip_hash = v_ip and s.scanned_at > now() - interval '1 hour'
  ) >= coalesce((marketing.cfg('scan_limit_per_hour'))::int, 30) then
    return jsonb_build_object('result', 'rate_limited');
  end if;
  insert into marketing.tk_scans (sku_code, lot, ip_hash, user_agent)
  values (left(p ->> 'sku_code', 24), nullif(left(p ->> 'lot', 16), ''), v_ip, nullif(left(p ->> 'user_agent', 300), ''));
  return jsonb_build_object('result', 'ok');
end $$;

-- Default privileges in public grant EXECUTE on new functions to anon/authenticated:
-- revoke, so only service_role (the Edge Functions) can call these.
revoke all on function public.tk_claim_config() from public, anon, authenticated;
revoke all on function public.tk_claim_start(jsonb) from public, anon, authenticated;
revoke all on function public.tk_claim_address(jsonb) from public, anon, authenticated;
revoke all on function public.tk_log_scan(jsonb) from public, anon, authenticated;
grant execute on function public.tk_claim_config() to service_role;
grant execute on function public.tk_claim_start(jsonb) to service_role;
grant execute on function public.tk_claim_address(jsonb) to service_role;
grant execute on function public.tk_log_scan(jsonb) to service_role;
revoke all on all functions in schema marketing from public, anon, authenticated;
grant execute on all functions in schema marketing to service_role;

-- ---------------------------------------------------------------- seed

insert into marketing.tk_consent_versions (version, consent_text) values
  ('2026-10-v1',
   'Email me shipping updates for my free dispenser, plus Tape King product tips and offers. I can unsubscribe at any time.');

-- Dispenser SKUs are placeholders until Phase 0 names the warehouse SKUs; image_asin
-- picks the photo the page shows (B077GCV6PH = the gun Kennon says is 3",
-- B01MAT3DPM = the 2" two-pack listing).
insert into marketing.program_config (key, value, note) values
  ('claims_enabled', 'true', 'Kill switch. false = /claim shows the offer-ended page.'),
  ('monthly_cap', '500', 'Completed claims per calendar month (America/Chicago) before /claim shows paused. Placeholder — Phase 0.'),
  ('auto_approve', 'true', 'Unflagged claims go straight to approved; false = every claim waits for review.'),
  ('drip_enabled', 'false', 'Global drip switch read by tk-drip (Phase 3). Off until the sender and templates exist.'),
  ('active_dispenser_sku', '"GUN-3IN-TBD"', 'Key into dispensers; recorded on each claim at step 2. Placeholder SKU — Phase 0.'),
  ('fallback_dispenser_sku', '"GUN-2IN-TBD"', 'Switched to when the active gun hits its floor (Phase 4). Placeholder SKU.'),
  ('dispenser_floor', '{"GUN-3IN-TBD": 25, "GUN-2IN-TBD": 25}', 'Units left in Finale that trigger the switch / pause (Phase 4). Placeholder — Phase 0.'),
  ('dispensers',
   '{"GUN-3IN-TBD": {"label": "3\" dispenser gun", "size_in": 3, "tape_included": true, "headline": "Your free Tape King dispenser gun, tape included", "image_asin": "B077GCV6PH"},
     "GUN-2IN-TBD": {"label": "2\" dispenser gun", "size_in": 2, "tape_included": false, "headline": "Your free Tape King dispenser gun", "image_asin": "B01MAT3DPM"}}',
   'Public fields the /claim page shows for the active dispenser. Confirm tape_included for the 2" gun.'),
  ('runout_days_by_band', '{"le1": 180, "2_5": 51, "6_20": 14, "21_50": 5, "50_plus": 3}',
   'Days a 6-roll pack lasts at the band midpoint (6 / rolls per month × 30). Also the Flow D cycle.'),
  ('runout_min_days', '14', 'Floor on runout_at so the restock email never lands before the dispenser does.'),
  ('rate_limit_per_hour', '3', 'Step-1 submits per IP hash per hour.'),
  ('scan_limit_per_hour', '30', 'Logged scans per IP hash per hour.'),
  ('consent_version', '"2026-10-v1"', 'tk_consent_versions row the page shows and new claims record.'),
  ('send_window', '{"tz": "America/Chicago", "weekdays": [1, 2, 3, 4, 5], "start": "08:00", "end": "17:00"}',
   'Drip send window for tk-drip (Phase 3).'),
  ('disposable_domains',
   '["mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "sharklasers.com", "grr.la", "pokemail.net", "spam4.me", "10minutemail.com", "10minutemail.net", "temp-mail.org", "tempmail.com", "tempmail.net", "tempmailo.com", "tempr.email", "tmpmail.org", "tmpmail.net", "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.de", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com", "burnermail.io", "discard.email", "spamgourmet.com", "mytemp.email", "tempinbox.com", "moakt.com", "mailcatch.com", "inboxkitten.com", "mailpoof.com", "fakemail.net", "emailfake.com", "1secmail.com", "1secmail.net", "dropmail.me", "minuteinbox.com", "mail.tm", "linshiyouxiang.net", "temp-mail.io"]',
   'Domains flagged for manual review (not rejected).');

insert into marketing.tk_email_steps
  (step_key, flow, segments, anchor, delay, repeat_min, postmark_template_alias, attribution_tag) values
  ('A1_all',     'A', '{biz_high,biz_core,light}', 'claim',  '0 days',  null,      'tk-a1-claim-confirmed', 'tk-drip-a1-all'),
  ('A2_all',     'A', '{biz_high,biz_core,light}', 'claim',  '3 days',  null,      'tk-a2-which-tape',      'tk-drip-a2-all'),
  ('A3_biz',     'A', '{biz_high,biz_core}',       'claim',  '7 days',  null,      'tk-a3-case-math',       'tk-drip-a3-biz'),
  ('A3_home',    'A', '{light}',                   'claim',  '7 days',  null,      'tk-a3-moving-kit',      'tk-drip-a3-home'),
  ('A4_biz',     'A', '{biz_high,biz_core}',       'claim',  '12 days', null,      'tk-a4-subscribe-save',  'tk-drip-a4-biz'),
  ('A5_bizhigh', 'A', '{biz_high}',                'claim',  '18 days', null,      'tk-a5-kennon-note',     'tk-drip-a5-bizhigh'),
  ('A6_all',     'A', '{biz_high,biz_core,light}', 'claim',  '25 days', null,      'tk-a6-round-out-bench', 'tk-drip-a6-all'),
  ('A7_biz',     'A', '{biz_high,biz_core}',       'runout', '0 days',  null,      'tk-a7-restock',         'tk-drip-a7-biz'),
  ('B1_all',     'B', '{biz_high,biz_core,light}', 'start',  '2 hours', null,      'tk-b1-finish-claim',    'tk-drip-b1-all'),
  ('D1_biz',     'D', '{biz_high,biz_core}',       'runout', '0 days',  '30 days', 'tk-d1-reorder',         'tk-drip-d1-biz');
