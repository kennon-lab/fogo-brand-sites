# Tape King QR Free Dispenser Funnel — Build Scope

Oct 22, 2026 · @Kennon Largent

## Summary

A QR code printed inside every Tape King roll sends buyers to a claim page on tapeking.com; they opt in to email, give a shipping address, and we ship a free dispenser. A Postmark drip, scheduled from Supabase, then turns those buyers, weighted toward business users, into repeat case and Subscribe & Save buyers on Amazon.

The page and the emails never sell off Amazon. Every buy CTA goes to the Amazon listing with an Amazon Attribution tag, same as the site does today.

**Success metrics (first 90 days after rolls with QR reach customers):**

- Scan → completed claim rate
- Share of claims that self-identify as business (shipping, warehouse, ecommerce, office)
- Attributed Amazon sales per claimant from drip clicks, vs. dispenser cost + shipping
- Repeat purchase rate on the Tape King listings (Brand Analytics repeat purchase) before vs. after

## Amazon compliance guardrails

This is the biggest risk in the project: the QR ships inside product sold on Amazon, so Amazon's insert rules apply. Voluntary email opt-in through a QR landing page is widely treated as allowed; review incentives and off-Amazon sales diversion are not. Seller guidance online is inconsistent, so confirm the exact flow with Seller Support or your account manager before the print run.

Hard rules for the build:

- **No review language anywhere.** The free dispenser is never tied to a review, rating or feedback — not on the page, not in any email. No "enjoying your tape?" review asks in this flow.
- **No off-Amazon checkout.** No cart, no discount code for tapeking.com, no "buy direct" pricing. Every buy CTA is an Amazon (Attribution-tagged) link. This matches the current site.
- **No customer-service diversion.** Don't say "contact us instead of Amazon" for order problems. Dispenser-shipping questions can go to a Tape King address; Amazon order issues stay on Amazon.
- **No Amazon order ID required** in v1. It reads as harvesting buyer data from the order; decided Oct 22 to ask for it only if fraud spikes.
- **Honest offer terms** on the page: limit one per business/address, US only, while supplies last, can end anytime.
- **CAN-SPAM:** clear consent text at signup, physical address and one-click unsubscribe in every email; update tapeking.com/privacy.

The printed URL is permanent once rolls ship, so the QR points at a redirect we control (section 4). If Amazon ever objects, we can repoint it to a support/how-to page without reprinting.

## Architecture

Build on what already exists: the tapeking.com Astro site in `fogo-brand-sites`, Supabase for data and server logic, Postmark for sending. The brand-sites repo is public, so all secrets (the Postmark server token included) live in Supabase Edge Function secrets, never in the site.

Postmark sends and tracks email but has no flow builder, so drip enrollment, timing and segment branching live in Supabase.

&#91;embedded content: claim-to-reorder flow · 9 steps\]

Scans and claims land in Supabase; the drip scheduler carries the buyer from a shipped dispenser to Amazon reorders.

| Component | Where | Job |
| --- | --- | --- |
| QR redirect | Vercel redirect on tapeking.com (`/r/:code`) | Short permanent URL; logs the scan, forwards to `/claim` with SKU + UTM params |
| Claim page | `fogo-brand-sites` → `tapeking/src/pages/claim.astro` | Two-step form, offer terms, thank-you state |
| `tk-claim` Edge Function | Supabase (Deno) | Validates, checks Turnstile, dedupes, writes the claim, sets the segment, enrolls in the drip |
| `tk-scan` Edge Function | Supabase (Deno) | Records the scan event (called from the redirect page) |
| Claim + email tables | Supabase `marketing` schema | Claims, scans, drip steps, scheduled sends, email events, program config (section 6) |
| `tk-drip` Edge Function + pg\_cron | Supabase | Every 15 min: picks due sends, sends via Postmark's broadcast stream, logs the message ID |
| `tk-postmark-webhook` Edge Function | Supabase | Receives delivery, open, click, bounce, spam-complaint and unsubscribe events |
| Postmark | Existing account | `outbound` stream for transactional (shipping); `broadcast` stream for the drip; templates and layouts |
| Claims queue | tools.fogobrands.com | Review, approve, export, see fulfillment and email status |
| `tk-fulfill` Edge Function + pg\_cron | Supabase | Pushes orders to the ShipStation claims store for Chicago; tracking returns by ship-notify webhook; then sends the shipping email (phase 4) |
| Amazon Attribution | Ads console | Per-email tags on every Amazon link |

Spam protection: Cloudflare Turnstile on the form, verified server-side in `tk-claim`.

## QR code and URL spec

Each product line gets its own short, permanent code so we know which tape drove the scan. Short URLs make a smaller, more scannable QR on a tape core.

- **Printed URL:** `https://tapeking.com/r/<code>` — e.g. `/r/sc` (Standard Clear), `/r/ut` (Ultra Thick), `/r/gf` (Gaffers), `/r/dt` (Duct). Optional lot suffix: `/r/sc26a`.
- **Redirect target:** `/claim?src=qr&sku=<code>&lot=<lot>&utm_source=tape_core&utm_medium=qr&utm_campaign=dispenser_claim`
- **Redirects live in config**, not hard-coded in the page, so a code can be repointed (e.g. to `/thanks-offer-ended`) without a deploy that touches the form.
- **QR spec for the printer:** error correction level M or higher, quiet zone of 4 modules, tested on a curved core at arm's length on iPhone and Android before sign-off.
- **Fallback text** printed next to the QR: "tapeking.com/free" → same claim page, `src=typed`.
- **Offer ended:** a flag in program config swaps `/claim` to a page that points to the Amazon store and the how-to content, so old rolls never hit a dead page.

**Generator: static codes from a repo script, no QR service.** The `/r/<code>` redirect already makes the code "dynamic" and logs every scan, so a paid platform (Uniqode, QR Code Generator Pro, Bitly) adds nothing. It also adds a risk: codes that route through their redirect break if the subscription lapses, and these rolls stay in circulation for years. A short script (`scripts/make-qr.ts` using the `qrcode` npm package) writes one vector SVG + PDF per code at error correction Q, for the printer to place on the core artwork.

## Landing page spec (`/claim`)

Mobile-first: nearly every visitor arrives from a phone camera. Two short steps, so we capture the email even if someone abandons the address step.

**Above the fold:** headline ("Your free Tape King dispenser gun, tape included"), dispenser photo, three-line value prop, one button. Reuse the site's existing type, colors and components.

**Step 1 — who you are** (saves the claim and schedules the abandon reminder on submit):

| Field | Type | Required | Why |
| --- | --- | --- | --- |
| Email | email | Yes | Profile key |
| First name | text | Yes | Personalization |
| What do you use tape for? | single select: Shipping/ecommerce, Warehouse/freight, Moving, Office, Events/AV, Home | Yes | Business vs. consumer segment |
| Rolls per month | single select: 1 or less, 2–5, 6–20, 21–50, 50+ | Yes | Volume tier + reorder timing |
| Company name | text | No | Business signal, B2B outreach |
| Where do you usually buy tape? | single select: Amazon, Amazon Business, Office store, Other | No | Channel insight |
| Marketing consent | checkbox + stored consent text | Yes | CAN-SPAM, offer condition |

**Step 2 — ship it:** full name, address line 1–2, city, state (US only, dropdown), ZIP. Client-side ZIP/state check; server-side normalization.

**Thank-you state:** "You're in — it ships within \~5 business days," a how-to-load-a-dispenser card, and one Amazon link ("Stock up on Ultra Thick for heavy cartons") with an Attribution tag. Gun size, photo and copy come from the active dispenser in program config, never hard-coded.

**Error states:** already claimed (friendly, no detail on which field matched), offer paused, outside US, form failure with retry.

**Anti-abuse (server-side in `tk-claim`):**

- Turnstile token required
- One claim per email; one per normalized address (address hash)
- Rate limit per IP hash: 3 submits / hour
- Monthly claim cap and kill switch read from program config
- Flag for manual review (not auto-reject): disposable email domains, 3+ claims to one ZIP+street in 30 days, mismatched state/ZIP

**Tracking:** GA4/Vercel Analytics events for `claim_view`, `step1_submit`, `step2_submit`, `claim_error`; hidden fields carry `sku`, `lot`, `src`, UTMs.

## Data model (Supabase)

New `marketing` schema, RLS on with no anon or authenticated policies; only the Edge Functions (service role) and the dashboard's server path touch it. Per your workflow, verify against live Supabase before Claude Code writes the migration.

```sql
create schema if not exists marketing;

create type marketing.claim_status as enum (
  'started',          -- step 1 done, no address yet
  'pending_review',   -- flagged by anti-abuse rules
  'approved',         -- ready to ship
  'rejected',
  'fulfillment_submitted',
  'shipped',
  'delivered',
  'cancelled'
);

create table marketing.tk_claims (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status marketing.claim_status not null default 'started',
  email citext not null,
  first_name text not null,
  company text,
  use_case text not null,
  monthly_rolls_band text not null,
  segment text not null,        -- biz_high | biz_core | light, set by tk-claim
  runout_at date,               -- est. restock date from volume band
  purchase_channel text,
  ship_name text, address1 text, address2 text,
  city text, state char(2), zip text,
  address_hash text,            -- sha256 of normalized address
  sku_code text, lot text, src text, utm jsonb,
  consent_at timestamptz not null,
  consent_text_version text not null,
  unsubscribed_at timestamptz,  -- set from Postmark webhook
  ip_hash text,
  review_flags text[] default '{}',
  reject_reason text,
  shipstation_order_id text, dispenser_sku text, carrier text, tracking_number text,
  shipped_at timestamptz, delivered_at timestamptz
);

create unique index tk_claims_email_uq on marketing.tk_claims (email);
create unique index tk_claims_address_uq on marketing.tk_claims (address_hash)
  where address_hash is not null and status <> 'rejected';

create table marketing.tk_scans (
  id bigint generated always as identity primary key,
  scanned_at timestamptz not null default now(),
  sku_code text, lot text, ip_hash text, user_agent text
);

create table marketing.tk_claim_events (
  id bigint generated always as identity primary key,
  claim_id uuid references marketing.tk_claims(id),
  at timestamptz not null default now(),
  event text not null,          -- status changes, ShipStation responses
  detail jsonb
);

-- drip definition: one row per email in each flow
create table marketing.tk_email_steps (
  step_key text primary key,    -- e.g. 'A3_biz'
  flow text not null,           -- A | B | D
  segments text[] not null,     -- which segments get it
  offset_days int,              -- days after claim (null = runout-based)
  anchor text not null default 'claim', -- claim | runout
  postmark_template_alias text not null,
  attribution_tag text not null,
  active boolean not null default true
);

-- one row per scheduled email per claimant
create table marketing.tk_email_sends (
  id bigint generated always as identity primary key,
  claim_id uuid not null references marketing.tk_claims(id),
  step_key text not null references marketing.tk_email_steps(step_key),
  scheduled_for timestamptz not null,
  status text not null default 'scheduled', -- scheduled | sent | skipped | failed | cancelled
  sent_at timestamptz,
  postmark_message_id text,
  error text,
  unique (claim_id, step_key)   -- idempotency: never double-send
);
create index tk_email_sends_due on marketing.tk_email_sends (scheduled_for)
  where status = 'scheduled';

-- raw Postmark webhook events
create table marketing.tk_email_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  postmark_message_id text,
  record_type text not null,    -- Delivery | Open | Click | Bounce | SpamComplaint | SubscriptionChange
  email citext,
  payload jsonb not null
);

create table marketing.program_config (
  key text primary key,
  value jsonb not null
);
-- seed: claims_enabled=true, monthly_cap=500, auto_approve=true, drip_enabled=true,
--       active_dispenser_sku=<3in gun SKU>, fallback_dispenser_sku=<2in gun SKU>, dispenser_floor
```

PII retention: purge address fields 180 days after delivery; keep email, segment fields and outcomes for reporting.

## Dispenser fulfillment

Dispensers ship from our own stock at the Chicago warehouse, with labels printed in ShipStation — a new store in the account that already handles Burco MFN shipments. The 3" gun (tape included) ships first to clear excess stock; once it runs out, the offer switches to the 2" gun. The active gun lives in program config, so the switch needs no reprint or redeploy, and each claim records which gun it got.

**Phase 2 (manual):** a Claims page in tools.fogobrands.com lists approved claims and lets you approve/reject flagged ones. Once a day it exports a CSV in ShipStation's order-import format (claim ID as order number, name, address, the claim's dispenser SKU). Chicago imports it, prints labels and ships; a tracking export from ShipStation is imported back, which sets `shipped` and sends the shipping email.

**Phase 4 (automated):**

1. pg\_cron runs `tk-fulfill` weekdays at 10:00 CT.
2. It takes `approved` claims under the monthly cap and creates one ShipStation order per claim in the claims store via the ShipStation API (order number `TK-<claim short id>`, $0, the claim's dispenser SKU).
3. Status → `fulfillment_submitted`; the ShipStation order ID is saved.
4. Chicago prints labels and ships from ShipStation as it does for Burco. ShipStation's ship-notify webhook calls `tk-fulfill`, which saves carrier + tracking, sets `shipped`, and sends the shipping email on Postmark's outbound stream.
5. Failures (bad address, rejected order) → `pending_review` with the reason; never retry blindly.

Finale: dispenser pulls must still draw down the Chicago location. Mirror however Burco's ShipStation shipments reach Finale today (open question).

**In the box:** a small card with "Reorder in 10 seconds" QR → Tape King Amazon storefront. No review ask.

Guard: when 3" gun stock in Finale hits its floor (set in program config), `tk-fulfill` switches the active dispenser to the 2" gun and alerts Slack. If the 2" gun also hits its floor, it pauses new approvals.

## Drip campaign (Postmark + Supabase scheduler)

The drip's one job is to move a claimant from a single roll to a case or a Subscribe & Save cadence on Amazon. It branches on the two answers we collect: use case and rolls per month.

**Segments (the segment column set by `tk-claim`):**

- **Business – high volume:** business use case and 21+ rolls/month
- **Business – core:** business use case and 2–20 rolls/month
- **Light / home:** Moving, Home, or 1 or less/month

Business use cases = Shipping/ecommerce, Warehouse/freight, Office, Events/AV.

**Flow A — Claim welcome & nurture** (enrolled when step 2 is saved; days from claim):

| # | Day | Who | Email | Main CTA (Amazon, Attribution-tagged) |
| --- | --- | --- | --- | --- |
| A1 | 0 | All | Claim confirmed: what's coming, when, how to load it | Ultra Thick for heavy cartons |
| A2 | 3 | All | Which tape for which job (Standard vs. Ultra Thick vs. Gaffers) | Compare → listing |
| A3 | 7 | Business | Case math: per-roll cost at 6 / 12 / 24 / 36 + Amazon Business quantity tiers | 36-roll case |
| A3 | 7 | Light / home | Moving-day kit: tape + dispenser + knives | 6-pack + knives |
| A4 | 12 | Business | Set it and forget it: Subscribe & Save cadence for your volume | S&S on the case |
| A5 | 18 | Business – high volume | Personal note from Kennon: Amazon Business account, quantity pricing, PO-friendly buying | Amazon Business listing |
| A6 | 25 | All | Round out the bench: utility knives, 2" dispenser, gaffers | Storefront |
| A7 | Est. run-out | Business | "About time to restock?" timed to stated volume | Reorder link |

Run-out date = claim date + days a 6-roll pack lasts at their stated band (e.g. 6–20 rolls/month ≈ 14 days); store it as runout\_at on the claim so A7 and later reminders schedule off it.

Refill links follow the claim's `dispenser_sku`: 3" gun recipients get the 3" refill listing (if it's on Amazon), 2" gun recipients get the 2" case. One template, two link sets in the `TemplateModel`.

**Flow B — Abandoned claim** (step 1 done, no address after 2 hours): one reminder, then exit.

**Flow C — Shipping (transactional):** sent by `tk-fulfill` (or the manual tracking import) on the `outbound` stream, so it still reaches people who unsubscribed from the drip.

**Flow D — Replenishment (ongoing):** for Business segments, a reorder reminder every run-out cycle until they click-through to buy or unsubscribe, max one per 30 days.

**Exit/suppression:** anyone who unsubscribes; light/home profiles move to the monthly newsletter after A6.

**Copy rules:** plain, spec-forward voice matching the site ("Thicker film, honest yardage"); no review asks; no off-Amazon prices or codes. Sender: a named person at Tape King, not "no-reply".

**How the scheduler works:**

1. When a claim completes step 2, `tk-claim` inserts one `tk_email_sends` row per active step whose `segments` include the claim's segment, with `scheduled_for` = claim time + offset (runout-anchored steps use `runout_at`). Step 1 alone enrolls only Flow B, cancelled if step 2 lands.
2. pg\_cron calls `tk-drip` every 15 minutes. It takes due rows (batch of 100), skips any claim with `unsubscribed_at` set or `drip_enabled = false`, and sends weekday sends only 8:00–17:00 CT; anything outside the window rolls to the next window.
3. Each send calls Postmark `/email/withTemplate` with `MessageStream: broadcast`, the step's `TemplateAlias`, and a `TemplateModel` (first name, segment copy blocks, Attribution-tagged Amazon URLs). The returned `MessageID` is saved; the `(claim_id, step_key)` unique key prevents double sends.
4. `tk-postmark-webhook` writes every event to `tk_email_events`. A `SubscriptionChange` (unsubscribe) or hard bounce / spam complaint sets `unsubscribed_at` and cancels that claim's remaining scheduled sends.
5. Flow D (replenishment) is rescheduled by `tk-drip` after each send: next `scheduled_for` = previous send + run-out cycle, min 30 days.

**Templates:** HTML + text versions live in the repo (e.g. `emails/tapeking/`) and sync to Postmark through its Templates API with a small deploy script. One Postmark layout carries the header, footer and physical address. Postmark adds and manages the unsubscribe link on broadcast streams; put `{{{ pm:unsubscribe }}}` in the layout footer so it sits where you want it.

## Measurement

The program is judged on attributed Amazon profit per claimant against cost per shipped dispenser. Everything below lands in one gold view, `gold.tk_claim_funnel`, refreshed nightly and shown as a tile on tools.fogobrands.com.

| Stage / metric | Source |
| --- | --- |
| Scans by SKU code, lot, week | `marketing.tk_scans` |
| Claim starts, completes, abandon rate | `marketing.tk_claims` (status) |
| Segment mix (business vs. home, volume band) | `marketing.tk_claims` |
| Approved, shipped, delivered, rejected + reasons | `marketing.tk_claims` + events |
| Cost per shipped dispenser (COGS + postage) | Finale cost + ShipStation label cost |
| Email opens / clicks by flow and segment | tk\_email\_sends + tk\_email\_events (Postmark webhooks; open and click tracking on for the broadcast stream) |
| Attributed clicks, purchases, sales per email | Amazon Attribution report, one tag per email |
| Repeat purchase rate, Tape King ASINs | Brand Analytics repeat purchase |

Attribution tag naming: `tk-drip-<flow><step>-<segment>` (e.g. `tk-drip-a3-biz`), so each email's Amazon sales roll up cleanly.

## Build phases for Claude Code

One phase per Claude Code session. Phase 1 and the QR print artwork can run in parallel; the print run is the long pole.

**Phase 0 — Decisions and sign-off (no code)**

- [ ] Confirm the flow with Seller Support / account manager; save the case ID
- [ ] Set the cost cap per claim (3" and 2" gun, postage included), the dispenser floor, and create the ShipStation claims store
- [ ] Set the monthly claim cap (500 in the seed is a placeholder)
- [ ] Confirm the Postmark setup for Tape King: verified sender domain (DKIM, custom Return-Path), a broadcast stream for the drip next to the outbound stream, and webhooks pointed at tk-postmark-webhook
- [ ] Final QR codes + fallback URL sent to the printer

**Phase 1 — Capture (site + Supabase)**

- [ ] Migration for the `marketing` schema, verified against live Supabase
- [ ] `/r/:code` redirects + `tk-scan` logging + QR generator script (vector SVG/PDF per code)
- [ ] `/claim` two-step page, offer terms, thank-you, error and offer-ended states
- [ ] `tk-claim` Edge Function: Turnstile, dedupe, rate limit, cap, flags, segment, drip enrollment
- [ ] Accept: a test QR scan on a real phone creates a scan row, a claim row with its segment, and scheduled tk\_email\_sends rows; a second claim with the same email or address is blocked

**Phase 2 — Claims queue + manual shipping**

- [ ] Claims page in tools.fogobrands.com: filter by status, approve/reject flagged, CSV export, tracking import
- [ ] Accept: a claim goes started → approved → shipped from the UI, and the tracking email arrives from Postmark's outbound stream

**Phase 3 — Drip flows**

- [ ] Seed tk\_email\_steps for flows A, B and D; build tk-drip (pg\_cron every 15 min) and tk-postmark-webhook; templates in the repo, synced to Postmark
- [ ] Attribution tags created per email
- [ ] Accept: seeded test profiles in each segment receive the right emails on a compressed schedule; every link resolves to Amazon with its tag; unsubscribing from a test email cancels that claim's remaining sends

**Phase 4 — ShipStation automation**

- [ ] `tk-fulfill` + pg\_cron, tracking poll, ShipStation order push + ship-notify webhook, 3" → 2" auto-switch, inventory floor guard, Slack alert
- [ ] Accept: 5 live test claims auto-submit, ship and update status without manual steps

**Phase 5 — Reporting**

- [ ] `gold.tk_claim_funnel` + dashboard tile
- [ ] Accept: funnel counts match raw tables; cost per dispenser and attributed sales show per week

## Decisions (Oct 22, 2026)

| Question | Decision | Where it changed the scope |
| --- | --- | --- |
| Eligibility | Open to all buyers; segment by use case and volume | No gating; segments drive the drip |
| Dispenser | 3" gun with tape while excess 3" stock lasts, then the 2" gun (set in program config) | Landing page headline, A6 cross-sell, cost cap in Phase 0 |
| Shipping | Own stock from the Chicago warehouse; labels in a new ShipStation store in the account used for Burco MFN | Fulfillment, data model, measurement, Phases 2 and 4, diagram |
| Amazon order ID | Not in v1; ask later if fraud spikes | Compliance rules |
| A5 personal email | Signed by Kennon | Drip table |

## Open questions

- **3" refills:** the 3" guns need 3" tape, but tapeking.com only lists 2" rolls. Is 3" tape live on Amazon? If not, refill links for 3" recipients fall back to the 2" case, and the switch to 2" guns fixes it going forward.
- **ShipStation → Finale:** how do Burco MFN shipments draw down Finale today? Claims should follow the same path.
- **Fraud trigger:** what counts as a spike that brings back the order-ID ask (e.g. share of flagged claims in a week)?

## Sources

Postmark: [broadcast unsubscribe links](https://postmarkapp.com/support/article/1208-how-to-add-an-unsubscribe-link) · [managed unsubscribes](https://postmarkapp.com/support/article/managing-your-own-unsubscribe-process) · [message streams](https://postmarkapp.com/blog/postmark-message-streams-how-it-started-how-its-going)

Amazon insert guidance (third-party summaries; confirm with Amazon): [SupplyKick](https://www.supplykick.com/blog/amazon-product-inserts-guide) · [eStore Factory](https://www.estorefactory.com/blog/amazon-insert-card-guide-2024-design-examples-rules-more/) · [Brij](https://brij.it/blog/amazon-packaging-inserts-are-allowed-heres-what-your-team-needs-to-know) · [Prosper Show](https://prospershow.com/news/how-to-build-an-email-list-as-an-amazon-seller-without-getting-banned/987509099/) · Current site: [tapeking.com](https://www.tapeking.com/)
