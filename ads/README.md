# Google Ads campaign specs

One JSON file per blog post, written by `npm run ads:campaigns -- --brand=<slug>` and pushed
to Google Ads by `npm run ads:push -- --spec=ads/<brand>/<post>.json`. Specs are committed so a
campaign change is reviewable in a pull request before it reaches Google.

Regenerate a spec whenever its post's search brief (`target_keyword`, `secondary_keywords`,
`ads:` block, `related_asins`) changes or the Amazon search-term window should refresh. A spec
that has been pushed keeps its Google resource names, status and bidding stage under
regeneration; `ads:push --sync` then brings the live campaign in line with it.

## Standard workflow (every new post, every regenerate)

1. **Write the post** with its search brief; `npm run check:blog` must pass.
2. **Generate**: `npm run ads:campaigns -- --brand=<slug>` (always the whole brand, so keywords
   are shared out across its posts). Read the `excluded` lines it prints.
3. **Review**: `npm run ads:review -- --brand=<slug>`. Errors block every push; the result is
   stored in each spec under `review` and tied to the spec's content by hash — any later edit or
   regenerate that changes the campaign voids it.
4. **Read the spec** (human): the checklist below.
5. **Push paused**: `npm run ads:push -- --spec=…` for a new campaign, `--sync` for a pushed one.
   Commit the spec (it now carries the Google ids).
6. **Enable** after Google approves the ads: `npm run ads:push -- --spec=… --enable
   --ack-warnings`. Enable refuses while any ad is under review or disapproved, while the live
   campaign differs from the spec, or without `--ack-warnings` when the review raised warnings.

## What `ads:review` checks

Errors (block create / sync / enable):

- the brand's Google Ads account is linked under the manager account
- no keyword is live in another campaign of the account (e.g. an agency's direct-to-Amazon
  campaign) or present in another spec of the brand — one account never bids against itself
- no negative keyword blocks one of our own keywords
- no policy-risk keyword (N2O, chargers, CBD, … — `scripts/lib/ads-spec.mjs`)
- ad copy within Google's limits, plain ASCII, no editorial-policy issues
- landing page and sitelink URLs return 200; the landing page carries Amazon CTAs
- an active `google_ads` Attribution tag exists for the post's primary ASIN
- Google's own `validateOnly` check passes (create, or sync for a pushed campaign)

Warnings (enable needs `--ack-warnings`):

- other advertisers' campaigns are live in the account — tell their owner before launching
- no GA4 on the brand / no `amazon_click` conversion in the account — Google Ads will show 0
  conversions and bidding can't move past maximize clicks
- the account already pays more than our CPC ceiling on the same searches
- identical ad copy across ad groups; fewer than 2 sitelinks
- policy-sensitive words or "Amazon" (trademark) in ad copy
- ads not yet approved

## Human checklist (step 4)

- [ ] Keywords: would each one's searcher be happy to land on this post? Any competitor brands,
      ingredients or accessories we don't sell ("whipping cream", "chargers")?
- [ ] `excluded`: anything dropped that should instead be coordinated with the other campaign's
      owner?
- [ ] Negatives: nothing that removes good traffic ("amazon", "manual" were once here).
- [ ] Ad copy: reads naturally, product claims are true for the ASIN, both ad groups differ.
- [ ] Sitelinks point to related pages only.
- [ ] Budget and CPC ceiling are what we intend to spend.
- [ ] Account-level assets: nothing inherited we don't want (calls are excluded automatically).

## Layout of a spec

- `campaign` — name `fbs-{brand}-{post}`, Search only, US / English, created PAUSED, budget,
  bidding stage + the planned progression, ValueTrack final-URL suffix, negatives.
- `ad_groups[]` — `guide` (the brief's keywords: people looking for the how-to) and `product`
  (`ads.seeds` + Amazon search terms that already convert for the post's ASINs: shoppers). Each
  carries its own responsive search ad; sitelinks and callouts are campaign-level.
- `excluded` — keywords the generator dropped and why (live elsewhere in the account, owned by
  an earlier post, policy risk, no product noun).
- `mined` — the Amazon evidence behind the product keywords and negatives (clicks, purchases,
  conversion rate over `source.days`), for review.
- `review` — the last `ads:review` result and the spec hash it applies to.
- `google` — customer id and resource names once pushed.

See CLAUDE.md → "Google Ads campaigns" for the credentials and the bidding progression.
