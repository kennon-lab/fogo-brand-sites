-- Tape King dispenser funnel: step 2 refused for an address already in use now cancels
-- the claim's Flow B ("finish your claim") emails. Applied to the production project as
-- migration `tk_claim_address_dup_cancels_flow_b` (2026-10-26), after
-- tk_dispenser_funnel_phase1.sql. Found in the live acceptance test: a second email with
-- the same address was refused at step 2 but its claim kept B1 scheduled, so once the drip
-- runs it would remind someone to finish a claim they can't complete.
--
-- CREATE OR REPLACE keeps the function's owner and grants (EXECUTE for service_role only).

-- Step 2. p: claim_id, token_hash, ship_name, address1, address2, city, state, zip,
-- address_hash, street_hash, flags (text[] computed by tk-claim, e.g.
-- zip_state_mismatch), ip_hash. Result: ok | invalid (unknown claim / wrong token) |
-- already_claimed (address in use) | ended | paused | rate_limited. A claim that
-- already finished step 2 answers ok and changes nothing (double tap, back button).
-- already_claimed also cancels the claim's Flow B ("finish your claim") emails: the
-- address is taken, so the reminder would nudge them toward a claim they can't finish.
-- Re-entering step 1 with the same email re-arms Flow B (tk_claim_start → tk_enroll).
create or replace function public.tk_claim_address(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_claim marketing.tk_claims%rowtype;
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(p -> 'flags')), '{}');
  v_status marketing.claim_status;
  v_state text;
  v_days int;
  v_result text;
  v_cancelled int;
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

  if v_result = 'already_claimed' then
    update marketing.tk_email_sends s set status = 'cancelled'
    where s.claim_id = v_claim.id and s.status = 'scheduled'
      and s.step_key in (select st.step_key from marketing.tk_email_steps st where st.flow = 'B');
    get diagnostics v_cancelled = row_count;
    insert into marketing.tk_claim_events (claim_id, event, detail)
    values (v_claim.id, 'step2_address_in_use', jsonb_build_object('flow_b_cancelled', v_cancelled));
  end if;

  insert into marketing.tk_submit_log (action, ip_hash, claim_id, result)
  values ('address', nullif(p ->> 'ip_hash', ''), v_claim.id, v_result);
  return jsonb_build_object('result', v_result);
end $$;
