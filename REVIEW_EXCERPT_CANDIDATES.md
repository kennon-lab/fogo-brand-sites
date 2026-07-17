# Review excerpt candidates — DRAFTS, NOT PUBLISHABLE

⚠ **Nothing in this file may ever appear on the site.** Per the locked
decision in `XTREME_V2_STATUS.md`: Claude drafts candidates → Kennon replaces
each one with a **verbatim quote from a real, verified Amazon review** before
it enters `site.yaml` (`review_wall`) or a family YAML (`review_excerpts`).
The site renders nothing from these fields until real quotes exist, so
leaving them empty is always safe. Never paste text from this file into a
YAML. Delete this file at launch.

## How to use this file

Each candidate below is a *theme target*: it shows the kind of quote that
slot needs (topic, tone, length). For each one:

1. Open the family's Amazon reviews and search the suggested terms
   (Amazon's "Search customer reviews" box, filter: Verified Purchase).
2. Find a real quote that covers the same theme. Trim it (ellipses fine,
   no paraphrasing), keep it under ~40 words.
3. Copy it **verbatim** with the reviewer's public display name and star
   rating into the YAML shape shown at the bottom.

Selection criteria:

- Verified Purchase only; prefer the last ~18 months.
- Mostly 5★; one credible 4★ on the wall reads more honest than nine 5★.
- Skip anything with medical claims ("cured my sciatica") — pressure-relief
  and comfort language only, same rule as our own copy.
- Skip quotes that name competitors or prices (both go stale).
- First name + last initial as displayed by Amazon (e.g. "Karen M.").

---

## Homepage review wall (site.yaml → review_wall, aim for 6–9)

Spread across families — the wall should prove the catalog, not one pillow.

| # | Product (family) | Theme to find | Draft candidate (register target) | Search terms |
|---|---|---|---|---|
| 1 | Shredded Memory Foam Pillow | Adjustability actually used | "I took out about a third of the fill the first night and it's been perfect since. First pillow I haven't given up on in years." | adjust, removed fill, take out foam |
| 2 | Shredded Memory Foam Pillow | Side-sleeper fit | "I'm a side sleeper and this is the first pillow that keeps my neck straight without going flat by 3am." | side sleeper, neck, flat |
| 3 | Shredded Memory Foam Pillow | Longevity / repeat purchase | "Bought one three years ago, just ordered two more for the guest room. Still holds its shape after countless washes." | years, bought another, still |
| 4 | Shredded Memory Foam Pillow (Slim variant) | Stomach-sleeper relief | "Every 'thin' pillow I tried was still too tall. This one finally lets me sleep face down without craning my neck." | stomach sleeper, thin, low |
| 5 | Back & Lumbar Support | Driving | "Made a 12-hour road trip bearable. It stays put on the car seat and doesn't flatten like the cheap ones." | car, road trip, driving |
| 6 | Wedge & Body Pillows | Reading / elevation | "We keep it against the headboard for reading and my husband steals it to elevate his knees. It never loses the angle." | reading, incline, elevate |
| 7 | Shredded Memory Foam Pillow (4★, honesty slot) | Minor caveat + win | "Took a few nights of adding and removing foam to dial it in, but once I did, best sleep I've had in ages. 4 stars only because setup takes patience." | took a while, adjust, but |

## PDP excerpts (family YAML → review_excerpts, 2–3 each)

**shredded-pillow.yaml** — reuse wall #1/#2/#4/#7 themes, or find distinct ones:
- Loft dialing: "Add foam, remove foam, whatever your neck wants that week."
  (search: loft, customize)
- Cooling/washability: "Cover washes up like new and it doesn't sleep hot
  like my old solid foam pillow." (search: hot, wash)
- Slim variant, back-sleeper chin angle: "Normal pillows shove my chin into
  my chest. This one keeps my head level — didn't know a pillow could fix
  that." (search on the slim listings: back sleeper, angle, neutral)

**back-lumbar.yaml**
- Strap actually working: "The strap is the whole game. Every other lumbar
  pillow I owned ended up on the seat by noon; this one stays exactly where
  I put it." (search: strap, stays)
- Posture: "My lower back stopped nagging me during long editing sessions.
  I sit straighter without thinking about it." (search: posture, lower back)

**wedge-body.yaml**
- Wall #6 theme (reading/elevation).
- Body pillow side-sleep: "Wrapped around it the first night and my
  shoulders finally relaxed. My knees stopped knocking together too."
  (search: body pillow, knees, shoulder)

---

## Paste-ready YAML shapes (real quotes only)

site.yaml:

```yaml
review_wall:
  - name: "Karen M."
    rating: 5
    text: "REAL VERBATIM QUOTE HERE"
    product: The Shredded Memory Foam Pillow
```

family yaml (e.g. shredded-pillow.yaml):

```yaml
review_excerpts:
  - name: "Karen M."
    rating: 5
    text: "REAL VERBATIM QUOTE HERE"
```
