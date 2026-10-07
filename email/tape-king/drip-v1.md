# Tape King — Email Drip v1 (first order → reorder loop)

Status: DRAFT for review · 2026-10-07 · brand: `tape-king` · site: www.tapeking.com · sender: **Postmark** (see §9)

Tape is a consumable. The homepage promise is "The tape you buy once, then buy every
time." This drip is built to sell **the reorder**, not to educate. It has two flows:

- **Flow A, First Case** (5 emails / 12 days): a new subscriber goes from "which tape?" to an
  Amazon click, and tells us how fast they go through tape.
- **Flow B, Reorder Loop** (3 emails per cycle, repeating): a reminder timed to *their*
  cadence. It escalates from "same order again" to "buy the case" to "Subscribe & Save", plus
  one cross-sell after the second reorder.

---

## 0. Prerequisites (none of this exists yet)

| # | Item | Why | Owner |
|---|------|-----|-------|
| P1 | **Email capture on tapeking.com.** No signup form exists today; the site is static, and Postmark has no hosted forms or lists. A plain `<form>` posts to a Vercel function (`/api/subscribe`) that stores the subscriber in Supabase and sends a confirm (double opt-in) email via Postmark. Placements: PDP "Get a reorder reminder" box under the CTA, the homepage "Built for the reorder" band, and the footer. | Without it, there is no audience. | dev |
| P2 | **Only site opt-ins enter this drip.** Never import Amazon buyer emails or use Buyer-Seller Messaging for marketing; Amazon policy prohibits it. On the Amazon side, use Brand Tailored Promotions and the "Follow" brand emails. | Account health | ops |
| P3 | **`email` attribution channel.** `npm run attribution-tags` supports `brand_site`, `brand_site_blog` and `google_ads` only, so it needs an `email` channel. Mapping: campaign `fbs-tape-king-email`, ad group = email id (`a1`…`b3`, `x1`), creative = ASIN. Every CTA links straight to the Amazon tag, so Amazon Attribution reports purchases per email. Until the channel exists, link to the tapeking.com line page with `utm_source=email&utm_medium=drip&utm_campaign=fbs-tape-king-email&utm_content=<email id>`. | Revenue per email, plus the ~10% Brand Referral Bonus | dev |
| P4 | **Subscriber profile fields:** `cadence_days` (self-reported), `last_amazon_click_at`, `last_asin`, `last_line`, `reorder_clicks` (count). These are columns on `bronze.email_subscribers` (§9). Postmark's Click webhook updates the click fields. | Drives Flow B timing and dynamic product | dev |
| P5 | **Merge data:** product names, pack ladders and per-roll prices come from `public.brand_site_products` + `catalog.yaml` (the same source as the site). Fill `{{per_roll.*}}` tokens with a pre-send sync. If no sync exists, use the no-number fallback lines marked ⟂. Never hard-code prices; they change. | Accuracy | dev |
| P6 | CAN-SPAM footer in the Postmark layout: physical mailing address, Postmark's `{{{ pm:unsubscribe }}}` link (Broadcast stream only), "Manage reminders" link (changes cadence). | Compliance | dev |

**Claims guardrails** (all taken from `catalog.yaml` / the live site):
- OK to use: 2.7 mil Standard, 3.2 mil Ultra Thick, 60-yd rolls, XL 110-yd rolls, 3" wide, ~40 lb single-pass seal (Standard), 11 mil duct, cloth gaffers with residue-free removal, 12-pack utility knives, and the review rating/count via token from the live Keepa aggregate.
- Do NOT use: "since 2016" (unconfirmed, scope §7), any competitor mil figure (say "typical store tape"), or any dispenser-gun width (line is `pdp: false`, widths unconfirmed). Dispenser CTAs go to the v1 ASIN page.

**Tokens:** `{{first_name|default:"there"}}`, `{{review_rating}}`, `{{review_count}}`,
`{{last_line_name}}`, `{{last_asin_name}}`, `{{cadence_label}}` ("every 2 weeks" / "monthly" /
"every few months"), `{{amz:<email-id>:<ASIN>}}` (the email attribution URL for that ASIN).

> **Token notation is shorthand.** Postmark templates use Mustachio, which has no filters,
> defaults or nested lookups. The send script (§9) resolves every token into a flat
> `TemplateModel` field before sending. For example, `{{first_name|default:"there"}}` becomes
> `{{greeting_name}}`, `{{amz:b1:{{last_asin}}}}` becomes `{{cta_url}}`, and the A3 price table
> becomes `{{#each ladder}}…{{/each}}` with `{{#if has_prices}}` around the ⟂ fallback.

---

## 1. Sequence overview

| # | Subject (lead option) | Purpose | Timing | Primary CTA | Condition |
|---|---|---|---|---|---|
| A1 | Your tape, sorted in 4 lines | Welcome, pick the right line, capture cadence | Day 0 (on signup) | Shop Standard Clear → Amazon | All new subscribers |
| A2 | Why boxes pop open in transit | Spec-led case for thicker film | Day 2 | Get the 12-pack → Amazon | No Amazon click yet |
| A3 | The case pays for itself | Pack-size math, move up the ladder | Day 5 | Buy the 36-roll case → Amazon | No Amazon click yet |
| A4 | Moving, events, or the shop? | Shop by job, the other lines | Day 8 | Line picked by job | No Amazon click yet |
| A5 | Set it once. Never run out. | Subscribe & Save close | Day 12 | Subscribe & Save → Amazon | No Amazon click yet |
| B1 | Running low on {{last_line_name}}? | Same-SKU reorder reminder | 80% of `cadence_days` after last click | Reorder → Amazon | Flow B entry |
| B2 | You reorder {{cadence_label}}. The case covers months of it. | Upsize to a case + S&S | B1 + 4 days | Case pack → Amazon | No click on B1 |
| B3 | Still taping? | Re-check cadence, soft last ask | B2 + 7 days | Update my reminder | No click on B1/B2 |
| X1 | The two tools on every packing bench | One-time cross-sell (gun + knives) | 2 days after 2nd reorder click | Utility Knife 12-pack → Amazon | `reorder_clicks` = 2, packing-tape line |

**Conversion definition:** we can't see Amazon orders per subscriber, so an **Amazon CTA
click** counts as the per-person conversion (it exits Flow A and resets the Flow B clock).
**Revenue truth** is Amazon Attribution purchases/sales on `fbs-tape-king-email`, by ad
group (= email).

---

## 2. Flow A: First Case

### A1 · Welcome + which tape (Day 0)

**Subject options**
1. Your tape, sorted in 4 lines
2. Welcome to Tape King. Here's the short version.
3. {{first_name}}, which tape do you actually need?

**Preview:** Plus one question so we never email you at the wrong time.

**Purpose:** Get the subscriber to the right line in one read, and capture `cadence_days`.

**Body**

> Hi {{first_name|default:"there"}},
>
> Thanks for signing up. You're here because you go through tape, so here's the whole
> lineup in four lines:
>
> **STANDARD CLEAR:** 2.7 mil, 60 yd. Daily shipping, storage, office. Seals up to ~40 lb cartons in one pass.
> **ULTRA THICK:** 3.2 mil. Heavy boxes, long transit, freight. Resists splitting on edges and corners.
> **GAFFERS:** Cloth matte. Cables, staging, floors. Removes clean, no residue.
> **DUCT:** 11 mil. Repairs, bundling, rough surfaces. Tears by hand.
>
> Most people start with Standard Clear. It's rated {{review_rating}} stars across {{review_count}} reviews.
>
> **[ Shop Standard Clear on Amazon → ]**
>
> **One question: how fast do you go through tape?** Click one and we'll time your reorder reminder to match.
> [ Every 2 weeks ] · [ About monthly ] · [ Every few months ]
>
> Tape King

**CTA:** `Shop Standard Clear on Amazon` → `{{amz:a1:B01KGTT7GC}}` (12-pack, the line's default format)
**Cadence links** set `cadence_days` = 14 / 30 / 90 (default 30 if no click). These are preference clicks, not conversions.
**Segment notes:** If the signup came from a specific PDP, swap the hero CTA to that line (`signup_line`) and keep the 4-line block.

---

### A2 · The spec that matters (Day 2)

**Subject options**
1. Why boxes pop open in transit
2. The number that saves a re-tape
3. Your packing tape is thinner than you think

**Preview:** Film thickness is the number nobody puts on the front of the box.

**Purpose:** Make thickness and yardage the buying criteria, which favors us.

**Body**

> Seams don't usually fail at the tape gun. They fail on a truck: a corner catches, the film
> splits, and the flap lifts.
>
> Two numbers decide whether that happens:
>
> **Film thickness.** Standard Clear runs 2.7 mil and Ultra Thick 3.2 mil, both thicker than typical store tape. Thicker film means fewer passes per seam and fewer split cartons.
> **Yardage.** Full 60-yard rolls. No shrinking roll lengths at the same price point.
>
> If your boxes are heavy or travel far, go straight to Ultra Thick. For everything else,
> Standard Clear does the job in one pass.
>
> **[ Get the Standard Clear 12-pack → ]**
> Shipping heavy? [ Ultra Thick 6-pack → ]

**CTA:** `{{amz:a2:B01KGTT7GC}}` · secondary `{{amz:a2:B072LGT8CX}}`
**Segment notes:** Skip if clicked any Amazon CTA (→ Flow B). If A1 was opened but not clicked, send A2 at Day 1 instead of Day 2.

---

### A3 · Case math (Day 5)

**Subject options**
1. The case pays for itself
2. Buy the case, skip two reorders
3. Per roll, the 36-pack wins. Here's by how much.

**Preview:** Same roll, same film. The only thing that changes is the per-roll price.

**Purpose:** Anchor on per-roll cost and move the first order up the pack ladder.

**Body**

> Every Standard Clear roll is the same 2.7 mil, 60-yard roll. What changes is how many you
> buy at once and what each one costs:
>
> | Pack | Per roll |
> |---|---|
> | 6 rolls | {{per_roll.B01K0Z9QYK}} |
> | 12 rolls | {{per_roll.B01KGTT7GC}} |
> | 36 rolls | {{per_roll.B01K86O8MQ}} |
>
> ⟂ *Fallback without prices:* "The per-roll price drops as the pack grows. The 36-roll case is the lowest per roll in the line."
>
> If you seal more than a few boxes a week, the case is the cheaper way to buy, and it's
> two fewer reorders to remember.
>
> **[ Buy the 36-roll case → ]**
> Going through it fast? The XL rolls are 110 yards each, so you change rolls less often. [ See XL → ]

**CTA:** `{{amz:a3:B01K86O8MQ}}` · secondary `{{amz:a3:B06XPQL8D5}}`
**Segment notes:** If `cadence_days` = 90 (light user), lead with the 12-pack and drop the XL line. If the per-roll sync shows the ladder isn't monotonic (as Ultra Thick 12-pack is today, scope §5.1), never put that line in this table.

---

### A4 · Shop by job (Day 8)

**Subject options**
1. Moving, events, or the shop?
2. Not every job is a packing-tape job
3. The right tape for the job you've got this week

**Preview:** Four jobs, four tapes. Pick yours and you're done.

**Purpose:** Catch subscribers whose job isn't shipping, and widen the basket.

**Body**

> Not everyone who signs up ships boxes for a living. Pick your job:
>
> **Shipping & ecommerce:** high-volume sealing, day in and day out. → [ Standard Clear ]
> **Moving & storage:** one weekend, zero re-taped boxes. → [ Ultra Thick ]
> **Events & AV:** cables down, floors clean afterward. → [ Gaffers ]
> **Repairs & the garage:** tears by hand, sticks to rough surfaces. → [ Duct Tape ]
>
> Each link goes straight to the listing on Amazon.

**CTA:** four job links → `{{amz:a4:B01KGTT7GC}}`, `{{amz:a4:B072LGT8CX}}`, `{{amz:a4:B01N48VBS7}}`, duct `{{amz:a4:<live duct ASIN>}}`
**Segment notes:** Duct ASIN B078X3F29Q is currently hidden upstream (`hide_from_site`). Use the live duct SKU from `brand_site_products`, or drop the duct row until the override lifts. The clicked job sets `last_line`.

---

### A5 · Subscribe & Save close (Day 12)

**Subject options**
1. Set it once. Never run out.
2. Last one from us for a while: make tape automatic
3. Tape on autopilot (and cheaper)

**Preview:** Subscribe & Save stacks on top of case pricing.

**Purpose:** The last first-order ask, framed as never running out.

**Body**

> Running out of tape mid-shipment is the worst way to remember to reorder.
>
> Amazon's **Subscribe & Save** stacks on top of our case pricing. Pick the pack, pick how
> often, and it arrives before the last roll runs out. You can skip or cancel anytime on Amazon.
>
> **[ Subscribe & Save on Standard Clear → ]**
>
> Prefer to order yourself? We'll send one reminder {{cadence_label}}. [ Change timing ]
>
> *(Optional, if a promo is approved) Use code **{{promo_code}}** on Amazon for {{promo_terms}}. Ends {{promo_end}}.*

**CTA:** `{{amz:a5:<S&S-eligible ASIN>}}`. Confirm which Standard Clear ASINs are S&S-eligible before launch.
**Segment notes:** After A5, a subscriber with no clicks moves to Flow B at Day 0 + `cadence_days` anyway (not every subscriber clicks before buying), then goes into the sunset rules.

---

## 3. Flow B: Reorder Loop

**Entry:** any Amazon CTA click (A-flow or B-flow), or the end of Flow A.
**Clock:** `last_amazon_click_at` + 0.8 × `cadence_days`. Default `cadence_days` = 30.
Any new Amazon click restarts the cycle from B1.

### B1 · Same order again (80% of cadence)

**Subject options**
1. Running low on {{last_line_name}}?
2. Reorder day, {{first_name}}
3. Before the last roll runs out

**Preview:** Same tape, same pack. One click and it's handled.

**Purpose:** Frictionless same-SKU reorder.

**Body**

> Hi {{first_name|default:"there"}},
>
> By our math you're about due. Your last pick was **{{last_asin_name}}**.
>
> **[ Reorder {{last_asin_name}} → ]**
>
> Ordering more than last time? [ See the bigger packs → ]
>
> (Wrong timing? [ Remind me sooner ] · [ Remind me later ])

**CTA:** `{{amz:b1:{{last_asin}}}}` · secondary → tapeking.com line page `/products/{{last_line}}/`
**Segment notes:** If `last_asin` is unknown (Flow A finished with no clicks), use Standard Clear 12-pack. "Sooner/later" links multiply `cadence_days` by 0.66 / 1.5.

---

### B2 · Upsize (B1 + 4 days, no click)

**Subject options**
1. You reorder {{cadence_label}}. The case covers months of it.
2. Fewer reorders, lower per-roll
3. Stop buying tape this often

**Preview:** Same rolls. Bigger pack, lower price per roll, fewer reminders from us.

**Purpose:** Move repeat buyers to the case and/or S&S, which is the highest-LTV ask.

**Body**

> If you're buying {{last_line_name}} {{cadence_label}}, there are two ways to do it less often:
>
> **1. Buy the case.** {{case_pack_count}} rolls at {{per_roll.case}} per roll, vs {{per_roll.last}} on your usual pack.
> ⟂ *Fallback:* "The case is the lowest per-roll price in the line."
> **2. Subscribe & Save.** Set the cadence once on Amazon. It stacks with case pricing.
>
> **[ Get the {{case_pack_count}}-roll case → ]**
> [ Or set up Subscribe & Save → ]

**CTA:** case ASIN for `last_line` (Standard → B01K86O8MQ, Ultra Thick → B01LR0L4T2, Standard XL → B06XPQL8D5, Standard 3" → B074TYN7MD)
**Segment notes:** Skip B2 if `last_asin` is already the case size; send a S&S-only version instead. Gaffers/duct have no case ladder, so send S&S-only or skip.

---

### B3 · Check-in (B2 + 7 days, no click)

**Subject options**
1. Still taping?
2. Did we get your timing wrong?
3. Quick one: should we keep reminding you?

**Preview:** Change your reminder, or tell us to back off. Either is fine.

**Purpose:** Fix bad cadence data before it costs unsubscribes, and make one soft final ask.

**Body**

> We sent a reorder reminder last week and didn't hear back. That usually means our timing's off.
>
> How often should we check in?
> [ Every 2 weeks ] · [ Monthly ] · [ Every few months ] · [ Pause reminders ]
>
> And if you are running low: **[ Reorder {{last_asin_name}} → ]**

**CTA:** cadence links (preference, not conversion) · `{{amz:b3:{{last_asin}}}}`
**Segment notes:** After B3, the next cycle starts at `cadence_days` from B3's send date. "Pause" sets `reminders_paused = true` and keeps the subscriber on the list for promos only.

---

### X1 · One-time cross-sell (2 days after the 2nd reorder click)

**Subject options**
1. The two tools on every packing bench
2. You've got the tape. Got the gun?
3. Faster seals, cleaner cuts

**Preview:** A dispenser gun and a 12-pack of utility knives for the packing bench.

**Purpose:** Add the non-consumables once, after the buyer has shown repeat intent.

**Body**

> You've reordered twice, so you're packing regularly. Two things make that faster:
>
> **Dispenser gun:** load once, seal all day.
> **Utility Knife 12-pack:** retractable 18 mm blades, one for every bench, drawer, and station.
>
> **[ Get the Utility Knife 12-pack → ]** · [ See dispenser guns → ]

**CTA:** `{{amz:x1:B0751PNK7W}}` · dispenser → tapeking.com `/products/B077GCV6PH/` (v1 page; don't state widths)
**Segment notes:** Packing-tape lines only (`last_line` in standard-clear / ultra-thick). Send once per subscriber.

---

## 4. Flow diagram

```
[Signup on tapeking.com] ──> A1 (Day 0) ── cadence click → set cadence_days
        │
   Amazon click anywhere? ──Yes──────────────────────────────┐
        │ No                                                 │
        ▼                                                    │
   A2 (Day 2; Day 1 if A1 opened, no click)                  │
        ▼                                                    │
   A3 (Day 5) ──> A4 (Day 8) ──> A5 (Day 12)                 │
        │                          │                         │
        └──── any Amazon click ────┴──> [EXIT A] ────────────┤
                                   │ no click                │
                                   ▼                         ▼
                     wait cadence_days            set last_click / last_asin
                                   │                         │
                                   └─────────┬───────────────┘
                                             ▼
                   B1 (0.8 × cadence after last click)
                       │ click → restart cycle  (reorder_clicks == 2 → X1 in 2 days)
                       ▼ no click (4d)
                   B2 Upsize / S&S
                       │ click → restart cycle
                       ▼ no click (7d)
                   B3 Check-in ── "Pause" → promos only
                       │ click → restart cycle
                       ▼ no click
                   next cycle at cadence_days
                       │
          2 full cycles with zero opens → [SUNSET]
```

## 5. Branching, exit and suppression rules

- **Exit Flow A:** any Amazon CTA click. Cadence clicks are preferences, not exits.
- **Restart Flow B:** any Amazon CTA click from any email.
- **Sunset:** two consecutive B cycles with zero opens → one "Should we stop?" email → suppress from the drip after 14 days with no response. Keep on the newsletter list only if they opted in to it.
- **Suppress** if unsubscribed, paused, or bounced. Replies go to `contact_email`, which the script can't see; support pauses a subscriber manually (`status = paused`) when a reply needs it.
- **Only one flow at a time:** Flow B never sends while Flow A is active.
- **Frequency cap:** max 2 drip emails per 7 days, and 3 total per 7 days including promos.
- **Re-entry:** a re-signup or resubscribe re-enters Flow A only if they've had no Amazon click in 180 days. Otherwise it goes straight to B1.

## 6. Benchmarks (consumer replenishment, DTC-style ESP; opens inflated by Apple MPP)

| Metric | Flow A (welcome) | Flow B (replenishment) |
|---|---|---|
| Open rate | 45–60% | 40–55% |
| Click rate (to Amazon) | 6–12% | 8–15% |
| Click → Amazon purchase (Attribution) | 10–20% | 20–35% (repeat buyers) |
| Unsubscribe | < 0.8% / email | < 0.5% / email |

Judge clicks and Attribution sales, not opens.

## 7. A/B tests (in priority order)

Postmark has no built-in A/B testing, so the send script assigns the arm (a stable hash of the subscriber id), picks the template alias (`tk-b1` / `tk-b1-v2`), and sets the Postmark `Tag` to the arm. Per-tag stats then show in Postmark.

1. **B1 subject: dynamic product vs generic.** "Running low on Standard Clear?" vs "Reorder day, {{first_name}}". 50/50 split, winner on Amazon click rate. Needs ~1,000 sends per arm before calling it.
2. **A3 with prices vs without** (token table vs ⟂ fallback). Winner on Attribution purchases per send for ad group `a3` vs `a3b`. Give it its own ad-group id so Amazon splits the revenue.
3. **Signup offer: reminder only vs reminder + promo code.** Split the signup form itself. Winner on 30-day revenue per subscriber (Attribution sales ÷ subscribers), not signup rate.

## 8. Metrics and review cadence

- **Primary:** Amazon Attribution sales and Brand Referral Bonus on `fbs-tape-king-email`, per ad group (email). Pull with `npm run attribution-report` once the email tags exist.
- **Per email:** open, click to Amazon, unsubscribe, spam complaints.
- **Flow level:** % of Flow A subscribers with ≥1 Amazon click by Day 14; Flow B reorder-click rate per cycle; median days between reorder clicks vs self-reported cadence (recalibrate the 0.8 multiplier); case-pack share of clicks (B2's job).
- **Review:** weekly for the first 6 weeks, then monthly. Re-check the per-roll sync after any Amazon reprice.

## 9. Postmark build

Postmark sends; it does not schedule, branch or hold lists. Everything Klaviyo-style flows would
do lives in our code, and Postmark is only the delivery step. All the pieces are generic per
brand: every brand's Vercel project gets the same `/api/*` functions, keyed by `BRAND_SLUG`.

```
tapeking.com form ──POST──> /api/subscribe (Vercel fn) ──> bronze.email_subscribers (pending)
                                     └── Postmark *transactional* stream: "Confirm your reminders"
confirm link ──> /api/confirm ──> status = active, flow = A, next_send_at = now

daily cron ──> scripts/email-drip.mjs
                 reads due subscribers + catalog/prices ──> builds TemplateModel
                 ──> Postmark /email/batchWithTemplates (Broadcast stream "tk-drip")
                 ──> bronze.email_sends (log) + advance step / next_send_at

Postmark webhooks ──> /api/postmark-webhook
                 Click        → if Amazon link: last_amazon_click_at, last_asin, reorder_clicks++,
                                restart Flow B; if a cadence/pause link: handled by /api/pref
                 Bounce / SpamComplaint / SubscriptionChange → status = suppressed
cadence + pause links ──> /api/pref?t=<signed token>&cadence=30 → updates subscriber, shows a
                 "Got it" page
```

**Postmark setup**
1. One Postmark **server** per brand ("Tape King"). In it, a **Transactional** stream (confirm emails only) and a **Broadcast** stream `tk-drip` (every drip email). Postmark requires marketing mail to go on a Broadcast stream.
2. Verify the sender domain `tapeking.com` (DKIM + Return-Path CNAME in Squarespace DNS). Send from something like `reminders@tapeking.com`, with reply-to set to `brand_sites.contact_email`.
3. One **layout** (logo, brand colors, footer with address + `{{{ pm:unsubscribe }}}` + Manage reminders). Nine **templates** with aliases `tk-a1`…`tk-a5`, `tk-b1`…`tk-b3`, `tk-x1`, plus `tk-confirm`. Keep the template sources in this repo (`email/tape-king/templates/*.html` + `.txt`) and push them with a script, so copy edits are reviewed like code.
4. Turn on link tracking (HTML and text) for the Broadcast stream. Postmark's redirect doesn't change the final Amazon URL, so the Attribution tag and Brand Referral Bonus survive. Open tracking is optional (inflated by Apple MPP).
5. Webhooks on `tk-drip`: Click, Bounce, SpamComplaint and SubscriptionChange → `https://www.tapeking.com/api/postmark-webhook`, protected with HTTP basic auth.
6. Postmark reviews new Broadcast senders, and keeping the account needs a low complaint rate. Double opt-in (the confirm step) is what keeps us inside that.

**Supabase** (new bronze tables; RLS = service_role ALL only, no anon read, because these hold PII)
- `bronze.email_subscribers`: id, brand_slug, email (unique per brand), first_name, status (pending | active | paused | suppressed), flow (A | B), step, next_send_at, cadence_days (default 30), signup_line, signup_page, last_amazon_click_at, last_asin, last_line, reorder_clicks, confirmed_at, created_at.
- `bronze.email_sends`: subscriber_id, email_id (`a1`…), variant, postmark_message_id, sent_at. The frequency cap and "clicked previous email" checks read this table.
- Postmark's own suppression list is the source of truth for unsubscribes. The webhook mirrors it into `status` so the script never even tries to send.

**Scheduler.** `scripts/email-drip.mjs --brand=tape-king [--dry-run]` runs once a day, in the
morning US time. Options, in order of preference: a GitHub Actions scheduled workflow (secrets:
`SUPABASE_SERVICE_ROLE_KEY`, `POSTMARK_SERVER_TOKEN`), or a Vercel Cron hitting a protected
`/api/drip-run`. `--dry-run` prints who would get what and with which model, and sends nothing.
Use local-date helpers only; `toISOString().slice(0,10)` is banned (CLAUDE.md).

**New env vars:** `POSTMARK_SERVER_TOKEN` (per brand server), `EMAIL_LINK_SECRET` (signs
pref/confirm tokens), `POSTMARK_WEBHOOK_USER`/`POSTMARK_WEBHOOK_PASS`. These go in the brand's
Vercel project and in the cron's secrets, never in `public.*` views.

**Vercel note:** the site is `output: 'static'`. Root-level `api/*.js` functions deploy alongside
it on Vercel without an Astro adapter, but confirm on a preview deploy before relying on it.
The fallback is `@astrojs/vercel` with only these routes server-rendered.

## 10. Launch checklist

1. Supabase tables + RLS (above).
2. Postmark server, streams, domain DNS, layout and templates (above).
3. `/api/subscribe`, `/api/confirm`, `/api/pref` and `/api/postmark-webhook`; then the signup box on PDPs, the homepage reorder band and the footer (hidden `signup_line`/`signup_page` fields).
4. Create the `email` attribution tags (P3), or start with UTM'd site links.
5. `scripts/email-drip.mjs` with `--dry-run`. Seed-test every dynamic case (no ASIN, gaffers, already on the case pack, no cadence set, prices missing) to an internal address.
6. Turn on the daily cron. Watch Postmark bounce/complaint rates and the `email_sends` log daily for the first two weeks.
