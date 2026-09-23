# EMAIL_CAPTURE_SCOPE_v1.md
**Otis Classic (otisclassic.com): email capture and signup drip campaign**
Scope for a Claude Code implementation. Version 1.0, 2026-09-23. Pilot brand: `otis-classic`. It is built to be
portfolio-generic, so turning it on for another brand means adding content, not code.

This builds out the P1 line in `BRAND_SITES_SCOPE_v1.md` §5.2 ("Email capture form (Postmark or simple
provider): customer-ownership beachhead without commerce") and the open question in
`XTREME_SITE_V2_SCOPE.md` §7.4 ("likely a Supabase table + … sends later").

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
- The drip reuses the blog's content engine. Every email can point at an existing post or PDP.

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
| Engagement | Drip click rate per email | ≥ 4% (median across the sequence) | ESP click events |
| Deliverability | Bounce / spam-complaint rate | < 2% / < 0.1% | ESP webhooks |
| Revenue | Email-channel Attribution clicks → purchases → BRB | Trend; first read at day 30 | `attribution-report` (channel `email`) |
| Blended | Otis TACoS | Flat-to-down (per measurement philosophy) | Dashboard |

Open rates are reported but are not a goal, because Apple Mail Privacy Protection inflates them.

---

## 3. Non-goals (v1)

1. No on-site accounts, preference center, or login. The only self-service is unsubscribe.
2. No purchase-triggered flows. We have no order data, and **Amazon buyer data (Buyer-Seller Messaging, order
   reports) must never be imported into this list**, because that violates Amazon's policy.
3. No review solicitation of any kind in emails. Incentivized or conditional review requests violate Amazon's
   policy, and the drip copy gate (§7.4) blocks the word "review" in CTAs.
4. No SMS.
5. No exit-intent modal in v1 (P2). It hurts Core Web Vitals and annoys paid landings.
6. No new Supabase Edge Functions. Per `CLAUDE.md`, those belong to the dashboard repo. Everything runs as Vercel
   Functions from this repo.

---

## 4. Key decisions (recommendation first)

### 4.1 ESP / sending model: **owned list in Supabase + Postmark for sending (recommended)** vs Klaviyo

| | Owned: Supabase + Postmark (recommended) | Klaviyo |
|---|---|---|
| Source of truth | `bronze.email_subscribers` (ours, joinable to Attribution data) | Klaviyo profiles (export to see them) |
| Multi-brand (≈27) | One table keyed by `brand_slug`. One Postmark server per brand, each on its own domain | One account per brand in practice (sender and domain branding are account-level), each billed per contact |
| Klaviyo's main advantage | n/a | Purchase-event flows and segmentation. We have **no purchase events** (Amazon), so most of it goes unused |
| Content | Markdown in repo, gated like the blog (`check-emails`), reviewed in PRs | WYSIWYG in Klaviyo, outside the repo's gates |
| Cost at pilot scale | Postmark ~$15/mo per 10k emails (shared across brands) | Free to 250 contacts, then per-contact per account |
| Build effort | Higher: we build scheduler, unsubscribe, and webhooks (≈3–4 days total) | Lower: form embed + flow builder (≈1 day) |
| Runtime requests | Same-origin `/api/*` only | Klaviyo JS/API from the browser (third-party request) |

The owned model fits this repo's grain: content in markdown, content gates, one template for N brands, and data in
`bronze.*`. Postmark is the provider already named in the v1 scope. It keeps transactional mail (the confirm email)
and marketing mail (the drip) on separate message streams, so a drip complaint never delays confirmations. Resend
is an equivalent swap behind the same `scripts/lib/email-send.mjs` interface.

### 4.2 Double opt-in: **yes**
A brand-new sending domain with single opt-in and bot signups is the fastest way into the spam folder. The confirm
step also gives us a consent record: timestamp, IP hash, and the exact consent text shown.

### 4.3 Incentive: **a free printable guide (recommended)** vs Amazon promo code vs none
- Recommended: one PDF per track, rendered from repo content. "Whipped Cream Dispenser Cheat Sheet" covers fill
  line, one charger per 500 ml, shake count, and ratios for cold foam, mousse, and infusions. "Second Fermentation
  Flavor Chart" covers fruit and sugar per 16 oz bottle, days to carbonate, and burping schedule. It costs nothing
  and fits the instructional content.
- Option: an Amazon **Social Media Promo Code** (a percentage off, redeemed on Amazon). It lifts signups but
  trains discount-seeking, and it needs a code per ASIN managed in Seller Central. Revisit in P2 as an A/B test.

### 4.4 Where the endpoint runs: **Vercel Functions in root `api/` (recommended)**
`astro.config.mjs` is `output: 'static'` and every brand is its own Vercel project. A root `api/` directory deploys
as Node functions next to the static `dist/` without touching the Astro build or `vercel.json`'s `outputDirectory`.
**Spike first (½ hr):** confirm Vercel picks up `api/` under the `astro` framework preset. If it doesn't, the
fallback is `@astrojs/vercel` with per-route `export const prerender = false`, which changes the output dir, so
it's a bigger diff.

This keeps the v1 acceptance criterion **"no request to `*.supabase.co` from the deployed site"** true: the
browser only calls same-origin `/api/subscribe`, and Supabase is called server-side with the secret key.

---

## 5. User experience

### 5.1 Placements (v1)
| Placement | Where | Copy direction | Track assigned |
|---|---|---|---|
| **Blog inline** | After the last `cta_after_sections` card, before the FAQ | "Get the printable cheat sheet + 4 short tips emails" | From post's `primary_asin` family |
| **Blog index** | Under the intro | Same | `general` |
| **Footer band** | Every page, above the v1 footer | "Kitchen notes from Otis Classic — recipes, how-tos, new gear. No spam." | From page context (PDP family), else `general` |
| **PDP** | Below the gallery/description, **never above or beside the Amazon CTA** | "New to dispensers? Get the cheat sheet." | PDP's family |

The Amazon CTA stays the primary action on every page. The form must never compete with it above the fold.

### 5.2 Form behavior
- One field (email), a submit button, and one consent line: "Get Otis Classic recipes and tips by email.
  Unsubscribe anytime. [Privacy]". No pre-checked boxes.
- It works with JS off: a plain `<form method="post" action="/api/subscribe">` gets a 303 redirect to
  `/subscribe/check-inbox/`. With JS on, the page does a `fetch` and shows the message inline.
- Hidden fields: `track`, `source_type` (blog|footer|pdp|blog_index), `source_path`, plus a snapshot of
  `window.fogoPaid` (gclid and campaign params, if any), so we can attribute a signup to a Google Ads campaign.
- Bot defense: a honeypot field, a minimum 2-second time-to-submit, a per-IP-hash rate limit (5/hour), and double
  opt-in. Cloudflare Turnstile is left out, because it's an external script and the defenses above are enough at
  our volume.
- New static pages: `/subscribe/check-inbox/`, `/subscribe/confirmed/` (delivers the PDF and links to the
  track's best post), and `/subscribe/unsubscribed/`. All three are `noindex` and excluded from the sitemap.

### 5.3 Analytics
GA4 events `email_signup` (on submit accepted) and `email_confirm` (on the confirmed page) carry `track`,
`source_type`, and `cta_channel` (organic | google_ads). Import `email_signup` into Google Ads as a secondary
conversion first, then promote it once volume supports that.

---

## 6. The drip campaign

### 6.1 Sequence structure
The flow is: confirm, then welcome, then 4 track emails over ~14 days, then graduation to the monthly
"Kitchen Notes" list (new posts, P2). Sends go out once a day in a 10:00 ET window. Anyone who unsubscribes,
bounces, or complains is removed immediately.

`track` is picked at signup from context, so a visitor reading the kombucha post never gets dispenser mail first.
Each track's day-14 email cross-sells the other line. That's the list's real cross-sell lever, because on
Amazon these two buyer groups never meet.

### 6.2 Track A: `dispenser` (whipped cream dispensers, B01DZ2HZ2U / B06WVD2K6N)
| # | Day | Subject (draft) | Job | Links |
|---|---|---|---|---|
| 0 | immediate | Confirm your email for the cheat sheet | Transactional confirm | `/api/confirm` |
| 1 | on confirm | Your whipped cream dispenser cheat sheet | Deliver PDF; the 60-second routine | `/blog/how-to-use-a-whipped-cream-dispenser/` |
| 2 | +2 | Runny, stiff, or sputtering? The 3 fixes | Troubleshooting + cleaning/gasket care (cuts returns and bad reviews) | same post (fixes section) |
| 3 | +5 | Cold foam, mousse, and 10-minute infusions | Use-case expansion, so they use it more | `/blog/whipped-cream-dispenser-ideas-beyond-whipped-cream/` |
| 4 | +9 | Standard vs Professional: which one you have and when to upgrade | Soft product CTA (gift or upgrade) | PDPs + Amazon `email` tag |
| 5 | +14 | The other thing our kitchen runs on: swing-top bottles | Cross-sell to bottles | kombucha post + bottle family |

### 6.3 Track B: `bottles` (swing-top bottles, B0H89XLBKG family; mini jars B0G1NFP1DM)
| # | Day | Subject (draft) | Job | Links |
|---|---|---|---|---|
| 0 | immediate | Confirm your email for the flavor chart | Transactional confirm | `/api/confirm` |
| 1 | on confirm | Your second-fermentation flavor chart | Deliver PDF; the bottling basics | `/blog/kombucha-second-fermentation-guide/` |
| 2 | +2 | How to get fizz without gushers | Carbonation control, burping, fridge timing | same post |
| 3 | +5 | Gasket care + 5 things to bottle besides kombucha | Care (longevity) + uses (infused oils, limoncello, cold brew) | bottle PDP |
| 4 | +9 | Clear or amber? Plastic or ceramic caps? | Variant guide, soft CTA to the right SKU | family PDPs + Amazon `email` tag |
| 5 | +14 | Your bottles + a dispenser = 10-minute infusions | Cross-sell to dispensers | dispenser ideas post |

### 6.4 Track C: `general` (footer/index signups with no context)
Welcome that presents both lines ("What are you making?") with two big links. Clicking one sets `track` via
a signed link (`/api/track?t=…&track=dispenser`) and drops them into email 2 of that track. If they click neither,
they get Track A's email 3 and Track B's email 3 on +5 and +9, then graduate.

### 6.5 Email rules
- Every product link goes to Amazon through an **`email` channel Attribution tag**. Campaign
  `fbs-otis-classic-email`, ad group = `{track}`, creative = `{step}-{asin}`, which is the same template-fill
  approach `attribution-tags.mjs` already uses. Every content link goes to our site with
  `utm_source=email&utm_medium=drip&utm_campaign=fbs-otis-classic-{track}&utm_content={step}`.
- Plain, fast HTML: one column, brand tokens (teal #86BDC2, charcoal #373131, Fira Sans with system fallback),
  logo from the bucket, alt text on every image, and a plain-text part generated automatically.
- Footer: why you got this, a one-click unsubscribe link, and a **physical mailing address** (required by
  CAN-SPAM; see §9).
- Headers: `List-Unsubscribe` (mailto + https) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (Gmail
  and Yahoo bulk-sender rules, RFC 8058).
- The same claims gate as the blog: no disease/FDA/"clinically proven" claims, no N2O/charger selling (same
  policy list as `scripts/lib/ads-spec.mjs`), no ASIN printed in text, no review asks, and no raw
  `amazon.com` links (tags only).

---

## 7. Architecture

### 7.1 Diagram
```
browser (otisclassic.com, static)
  └─ POST /api/subscribe ───────────► Vercel Function (Node)
                                       ├─ validate + honeypot + rate limit
                                       ├─ upsert bronze.email_subscribers (status=pending) [service key]
                                       └─ Postmark "outbound" stream: confirm email (token link)
  GET /api/confirm?token ───────────► status=active, enqueue step 1, 303 → /subscribe/confirmed/
  GET|POST /api/unsubscribe?token ──► status=unsubscribed (POST = one-click)
Vercel Cron (daily 14:00 UTC) ──────► /api/drip-tick (CRON_SECRET)
                                       ├─ select due (subscriber, step) for BRAND_SLUG
                                       ├─ render template (prebuilt JSON) → Postmark "broadcast" stream
                                       └─ insert bronze.email_sends (unique → idempotent)
Postmark webhooks ──────────────────► /api/postmark-webhook (basic auth)
                                       └─ bounce/complaint → status; delivery/click → email_events
```
Each brand's Vercel project runs its own cron, scoped by its `BRAND_SLUG`, so brands never send each other's mail.
The Vercel **Hobby** plan allows only daily crons, which is fine for day-granularity drips. **Pro** is needed only
if we want hourly sends.

### 7.2 Data model (additive migration, `bronze` schema, **PII: no anon access**)
```sql
bronze.email_subscribers (
  id uuid pk default gen_random_uuid(),
  brand_slug text not null references bronze.brand_sites(slug),
  email citext not null,
  status text not null default 'pending'   -- pending|active|unsubscribed|bounced|complained
    check (status in ('pending','active','unsubscribed','bounced','complained')),
  track text not null default 'general',   -- dispenser|bottles|general (per-brand vocabulary)
  source_type text, source_path text,
  paid_snapshot jsonb,                     -- window.fogoPaid at signup (gclid, campaignid…)
  consent_text text not null, consent_at timestamptz not null default now(),
  ip_hash text, user_agent text,
  token_hash text not null,                -- sha256 of the confirm/unsub token (raw token only in email)
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
  id bigserial pk, provider_message_id text, subscriber_id uuid, type text,  -- delivery|open|click|bounce|spam
  url text, payload jsonb, occurred_at timestamptz
)
```
**RLS deviates on purpose from the bronze pattern in `CLAUDE.md`:** these three tables are **service_role
ALL only**, with **no anon or authenticated SELECT**, because they hold personal data. There are no public
views. The dashboard reads aggregates through a service-role RPC (`brand_site_email_stats(brand_slug)`: counts by
status, track, and step, and click rates), never raw rows.

`bronze.attribution_links` gets `channel='email'` rows through
`npm run attribution-tags -- --brand=otis-classic --channel=email`. That needs a channel map entry, and the
publisher is resolved with `--probe`. Amazon lists email publishers (e.g. "Email - Other"), so confirm the name
there.

### 7.3 Content (repo, markdown, gated)
```
src/content/brands/otis-classic/emails/
  sequences.yaml            # tracks, step order, delay_days, graduation
  dispenser/1-welcome.md    # frontmatter: subject, preheader, delay_days, primary_asin, links
  dispenser/2-fixes.md …
  bottles/1-welcome.md …
  general/1-welcome.md
  lead-magnets/dispenser-cheat-sheet.md   # rendered to PDF at build, shipped at /downloads/…
```
`scripts/build-emails.mjs` runs in `npm run build`. It renders each step to HTML and text with brand tokens,
resolves `email` Attribution tags from `bronze.attribution_links` (falling back to the `brand_site` tag, then the
plain URL, so a missing tag never breaks a send), and writes `api/_generated/emails.<slug>.json`, which the functions
import. A brand with no `emails/` directory builds nothing, so capture UI stays off. That's the same opt-in-by-content rule
as the blog.

### 7.4 Gate: `scripts/check-emails.mjs`
It runs next to `check-blog` and fails the build on: a missing subject, a subject over 60 chars, a missing
preheader, the claim or N2O terms, a printed ASIN, a raw amazon.com link, a review ask, links to unbuilt site paths,
a sequence referencing a missing step, or a brand with emails but no `email_sender` / `mailing_address` configured.

### 7.5 Config
- `bronze.brand_sites` gets new nullable columns: `email_from_name` ("Otis Classic Kitchen"),
  `email_from_address` (`hello@otisclassic.com`), `mailing_address`, and `email_enabled` bool (a kill switch
  for capture UI and cron).
  `contact_email` is **currently null for Otis**, so set it (reply-to).
- Vercel env (Otis project only): `SUPABASE_SERVICE_ROLE_KEY` (`sb_secret_…`, server-only, never `PUBLIC_`),
  `POSTMARK_SERVER_TOKEN`, `CRON_SECRET`, `EMAIL_TOKEN_PEPPER`, `POSTMARK_WEBHOOK_USER/PASS`.
- DNS (Squarespace, otisclassic.com): Postmark DKIM TXT, Return-Path CNAME (`pm-bounces`), SPF include, and
  `_dmarc` `p=none; rua=…`. Tighten to `quarantine` after 30 clean days.

### 7.6 Files touched / added
| File | Change |
|---|---|
| `src/components/EmailCapture.astro` | New: form + inline enhancement script, variants `inline` / `band` / `compact` |
| `src/pages/blog/[...slug].astro`, `Footer.astro`, `products/[asin].astro` | Mount the component when `emailEnabled` |
| `src/pages/subscribe/{check-inbox,confirmed,unsubscribed}.astro` | New, `noindex` |
| `src/pages/privacy.astro` | New "Email" section (what we collect, why, retention, unsubscribe, no sale), shown when enabled |
| `src/lib/supabase.js` | `getEmailConfig()` (brand columns only; no subscriber data at build) |
| `api/subscribe.js`, `api/confirm.js`, `api/unsubscribe.js`, `api/track.js`, `api/drip-tick.js`, `api/postmark-webhook.js` | New Vercel Functions |
| `scripts/lib/email-send.mjs`, `scripts/lib/email-render.mjs` | Provider wrapper + renderer (shared by functions and the build) |
| `scripts/build-emails.mjs`, `scripts/check-emails.mjs` | New build steps; added to `npm run build` |
| `scripts/attribution-tags.mjs` | Add `email` channel → publisher mapping |
| `vercel.json` | `crons: [{ path: "/api/drip-tick", schedule: "0 14 * * *" }]` |
| `sql/email_capture.sql` | Tables, RLS, stats RPC |
| `CLAUDE.md` | Document the feature (commands, PII RLS exception, rollout step) |

`check-dist.mjs` should also assert that no built HTML or JS contains `sb_secret_` or `POSTMARK`.

---

## 8. Phasing & estimate

| Phase | Contents | Est. |
|---|---|---|
| **0: Setup** (you) | Postmark account + Otis server, DNS records, mailing address, from-address, Vercel env vars, the §4 decisions | ~1 hr |
| **1: Capture** | Spike (§4.4), migration, `EmailCapture` in 3 placements, subscribe/confirm/unsubscribe functions, confirm + welcome email, thank-you pages, privacy copy, GA events | 1.5 days |
| **2: Drip** | Sequence content (10 emails + general welcome, drafted by Claude for your edit), lead-magnet PDFs, build/check scripts, drip-tick cron, webhooks, `email` Attribution tags | 2 days |
| **3: Measure** | Stats RPC, `email` channel in `attribution-report`, Google Ads `email_signup` conversion import, day-30 read | 0.5 day |
| **P2** | Monthly "Kitchen Notes" auto-digest from new blog posts, exit-intent (collection pages only), promo-code A/B, rollout to Amazing Shields → Xtreme Comforts → wave | per brand ≈ content only |

**Acceptance criteria (pilot)**
- A signup on `/blog/kombucha-second-fermentation-guide/` creates a `pending` row with `track=bottles`, sends the
  confirm email within 60 s, and after confirmation sends bottles email 1, then 2 two days later.
- Re-submitting the same email neither duplicates the row nor re-sends the confirm more than once per 10 minutes.
- One-click unsubscribe (Gmail's button) sets `unsubscribed` and no further drip is sent. A hard bounce sets
  `bounced`.
- Running `drip-tick` twice in the same day sends nothing twice (unique on `email_sends`).
- Every Amazon link in a sent email carries the `email` Attribution tag (or a documented fallback).
- The deployed site still makes zero runtime requests to `*.supabase.co`, and anon cannot SELECT any `email_*`
  table (verified with the publishable key).
- A brand without `emails/` content builds byte-identical to today, apart from the unchanged footer.

---

## 9. Compliance checklist
- **CAN-SPAM:** accurate From, a non-deceptive subject, a physical postal address in every email, unsubscribe
  that works within 10 business days (ours is instant), and honoring unsubscribes forever. We keep the row as
  `unsubscribed` as a suppression record. Deleting it would allow re-adds.
- **Gmail/Yahoo bulk-sender rules:** SPF + DKIM + DMARC, one-click unsubscribe, complaint rate < 0.3%.
- **CASL / GDPR:** US-targeted, but double opt-in + a stored consent record covers express consent. Honor
  deletion requests by hard-deleting the row and keeping a hashed email in suppression.
- **Amazon:** no buyer data imported, no review solicitation, no off-Amazon pricing claims that contradict the
  listing. Prices are omitted from emails, since they change after send.
- **Privacy page:** update it before the form goes live. The current copy says we don't collect PII.

---

## 10. Open questions (need your call)
1. **ESP:** owned Supabase + Postmark (recommended) or Klaviyo? (§4.1)
2. **Incentive:** printable guides (recommended), an Amazon promo code, or none? (§4.3)
3. **Sender identity:** from name/address (`hello@otisclassic.com`?), a reply-to inbox someone actually reads, and
   the **physical mailing address** for the footer (a PO box or registered-agent address is fine).
4. **Vercel plan** on the Otis project: Hobby (daily cron, fine) or Pro (hourly)?
5. **Copy ownership:** should Claude draft all 11 emails and both PDFs for your edit, or do you have brand copy
   to start from?
