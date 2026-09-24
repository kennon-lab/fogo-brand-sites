-- Email drip (EMAIL_CAPTURE_SCOPE_v1.md §6, §7.1). Additive; builds on
-- sql/email_capture.sql. Every function is SECURITY DEFINER and executable by
-- service_role only; the Vercel functions (api/drip-tick.js, api/confirm.js,
-- api/track.js, api/postmark-webhook.js) are the only callers.

alter table bronze.email_subscribers
  add column if not exists drip_done_at timestamptz;   -- set once the last step of the series is sent

-- Active, confirmed subscribers still in the series, with what they've been sent.
create or replace function public.email_drip_candidates(p_brand_slug text, p_subscriber_id uuid default null)
returns table (subscriber_id uuid, email text, track text, confirmed_at timestamptz,
               track_changed_at timestamptz, sent jsonb)
language sql security definer set search_path = '' stable as $$
  select s.id, s.email, s.track, s.confirmed_at, s.track_changed_at,
         coalesce((select jsonb_agg(jsonb_build_object('sequence', e.sequence, 'step', e.step, 'sent_at', e.sent_at))
                     from bronze.email_sends e where e.subscriber_id = s.id), '[]'::jsonb)
    from bronze.email_subscribers s
   where s.brand_slug = p_brand_slug
     and s.status = 'active'
     and s.confirmed_at is not null
     and s.drip_done_at is null
     and (p_subscriber_id is null or s.id = p_subscriber_id)
   order by s.confirmed_at
   limit 500;
$$;

-- Reserve (subscriber, sequence, step) before sending. Returns the send id, or
-- null when it was already claimed or the subscriber is no longer active; the
-- unique constraint makes a double tick harmless.
create or replace function public.email_claim_send(p_subscriber_id uuid, p_sequence text, p_step int, p_template_hash text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not exists (select 1 from bronze.email_subscribers s
                  where s.id = p_subscriber_id and s.status = 'active' and s.confirmed_at is not null) then
    return null;
  end if;
  insert into bronze.email_sends (subscriber_id, sequence, step, template_hash, status)
  values (p_subscriber_id, p_sequence, p_step, p_template_hash, 'sending')
  -- A claim stuck in 'sending' for 30+ minutes (function crashed mid-send) can be retaken.
  on conflict (subscriber_id, sequence, step) do update
     set sent_at = now(), template_hash = excluded.template_hash
   where bronze.email_sends.status = 'sending' and bronze.email_sends.sent_at < now() - interval '30 minutes'
  returning id into v_id;
  return v_id;
end $$;

-- Outcome of a claimed send. A failed send releases the claim so the next tick retries.
create or replace function public.email_finish_send(p_send_id bigint, p_message_id text, p_ok boolean, p_last_step boolean)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not p_ok then
    delete from bronze.email_sends where id = p_send_id;
    return;
  end if;
  update bronze.email_sends set provider_message_id = p_message_id, status = 'sent', sent_at = now()
   where id = p_send_id;
  if p_last_step then
    update bronze.email_subscribers s set drip_done_at = now(), updated_at = now()
      from bronze.email_sends e where e.id = p_send_id and s.id = e.subscriber_id;
  end if;
end $$;

-- "What are you making?" choice from the general welcome email: switched |
-- already | invalid. The email links to /subscribe/choose/<track>/, which needs
-- a click to POST to /api/track, so link scanners never switch anyone.
-- Clears drip_done_at so a subscriber who finished the fallback emails still
-- gets the chosen track's series.
create or replace function public.email_set_track(p_brand_slug text, p_subscriber_id uuid, p_track text)
returns text
language plpgsql security definer set search_path = '' as $$
declare r bronze.email_subscribers%rowtype;
begin
  select * into r from bronze.email_subscribers s
   where s.id = p_subscriber_id and s.brand_slug = p_brand_slug for update;
  if not found or r.status <> 'active' then return 'invalid'; end if;
  if r.track <> 'general' then return 'already'; end if;
  if not exists (select 1 from bronze.email_sends e
                  where e.subscriber_id = r.id and e.sequence = 'general' and e.step = 1 and e.status = 'sent') then
    return 'invalid';
  end if;
  update bronze.email_subscribers s
     set track = p_track, track_changed_at = now(), drip_done_at = null, updated_at = now()
   where s.id = r.id;
  return 'switched';
end $$;

-- Postmark webhook → subscriber status + event log. Finds the subscriber by
-- id (message metadata) or by brand + email. p_status: unsubscribed |
-- bounced | complained | null (event only).
create or replace function public.email_apply_event(
  p_brand_slug text, p_subscriber_id uuid, p_email text, p_status text,
  p_type text, p_message_id text, p_url text, p_payload jsonb, p_occurred_at timestamptz
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  select s.id into v_id from bronze.email_subscribers s
   where s.brand_slug = p_brand_slug
     and ((p_subscriber_id is not null and s.id = p_subscriber_id)
          or (p_email is not null and lower(s.email) = lower(p_email)))
   limit 1;

  insert into bronze.email_events (provider_message_id, subscriber_id, type, url, payload, occurred_at)
  values (p_message_id, v_id, p_type, p_url, p_payload, coalesce(p_occurred_at, now()));

  if v_id is null or p_status is null then return 'logged'; end if;
  if p_status not in ('unsubscribed', 'bounced', 'complained') then return 'logged'; end if;

  update bronze.email_subscribers s
     set status = p_status,
         unsubscribed_at = case when p_status = 'unsubscribed' then now() else s.unsubscribed_at end,
         updated_at = now()
   where s.id = v_id and s.status in ('active', 'pending');
  return 'updated';
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.email_drip_candidates(text, uuid)',
    'public.email_claim_send(uuid, text, int, text)',
    'public.email_finish_send(bigint, text, boolean, boolean)',
    'public.email_set_track(text, uuid, text)',
    'public.email_apply_event(text, uuid, text, text, text, text, text, jsonb, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
