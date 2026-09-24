# EMAIL_CAPTURE_SCOPE_v1.md
**Otis Classic (otisclassic.com): email capture and signup drip campaign**
Scope for a Claude Code implementation. Version 1.1, 2026-09-23 (decisions recorded, copy drafted).
Pilot brand: `otis-classic`. It is built to be portfolio-generic, so turning it on for another brand means
adding content, not code.

This builds out the P1 line in `BRAND_SITES_SCOPE_v1.md` §5.2 ("Email capture form (Postmark or simple
provider): customer-ownership beachhead without commerce") and the open question in
`XTREME_SITE_V2_SCOPE.md` §7.4 ("likely a Supabase table + … sends later").

### Decision log
| # | Decision | Date |
|---|---|---|
| D1 | **Postmark** for sending. The list lives in Supabase, and Postmark manages unsubscribes (§4.1) | 2026-09-23 |
| D2 | Signup incentive: **free printable guide**, one per track (§4.3). Drafts are in the repo | 2026-09-23 |
| D3 | **One shared mailing address and legal sender line for every brand**, with an optional per-brand override (§4.5). Set: Fogo Brands LLC, 1590 East Joyce Boulevard, Unit 10471, Fayetteville, AR 72703 | 2026-09-23 |
| D4 | **Vercel Pro** (§4.6) | 2026-09-23 |
| D5 | Claude drafts all emails and PDFs for owner edit. Drafts are in `src/content/brands/otis-classic/{emails,downloads}/` | 2026-09-23 |
| D6 | Setup progress: Postmark domain `otisclassic.com` verified (DKIM `20260924170510pm._domainkey` + Return-Path `pm-bounces`). Google Workspace (secondary domain on fogobrands.com) handles replies to `hello@otisclassic.com`: MX `smtp.google.com`, SPF `include:_spf.google.com ~all`, Google DKIM, DMARC `p=none`. Pending: Postmark account approval, broadcast stream check | 2026-09-24 |

---

## 1. Context & objective

The brand sites send every buyer to Amazon, so Amazon owns the customer. We never see a name, an email, or an
order. An email list is the only customer relationship these sites can own. Everyone on it opted in on our own
domain, and we can reach them again at no cost for every new post, product, or seasonal push.

**Why Otis is a good pilot:**
- It has two usage-heavy product lines with a learning curve. The whipped cream dispensers (B01DZ2HZ2U,
  B06WVD2K6N) raise "how do I…" and "why is it runny" questions. The swing-top bottles (B0H89XLBKG family: clear or
  amber, plastic or ceramic caps) are bought by kombucha and second-fermentation hobbyists. Instructional drip
  content is useful to these buyers, not just promotion.
- Traffic is already arriving and is intent-rich: three live blog posts, Google Ads campaigns landing on those
  posts, and GA4 already on the brand row.
- The drip reuses the blog's content engine. Every email points at an existing post or PDP.

**Objective:** capture emails on otisclassic.com with double opt-in, then run each subscriber through a short,
interest-matched welcome sequence. The sequence's job matches the site's job: build confidence, then send the
click to Amazon through an Attribution tag (new `email` channel). That way the list's Brand Referral Bonus (BRB)
revenue is measured, not guessed.

**Strategic side benefit:** an `email_signup` GA4 event gives the Google Ads campaigns a second, higher-intent
conversion to import. It is a better Maximize Conversions signal than `amazon_click` alone.

---

## 2. Goals & metrics

| Goal | Metric | Target (first 60 days) | Source |
|---|---|---|---|
| Capture | Signups ÷ sessions (all placements) | 1.0–2.5% (blog higher, PDP lower) | GA4 `email_signup` / sessions |
| List quality | Confirm rate (double opt-in) | ≥ 60% | `bronze.email_subscribers` |
| Engagement | Drip click rate per email | ≥ 4% (median across the sequence) | Postmark click events |
| Deliverability | Bounce / spam-complaint rate | < 2% / < 0.1% (Gmail's hard ceiling is 0.3%) | Postmark webhooks |
| Revenue | Email-channel Attribution clicks → purchases → BRB | Trend; first read at day 30 | `attribution-report` (channel `email`) |
| Blended | Otis TACoS | Flat-to-down (per measurement philosophy) | Dashboard |

Open rates are reported but are not a goal, because Apple Mail Privacy Protection inflates them.

---

## 3. Non-goals (v1)

1. No on-site accounts or preference center. Unsubscribe is Postmark's hosted one-click flow.
2. No purchase-triggered flows. We have no order data, and **Amazon buyer data (Buyer-Seller Messaging, order
   reports) must never be imported into this list**, because that violates Amazon's policy.
3. No review solicitation of any kind in emails. Incentivized or conditional review requests violate Amazon's
   policy, and the gate (§7.4) blocks review asks.
4. No SMS.
5. No exit-intent modal in v1 (P2). It hurts Core Web Vitals and annoys paid landings.
6. No new Supabase Edge Functions. Per `CLAUDE.md`, those belong to the dashboard repo. Everything runs as Vercel
   Functions from this repo.

---

## 4. Decisions

### 4.1 Sending: **Postmark (DECIDED)**, list of record in Supabase
- **Two message streams per brand server.** `outbound` (transactional) carries only the double-opt-in confirm
  email. `broadcast` carries every drip email and all later marketing. A drip complaint never delays a confirm.
- **Unsubscribe is Postmark-managed on the broadcast stream.** Postmark requires an unsubscribe link on every
  broadcast message. It inserts it at our `{{{ pm:unsubscribe }}}` placeholder (or appends one if the placeholder
  is missing). It adds RFC 8058 one-click `List-Unsubscribe` / `List-Unsubscribe-Post` headers and suppresses the
  address on that stream automatically. So even a bug in our scheduler **cannot** mail someone who opted out,
  because Postmark refuses the send. We build **no unsubscribe endpoint**. We only mirror the change into our table
  through the `SubscriptionChange` webhook, so the scheduler stops queuing them and the dashboard counts are right.
- **Postmark's permission policy matches ours:** explicit opt-in only, no purchased or imported lists, and no
  "agreed to the ToS" contacts.
- One Postmark account, one **server per brand**, and one verified sending domain per brand
  (`otisclassic.com`). Keeping this per brand means one brand's reputation can't hurt another's.
- Klaviyo was considered and rejected. It allows one sending domain per account, so that's 27 paid accounts,
  and its value is purchase-event segmentation, which we can't use.

### 4.2 Double opt-in: **yes**
A brand-new sending domain with single opt-in and bot signups is the fastest way into the spam folder. The confirm
step also gives us a consent record: timestamp, IP hash, source page, and the exact consent text shown.
**No broadcast email is ever sent to a subscriber whose `confirmed_at` is null.** This is enforced in the scheduler
query and covered by an acceptance test (§8).

### 4.3 Incentive: **free printable guide (DECIDED)**
One PDF per track, each one US Letter page in the brand palette:
- `src/content/brands/otis-classic/downloads/whipped-cream-dispenser-cheat-sheet.html` →
  `/downloads/otis-classic-whipped-cream-dispenser-cheat-sheet.pdf`. Covers the routine, the three rules, recipe
  ratios, fixes, clean and store, and safety.
- `src/content/brands/otis-classic/downloads/second-fermentation-flavor-chart.html` →
  `/downloads/otis-classic-second-fermentation-flavor-chart.pdf`. Covers the key numbers, eight flavor starting
  points, the routine, a gusher-proof checklist, flat fixes, and a batch log.

The HTML is the source and the PDF is rendered from it. Draft PDFs are committed next to the sources for review.
In Phase 2, `npm run emails:pdf` (a dev-only Playwright script, since the Vercel build has no browser) re-renders
them, and the build copies the brand's `downloads/*.pdf` into `dist/downloads/`. The PDFs are public URLs and not
gated. The value of the signup is the sequence, not the file. The Amazon promo code idea is parked for a P2 A/B
test.

### 4.4 Where the endpoint runs: **Vercel Functions in root `api/`**
`astro.config.mjs` is `output: 'static'` and every brand is its own Vercel project. A root `api/` directory deploys
as Node functions next to the static `dist/` without touching the Astro build or `vercel.json`'s `outputDirectory`.
**Spike first (½ hr):** confirm Vercel picks up `api/` under the `astro` framework preset. If it doesn't, the
fallback is `@astrojs/vercel` with per-route `export const prerender = false`, which changes the output dir, so
it's a bigger diff.

This keeps the v1 acceptance criterion **"no request to `*.supabase.co` from the deployed site"** true: the
browser only calls same-origin `/api/*`, and Supabase is called server-side with the secret key.

### 4.5 Sender identity & mailing address: **shared across brands (DECIDED)**
CAN-SPAM requires *the sender's* valid physical postal address. The sender is the legal entity behind every brand,
so one address serves all of them. A street address, a USPS PO box, or a registered commercial mail-receiving
agency (CMRA) address all qualify. Every email footer carries one line that names the brand, the entity and the
address:

> You're receiving this because you signed up at otisclassic.com. Otis Classic is a brand of
> {legal_name}, {mailing_address}. {{{ pm:unsubscribe }}}

- **Portfolio default:** `src/content/email-defaults.yaml` holds `legal_name` and `mailing_address`, set once.
- **Per-brand override:** nullable `bronze.brand_sites.mailing_address` and `legal_name`, used only if a brand is
  ever owned by a different entity.
- The gate (§7.4) fails the build if a brand has `emails/` content and no resolvable address, so **nothing can
  ship with a placeholder address**.
- Naming the parent entity keeps "who is this from" honest across 27 brand names on one address. It is the same
  entity a recipient would find in any complaint lookup.

### 4.6 Hosting plan: **Vercel Pro (DECIDED)**
- **Pro is required regardless of email.** Vercel's Hobby plan is limited to personal, non-commercial use, and
  these sites exist to earn Brand Referral Bonus, so every brand project should sit on a Pro team.
- Pro is billed **per team member seat (~$20/mo), not per project**, and includes a usage credit. All ~27 brand
  projects can live on one Pro team. Static sites plus a few function calls a day stay well inside the included
  usage at our traffic. Watch the usage page after the first month.
- Crons: Pro allows per-minute schedules (Hobby is once per day). We keep a **daily** drip cron anyway, since day
  granularity is right for a welcome series, but Pro lets us run the confirm-email retry and webhook-backlog sweeps
  hourly.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `POSTMARK_SERVER_TOKEN` as **Sensitive** environment variables scoped to
  Production and Preview, and set them only on projects where `email_enabled` is true.

---

## 5. User experience

### 5.1 Placements (v1)
| Placement | Where | Copy direction | Track assigned |
|---|---|---|---|
| **Blog inline** | After the last `cta_after_sections` card, before the FAQ | "Get the free printable cheat sheet + 4 short tips emails" | From post's `primary_asin` family |
| **Blog index** | Under the intro | "Two free kitchen guides, plus tips by email" | `general` |
| **Footer band** | Every page, above the v1 footer | "Kitchen notes from Otis Classic: recipes, how-tos, new gear. No spam." | From page context (PDP family), else `general` |
| **PDP** | Below the gallery/description, **never above or beside the Amazon CTA** | "New to dispensers? Get the free cheat sheet." | PDP's family |

The Amazon CTA stays the primary action on every page. The form must never compete with it above the fold.

### 5.2 Form behavior
- One field (email), a submit button, and one consent line: "Get Otis Classic recipes and tips by email.
  Unsubscribe anytime. [Privacy]". No pre-checked boxes. The consent text is versioned and stored with each signup.
- It works with JS off: a plain `<form method="post" action="/api/subscribe">` gets a 303 redirect to
  `/subscribe/check-inbox/`. With JS on, the page does a `fetch` and shows the message inline.
- Hidden fields: `track`, `source_type` (blog|footer|pdp|blog_index), `source_path`, plus a snapshot of
  `window.fogoPaid` (gclid and campaign params, if any), so we can attribute a signup to a Google Ads campaign.
- Bot defense: a honeypot field, a minimum 2-second time-to-submit, a per-IP-hash rate limit (5/hour), and double
  opt-in.
- New static pages: `/subscribe/check-inbox/` and `/subscribe/confirmed/` (download buttons for the track's PDFs
  and a link to its best post). Both are `noindex` and excluded from the sitemap. Unsubscribe uses Postmark's
  hosted confirmation page.

### 5.3 Analytics
GA4 events `email_signup` (on submit accepted) and `email_confirm` (on the confirmed page) carry `track`,
`source_type`, and `cta_channel` (organic | google_ads). Import `email_signup` into Google Ads as a secondary
conversion first, then promote it once volume supports that.

---

## 6. The drip campaign (copy drafted: `src/content/brands/otis-classic/emails/`)

### 6.1 Sequence structure
The flow is: confirm, then welcome, then 4 track emails over ~14 days, then graduation (stay subscribed, P2
"Kitchen Notes" new-post emails only). Timing lives in `emails/sequences.yaml`. Sends go out once a day in a
10:00 ET window. Anyone who unsubscribes, bounces, or complains is dropped immediately.

`track` is picked at signup from context, so a visitor reading the kombucha post never gets dispenser mail first.
Each track's day-14 email cross-sells the other line. That's the list's real cross-sell lever, because on
Amazon these two buyer groups never meet.

### 6.2 Track `dispenser`
| # | Day | File | Subject | Job |
|---|---|---|---|---|
| 0 | immediate | `_confirm.md` | One click to get your free guide | Transactional confirm (outbound stream) |
| 1 | 0 | `dispenser/1-welcome.md` | Your whipped cream dispenser cheat sheet | Deliver PDF, the three rules |
| 2 | 2 | `dispenser/2-fixes.md` | Runny, stiff, or sputtering? The quick fixes | Troubleshooting + safe opening + cleaning |
| 3 | 5 | `dispenser/3-beyond-whipped-cream.md` | Cold foam, mousse and 2-minute cocktail infusions | Use-case expansion |
| 4 | 9 | `dispenser/4-standard-vs-professional.md` | Standard or Professional: which dispenser is yours? | Soft product CTA (gift or upgrade) |
| 5 | 14 | `dispenser/5-swing-top-bottles.md` | The other thing our kitchen runs on | Cross-sell to bottles, graduation |

### 6.3 Track `bottles`
| # | Day | File | Subject | Job |
|---|---|---|---|---|
| 1 | 0 | `bottles/1-welcome.md` | Your second fermentation flavor chart | Deliver PDF, the three numbers |
| 2 | 2 | `bottles/2-fizz-without-gushers.md` | How to get fizz without gushers | Pressure safety + flat fixes |
| 3 | 5 | `bottles/3-gaskets-and-uses.md` | Gasket care, plus 5 things to bottle besides kombucha | Care + uses beyond kombucha |
| 4 | 9 | `bottles/4-choosing-a-set.md` | Clear or amber? Plastic or ceramic caps? | Variant guide, CTA to the PDP |
| 5 | 14 | `bottles/5-rapid-infusions.md` | Bottles, meet the 2-minute cocktail infusion | Cross-sell to dispensers, graduation |

### 6.4 Track `general` (footer/index signups with no context)
`general/1-welcome.md`, "Welcome to Otis Classic. What are you making?", delivers **both** PDFs and offers two
choice links (`{{track_link:dispenser}}` / `{{track_link:bottles}}`). A click moves the subscriber into that track
at step 2, with the remaining day gaps measured from the click. With no click by day 5, they get
`dispenser/3` (day 5) and `bottles/3` (day 9), then graduate.

### 6.5 Email rules
- Every product link is written `amazon:<ASIN>` and resolved at build to the **`email` channel Attribution tag**:
  campaign `fbs-otis-classic-email`, ad group = `{track}`, creative = `{step}-{asin}`, the same template-fill
  approach `attribution-tags.mjs` already uses. The fallback is the `brand_site` tag, then the plain URL. Every site
  link gets `utm_source=email&utm_medium=drip&utm_campaign=fbs-otis-classic-{track}&utm_content={step}`.
- Plain, fast HTML: one column, brand tokens (teal #86BDC2, charcoal #373131, Fira Sans with system fallback),
  logo from the bucket, alt text on every image, and a plain-text part generated automatically.
- Footer (template-level, never in step files): why you got this, the §4.5 sender line with the mailing address,
  and `{{{ pm:unsubscribe }}}`. List-Unsubscribe headers are added by Postmark.
- Content rules (enforced by §7.4):
  - Honest subjects, no fake urgency.
  - No prices, because they change after send.
  - No health, disease or FDA claims (this matters for kombucha: no "probiotic / gut health" language).
  - Chargers are mentioned only instructionally, never linked or sold, and never in a subject line.
  - No printed ASINs, no raw amazon.com links, no review asks.
- Every email invites replies ("a real person reads every reply"), so **the reply-to inbox must be monitored.**

---

## 7. Architecture

### 7.1 Diagram
```
browser (otisclassic.com, static)
  └─ POST /api/subscribe ───────────► Vercel Function (Node)
                                       ├─ validate + honeypot + rate limit
                                       ├─ upsert bronze.email_subscribers (status=pending) [service key]
                                       └─ Postmark "outbound" stream: confirm email (token link)
  GET /api/confirm?token ───────────► status=active, confirmed_at=now(), 303 → /subscribe/confirmed/
  GET /api/track?t=…&track=… ───────► general → chosen track (signed, single-use)
Vercel Cron (daily 14:00 UTC) ──────► /api/drip-tick (CRON_SECRET)
                                       ├─ select due (subscriber, step) for BRAND_SLUG
                                       │    WHERE status='active' AND confirmed_at IS NOT NULL
                                       ├─ render template (prebuilt JSON) → Postmark "broadcast" stream
                                       └─ insert bronze.email_sends (unique → idempotent)
Postmark (unsubscribe link, one-click header, suppression) ── managed, per broadcast stream
Postmark webhooks ──────────────────► /api/postmark-webhook (basic auth)
                                       ├─ SubscriptionChange → status=unsubscribed / complained
                                       ├─ Bounce (hard) → status=bounced
                                       └─ Delivery / Click → email_events
```
Each brand's Vercel project runs its own cron, scoped by its `BRAND_SLUG`, so brands never send each other's mail.

### 7.2 Data model (additive migration, `bronze` schema, **PII: no anon access**)
```sql
bronze.email_subscribers (
  id uuid pk default gen_random_uuid(),
  brand_slug text not null references bronze.brand_sites(slug),
  email citext not null,
  status text not null default 'pending'   -- pending|active|unsubscribed|bounced|complained
    check (status in ('pending','active','unsubscribed','bounced','complained')),
  track text not null default 'general',   -- dispenser|bottles|general (per-brand vocabulary)
  track_changed_at timestamptz,            -- general → chosen track (drip days re-anchor here)
  source_type text, source_path text,
  paid_snapshot jsonb,                     -- window.fogoPaid at signup (gclid, campaignid…)
  consent_text text not null, consent_version text not null,
  consent_at timestamptz not null default now(),
  ip_hash text, user_agent text,
  token_hash text not null,                -- sha256 of the confirm token (raw token only in the email)
  confirmed_at timestamptz, unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (brand_slug, email)
)
bronze.email_sends (
  id bigserial pk, subscriber_id uuid references bronze.email_subscribers on delete cascade,
  sequence text not null, step int not null, template_hash text not null,
  provider_message_id text, sent_at timestamptz default now(), status text,
  unique (subscriber_id, sequence, step)
)
bronze.email_events (
  id bigserial pk, provider_message_id text, subscriber_id uuid, type text,  -- delivery|click|bounce|spam|unsubscribe
  url text, payload jsonb, occurred_at timestamptz
)
```
**RLS deviates on purpose from the bronze pattern in `CLAUDE.md`:** these three tables are **service_role
ALL only**, with **no anon or authenticated SELECT**, because they hold personal data. There are no public views.
The dashboard reads aggregates through a service-role RPC (`brand_site_email_stats(brand_slug)`: counts by
status, track, and step, and click rates), never raw rows.

Unsubscribed, bounced and complained rows are **kept** as the suppression record. Deleting a row would let the
address be re-added. A deletion request (GDPR/CCPA-style) hard-deletes the row and keeps only
`sha256(email)` in a `bronze.email_suppressions` table, which the subscribe endpoint checks before insert.

`bronze.attribution_links` gets `channel='email'` rows through
`npm run attribution-tags -- --brand=otis-classic --channel=email`. That needs a channel map entry, and the
publisher is resolved with `--probe`. Amazon lists email publishers (e.g. "Email - Other"), so confirm the name
there.

### 7.3 Content (repo; drafted)
```
src/content/email-defaults.yaml              # legal_name, mailing_address (portfolio-wide; D3)
src/content/brands/otis-classic/
  emails/
    sequences.yaml                           # sender, lead magnets, tracks, step timing, link conventions
    _confirm.md                              # outbound stream
    dispenser/1-welcome.md … 5-swing-top-bottles.md
    bottles/1-welcome.md … 5-rapid-infusions.md
    general/1-welcome.md
  downloads/
    whipped-cream-dispenser-cheat-sheet.html (+ rendered .pdf)
    second-fermentation-flavor-chart.html    (+ rendered .pdf)
```
Step frontmatter: `subject`, `preheader`, `stream` (outbound|broadcast), optional `primary_asin`, and `cta`
`{label, href}`. The markdown body uses the link conventions documented at the top of `sequences.yaml`.
`scripts/build-emails.mjs` runs in `npm run build`. It renders each step to HTML and text with brand tokens and the
footer, resolves `amazon:` links, and writes `api/_generated/emails.<slug>.json`, which the functions import. A
brand with no `emails/` directory builds nothing, so the capture UI stays off. That's the same opt-in-by-content
rule as the blog. None of these paths match the existing content-collection globs, so the Astro collections are
unaffected.

### 7.4 Gate: `scripts/check-emails.mjs`
It runs next to `check-blog` and **fails the build** when:
- a subject is missing or over 60 characters;
- a preheader is missing or over 90 characters;
- a body contains the blog claim terms (disease, FDA, clinically proven, probiotic/gut-health);
- a subject contains a charger/N₂O term (the `ads-spec.mjs` policy list);
- a body contains a price (`$` amount), a printed ASIN, a raw amazon.com link, or review language;
- a link points at an unbuilt site path, or a sequence references a missing step;
- a `broadcast` step's template has no `{{{ pm:unsubscribe }}}`;
- the sender line can't resolve a `legal_name` + `mailing_address`;
- an `outbound` step has a marketing CTA (anything other than `{{confirm_url}}`).

### 7.5 Config
- `src/content/email-defaults.yaml`: `legal_name`, `mailing_address` (D3). Set to Fogo Brands LLC and the Fayetteville, AR address.
- `bronze.brand_sites` gets new nullable columns: `email_enabled` bool (a kill switch for capture UI and cron),
  `email_from_name`, `email_from_address`, and the §4.5 overrides `legal_name` and `mailing_address`.
  **`contact_email` is currently null for Otis**, so set it; it's the reply-to and must be a monitored inbox.
- Vercel env (Otis project only, Sensitive): `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`, never `PUBLIC_`),
  `POSTMARK_SERVER_TOKEN`, `CRON_SECRET`, `EMAIL_TOKEN_PEPPER`, `POSTMARK_WEBHOOK_USER/PASS`.
- DNS (Squarespace, otisclassic.com): Postmark DKIM TXT, Return-Path CNAME (`pm-bounces`, which aligns SPF), and
  `_dmarc` `p=none; rua=…`. Tighten to `quarantine` after 30 clean days. This covers the Gmail, Yahoo and Outlook
  bulk-sender authentication rules. Outlook has rejected non-compliant bulk mail since May 2025.

### 7.6 Files touched / added
| File | Change |
|---|---|
| `src/components/EmailCapture.astro` | New: form + inline enhancement script, variants `inline` / `band` / `compact` |
| `src/pages/blog/[...slug].astro`, `Footer.astro`, `products/[asin].astro` | Mount the component when `email_enabled` |
| `src/pages/subscribe/{check-inbox,confirmed}.astro` | New, `noindex` |
| `src/pages/privacy.astro` | New "Email" section (what we collect, why, retention, unsubscribe, no sale), shown when enabled |
| `src/lib/supabase.js` | `getEmailConfig()` (brand columns only; no subscriber data at build) |
| `api/subscribe.js`, `api/confirm.js`, `api/track.js`, `api/drip-tick.js`, `api/postmark-webhook.js` | New Vercel Functions |
| `scripts/lib/email-send.mjs`, `scripts/lib/email-render.mjs` | Postmark wrapper + renderer (shared by functions and the build) |
| `scripts/build-emails.mjs`, `scripts/check-emails.mjs` | New build steps; added to `npm run build` |
| `scripts/render-downloads.mjs` (`npm run emails:pdf`) | Dev-only Playwright render of `downloads/*.html` → PDF |
| `scripts/attribution-tags.mjs` | Add `email` channel → publisher mapping |
| `vercel.json` | `crons`: daily `/api/drip-tick`, hourly confirm-retry sweep |
| `sql/email_capture.sql` | Tables, RLS, suppression table, stats RPC |
| `CLAUDE.md` | Document the feature (commands, PII RLS exception, rollout step) |

`check-dist.mjs` should also assert that no built HTML or JS contains `sb_secret_` or a Postmark token.

---

## 8. Phasing & estimate

| Phase | Contents | Est. |
|---|---|---|
| **0: Setup** (owner) | Postmark account + Otis server (outbound + broadcast streams), DNS records, **mailing address + legal name**, reply-to inbox, move brand projects to a Vercel Pro team, env vars | ~1 hr |
| **1: Capture** | Spike (§4.4), migration, `EmailCapture` in 4 placements, subscribe/confirm functions, confirm email, thank-you pages, privacy copy, GA events | 1.5 days |
| **2: Drip** | ~~Sequence content + PDFs~~ (**drafted**; owner edit pending), build/check/render scripts, drip-tick cron, track switch, webhooks, `email` Attribution tags | 1.5 days |
| **3: Measure** | Stats RPC, `email` channel in `attribution-report`, Google Ads `email_signup` conversion import, day-30 read | 0.5 day |
| **P2** | "Kitchen Notes" new-post emails, exit-intent (collection pages only), promo-code A/B, rollout to Amazing Shields → Xtreme Comforts → wave | per brand ≈ content only |

**Acceptance criteria (pilot)**
- A signup on `/blog/kombucha-second-fermentation-guide/` creates a `pending` row with `track=bottles`, sends the
  confirm email within 60 s, and after confirmation sends bottles email 1, then email 2 two days later.
- A `pending` (unconfirmed) subscriber receives **nothing** on the broadcast stream, ever. This is tested by
  seeding a pending row and running `drip-tick`.
- Re-submitting the same email neither duplicates the row nor re-sends the confirm more than once per 10 minutes.
  An address in `email_suppressions` gets the same "check your inbox" response but no row and no email.
- Gmail's unsubscribe button and the footer link both unsubscribe through Postmark. The `SubscriptionChange`
  webhook sets `unsubscribed`, and no further drip is queued. A hard bounce sets `bounced`.
- Running `drip-tick` twice in the same day sends nothing twice (unique on `email_sends`).
- Every broadcast email has the sender line with the mailing address and a working unsubscribe link.
- Every Amazon link in a sent email carries the `email` Attribution tag (or a documented fallback).
- The deployed site still makes zero runtime requests to `*.supabase.co`, and anon cannot SELECT any `email_*`
  table (verified with the publishable key).
- A brand without `emails/` content builds byte-identical to today.

---

## 9. Compliance checklist
- **CAN-SPAM:**
  - accurate From and a non-deceptive subject;
  - the sender line + physical postal address (§4.5) in every marketing email;
  - a working opt-out in every marketing email (Postmark's is instant; the law allows 10 business days);
  - opt-outs honored permanently (suppression rows kept);
  - opt-out requires nothing beyond one click.
- **Gmail / Yahoo / Outlook bulk-sender rules:** SPF + DKIM + DMARC (aligned), one-click unsubscribe (Postmark
  headers), unsubscribes honored within 2 days (instant), spam complaints < 0.3%.
- **Consent (CASL / GDPR, for non-US signups):** double opt-in + a stored, versioned consent record = express
  consent with proof. Deletion requests are honored via hashed suppression (§7.2).
- **Amazon:** no buyer data imported, no review solicitation, and no pricing claims that could contradict the
  listing (no prices at all).
- **Privacy page:** update it before the form goes live. The current copy says no personal information is
  collected.
- **Postmark policy:** explicit opt-in only; never import contacts from Amazon, wholesale lists, contests or
  anywhere else.

---

## 10. Open items
1. ~~Mailing address + legal entity name~~ Done (Fogo Brands LLC; see `src/content/email-defaults.yaml`).
2. **Logo:** pull `brand-site-images/otis-classic/brand/logo.png` into `downloads/` and replace the text wordmark
   in both PDFs (blocked in the cloud session by network policy; being done locally).
3. **Sender and reply-to:** confirm `hello@otisclassic.com` as From, and which monitored inbox replies should land
   in (also set as `brand_sites.contact_email`).
4. **Copy review:** edit the drafts in `emails/` and `downloads/`. The facts come from the listing bullets and the
   three live posts. Per-flavor amounts in the flavor chart are starting points within the post's 10–20% rule.
5. **Listing inconsistency to check before email 4 ships:** the Professional dispenser (B06WVD2K6N) listing title
   says "304 Stainless Steel", but one bullet says "Aluminum grade cream whipper". Email 4 says both models are
   stainless steel. Confirm the material, and fix the listing bullet if it's wrong.
