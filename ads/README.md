# Google Ads campaign specs

One JSON file per blog post, written by `npm run ads:campaigns -- --brand=<slug>` and pushed
to Google Ads by `npm run ads:push -- --spec=ads/<brand>/<post>.json`. Specs are committed so a
campaign change is reviewable in a pull request before it reaches Google.

Regenerate a spec whenever its post's search brief (`target_keyword`, `secondary_keywords`,
`ads:` block, `related_asins`) changes or the Amazon search-term window should refresh. A spec
that has been pushed carries its Google resource names under `google`; regenerating keeps the
file but the push script refuses to create a second campaign for it (`--force` overrides).

Layout of a spec:

- `campaign` — name `fbs-{brand}-{post}`, Search only, US / English, created PAUSED, budget,
  bidding stage + the planned progression, ValueTrack final-URL suffix, negatives.
- `ad_groups[]` — `guide` (the brief's keywords) and `product` (`ads.seeds` + Amazon search
  terms that already convert for the post's ASINs). Each carries the responsive search ad,
  sitelinks and callouts.
- `mined` — the Amazon evidence behind the product keywords and negatives (clicks, purchases,
  conversion rate over `source.days`), for review.
- `google` — customer id and resource names once pushed.

See CLAUDE.md → "Google Ads campaigns" for the full workflow and the credentials it needs.
