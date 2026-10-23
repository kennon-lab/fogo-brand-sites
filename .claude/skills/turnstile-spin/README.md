# turnstile-spin

Cloudflare's Turnstile "Spin" skill, installed verbatim as `SKILL.md` from the hosted prompt
(developers.cloudflare.com/turnstile/spin/prompt.md, fetched 2026-10-23 via its source in
`cloudflare/cloudflare-docs` → `public/turnstile/spin/prompt.md`; SHA-256
`98e20bd0dabb2d65a62ecc0f946882093e28b0ce625e96022cbe3d6bbe2f3f42`). Don't edit it; re-fetch to update.

The framework reference files its frontmatter lists (astro, vanilla-html, …) and its helper scripts
aren't bundled: the skill fetches the scripts itself (checksum-verified) when it runs, and the
references are optional.

How this repo applies it: see "Tape King dispenser funnel" in CLAUDE.md — siteverify lives in the
Supabase Edge Function, secrets in Supabase Edge Function secrets (entered through the Supabase
dashboard, never pasted into chat), and `TURNSTILE_HOSTNAMES` holds each deployment's allowed
hostnames.
