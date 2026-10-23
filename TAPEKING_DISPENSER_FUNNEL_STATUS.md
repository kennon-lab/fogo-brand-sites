# Tape King dispenser funnel — build status

Spec: `TAPEKING_DISPENSER_FUNNEL_SCOPE.md` (Oct 22, 2026, with the QR-generator update). This file
tracks what is built, what is live, and what has to happen before rolls with the QR ship.

Updated 2026-10-23 · **Phase 1 (Capture) built.** Database and Edge Functions are live in
production; the site changes deploy when this branch merges.

## Phase 1 — what exists

| Piece | Where | State |
| --- | --- | --- |
| `marketing` schema: claims, scans, claim events, drip steps, scheduled sends, email events, program config, consent versions, submit log | `sql/tk_dispenser_funnel_phase1.sql` → migration `tk_dispenser_funnel_phase1` | **Applied to production** 2026-10-23. RLS on, no anon/authenticated access, not exposed through PostgREST |
| RPCs `public.tk_claim_config`, `tk_claim_start`, `tk_claim_address`, `tk_log_scan` | same migration | Live, service_role only |
| Drip definition (A1–A7, B1, D1) + program config seed | same migration | Seeded; nothing sends until Phase 3 builds `tk-drip` (`drip_enabled` = false) |
| `tk-claim` Edge Function | `supabase/functions/tk-claim/` | **Deployed** (v1). Fails closed: answers `state: unavailable` until its secrets are set |
| `tk-scan` Edge Function | `supabase/functions/tk-scan/` | **Deployed** (v1). Refuses scans until `TK_HASH_PEPPER` is set |
| `/claim/` two-step page, offer terms, thank-you, ended / paused / unavailable states | `src/components/brands/tape-king/ClaimPage.astro`, copy in `src/content/brands/tape-king/claim.yaml` | On this branch |
| `/r/<code>[<lot>]` redirect + scan beacon, `/free/` typed fallback | `src/pages/r/`, `src/pages/[typed]/`, `vercel.json` rewrite | On this branch |
| QR printer artwork (SVG + PDF, EC Q, 22 mm incl. quiet zone) for `sc`, `ut`, `gf`, `dt` | `scripts/make-qr.ts` → `qr/tape-king/` | Generated; each file decoded back to its URL |
| Privacy-policy section for the offer | `src/components/ClaimPrivacy.astro` (Tape King only) | On this branch |

### How it was verified

- **SQL:** the migration plus 27 behavior checks ran on a local Postgres (PGlite) before applying:
  segments, run-out floor, Flow A/B/D timing, B cancelled by step 2, email + address dedupe, the
  three review flags, rate limits, cap → paused, kill switch → ended, and that anon/authenticated
  can't reach anything. After applying: grants and RLS re-checked in production; Supabase security
  advisors show only the expected INFO "RLS enabled, no policy" on the new tables.
- **Edge Functions:** `npm run test:functions` (17 tests, Turnstile and PostgREST mocked —
  including replayed tokens, wrong action or hostname, and a siteverify outage). Deployed copies
  smoke-tested from the database with `pg_net`: GET → `{"ok":true,"state":"unavailable"}`
  with the right CORS header; POSTs without an allowed Origin → 403.
- **Page, end to end:** the site built for `tape-king` against a local mock of Supabase that runs the
  real `handler.ts` code on PGlite with the migration, then a headless phone browser walked the
  funnel (32 checks): QR redirect logs the scan and carries sku/lot/UTMs; live headline, chip and
  consent load from config; inline validation; step 1 creates the claim (segment, Flow B); ZIP/state
  warning; step 2 approves and schedules A1–A7 + D1 and cancels B1; GA events fire; same email and the
  same address typed differently are both blocked; outside-US, resume after refresh, rate limit,
  `/free/`, unknown code, kill switch, cap, live 3"→2" dispenser switch and a config outage all
  render the right state. The hero (headline, photo, value props, button) fits above the fold on
  iPhone 13 and Pixel 5. A brand without `claim.yaml` builds none of the new routes.

## To go live — needs you

1. **Cloudflare Turnstile — done except one value.** Widget `0x4AAAAAAFifp7lkrIeBcyHo` (created in
   the Cloudflare dashboard). `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and `TK_HASH_PEPPER` are
   stored as Edge Function secrets (2026-10-23). Still to do:
   - Add the secret `TURNSTILE_HOSTNAMES` = `tapeking.com,www.tapeking.com` (Supabase dashboard →
     Edge Functions → Secrets). Until it exists the claim page shows "unavailable": siteverify
     must report one of these hostnames for a token to count, and an empty list refuses everything.
     Never add `localhost` to it in production.
   - In the Cloudflare dashboard, confirm the widget's hostnames include `tapeking.com` and
     `www.tapeking.com`. To test on a Vercel preview, add that preview's hostname to the widget
     **and** to `TURNSTILE_HOSTNAMES`, then remove it from both afterwards.
2. **`TK_HASH_PEPPER`** hashes IPs, addresses and claim tokens. Never change it after launch, or the
   one-per-address check stops matching earlier claims. Secret changes need no function redeploy.
3. **Contact address.** `brand_sites.contact_email` is empty for Tape King, so the page omits the
   "Questions about your dispenser shipment? Email …" line and the privacy page falls back to the
   contact page. Set it to the Tape King address that should get dispenser-shipping questions.
4. **Program config (Phase 0 numbers).** In `marketing.program_config`: replace the placeholder
   dispenser SKUs `GUN-3IN-TBD` / `GUN-2IN-TBD` (keys of `dispensers`, `active_dispenser_sku`,
   `fallback_dispenser_sku`, `dispenser_floor`) with the real warehouse SKUs; set `monthly_cap`
   (500 is the scope's placeholder) and the floors; confirm whether the 2" gun ships with tape
   (`tape_included`) and that `image_asin` B077GCV6PH / B01MAT3DPM show the right guns.
5. **Consent text sign-off.** v1 (`2026-10-v1`): "Email me shipping updates for my free dispenser,
   plus Tape King product tips and offers. I can unsubscribe at any time." To change it, insert a new
   `marketing.tk_consent_versions` row and point `consent_version` at it (claims keep the version
   they agreed to).
6. ~~Merge this branch~~ — merged 2026-10-23 (PR #6); `/claim/`, `/r/` and `/free/` are live on tapeking.com.
7. **Phase 0:** Seller Support / account-manager confirmation of the flow (save the case ID) before
   the print run. Printer files: `qr/tape-king/` (see its README). Add lot suffixes with
   `npm run qr -- --lot=26a` if a print run should be traceable.

### Phase 1 acceptance test (real phone, once `TURNSTILE_HOSTNAMES` is set)

1. Open `qr/tape-king/sc.svg` on a screen and scan it with a phone. It should land on
   `https://www.tapeking.com/claim/?src=qr&sku=sc&utm_source=tape_core&utm_medium=qr&utm_campaign=dispenser_claim`.
2. Finish both steps with a real email and address.
3. Check the rows:
   ```sql
   select sku_code, lot, scanned_at from marketing.tk_scans order by id desc limit 3;
   select id, status, segment, runout_at, review_flags from marketing.tk_claims order by created_at desc limit 3;
   select step_key, status, scheduled_for from marketing.tk_email_sends
   where claim_id = '<claim id>' order by scheduled_for;
   ```
4. Claim again with the same email (blocked), then with another email and the same address
   (blocked at step 2).
5. **Turnstile replay check** (Cloudflare's validation step): on a desktop browser, open DevTools →
   Network before submitting step 1, then right-click the successful `tk-claim` POST → Copy → Copy as
   fetch, paste it into the Console and run it. The response must be
   `{"ok":false,"error":"turnstile"}` — a Turnstile token works exactly once.
6. Before launch, remove the test data (children first):
   ```sql
   delete from marketing.tk_email_sends where claim_id in (<test ids>);
   delete from marketing.tk_claim_events where claim_id in (<test ids>);
   delete from marketing.tk_submit_log where claim_id in (<test ids>) or claim_id is null;
   delete from marketing.tk_claims where id in (<test ids>);
   delete from marketing.tk_scans where scanned_at < '<launch time>';
   ```

## Decisions made while building (differences from the scope's draft)

- **Email is lowercased `text`, not `citext`.** citext isn't installed, and its `=` lives in the
  `extensions` schema, so functions pinned to `search_path = ''` would silently compare
  case-sensitively.
- **Step 2 needs a claim token** that only a Turnstile-checked step 1 hands out (HMAC stored), so
  nobody can attach an address to someone else's claim by guessing its id. Turnstile runs on step 1
  only.
- **Added columns/tables:** `tk_claims.completed_at` (the "claim date" for the drip and the monthly
  cap), `street_hash` (3+ per street flag), `claim_token_hash`, `user_agent`;
  `tk_email_steps.delay interval` + anchor `start | claim | runout` (Flow B is 2 hours after step 1)
  + `repeat_min` (Flow D's 30-day floor); `tk_email_sends.occurrence` so Flow D's repeats keep the
  idempotency key; `tk_consent_versions`; `tk_submit_log` for the rate limits.
- **Run-out floor.** `runout_at = completion date + max(band days, runout_min_days = 14)`. Without
  the floor a 21–50 or 50+ rolls/month claimant (6 rolls last 3–5 days) would get A7 "About time to
  restock?" before the dispenser arrives. Band days and the floor are in `program_config`.
- **`drip_enabled` seeded false** (scope said true): nothing can send until Phase 3, and Phase 3 should
  turn it on deliberately.
- **ZIP/state mismatch** warns once on the page and flags the claim for review; it never blocks.
  Rate limit counts step-1 submits per IP hash (3/hour); step 2 is limited per claim (5/hour).
- **Resume:** step 1 with the email of an unfinished claim updates it and issues a new token;
  a finished claim answers "already claimed" without saying which field matched.
- **Thank-you Amazon link** uses Ultra Thick's existing `brand_site` Attribution tag. A dedicated tag
  (e.g. a `claim_page` channel) would separate the funnel's sales from the rest of the site — worth
  adding with the Phase 3 per-email tags.
- **QR URLs stay lowercase** (`https://tapeking.com/r/sc`, byte mode, version 3, 29×29). Uppercase
  would allow the smaller alphanumeric mode, but the `/r/` path is case-sensitive on Vercel.

## Notes for later phases

- **Phase 2 (claims queue):** read/write `marketing` with the service role from the dashboard's server
  path; `tk_claim_events` is the audit trail for approve/reject. Flags live in `review_flags`.
- **Phase 3 (drip):** `tk-drip` must not burst-send old rows: claims made before it launches already
  have `scheduled_for` in the past, so skip or re-time anything more than about a day overdue. Two
  unmerged branches touch the same ground: `claude/email-capture-signup-drip-wio5y4` (generic
  brand-site email capture on Vercel Functions + the unused `bronze.email_*` tables) and
  `claude/tape-king-email-drip` (Tape King drip copy, `email/tape-king/drip-v1.md`) — reuse the copy,
  and decide whether `bronze.email_*` should be retired. The legal sender line decided there: Fogo
  Brands LLC, 1590 East Joyce Boulevard, Unit 10471, Fayetteville, AR 72703.
- **Phase 4 (ShipStation):** `dispenser_sku` is set on each claim at step 2 from
  `active_dispenser_sku`; the floor guard switches that key.
- **Local testing:** the Claude Code sandbox cannot reach `*.supabase.co`. The pattern used here: a
  small Node server that answers `/rest/v1/<view>` with fixtures, `/storage/v1/...` with placeholder
  images, `/rest/v1/rpc/<fn>` from PGlite loaded with the migration, and `/functions/v1/tk-*` by
  calling the real `handler.ts` (Turnstile siteverify stubbed); build with
  `SUPABASE_URL=http://127.0.0.1:54321`, `astro preview`, then Playwright with the Turnstile script
  route-stubbed.
