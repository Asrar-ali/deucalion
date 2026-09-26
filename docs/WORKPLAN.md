# Workplan — Team Prometheus

Two builders. Submission **16:30**. Presentations **17:30–18:30** in person at the
Northwestern Ontario Innovation Centre. **At least one of us must be in that room** or we
cannot claim a prize.

---

## The split

The seam is `docs/CONTRACT.md` + `fixtures/`. Neither of us blocks on the other after 10:00.

### Builder A — pipeline (owns `lib/`, `app/api/`)
`systemone.ts` · `questions.ts` · `prefilter.ts` · `geoparse.ts` · `resolve.ts` · `vision.ts`
· `summarize.ts` · `budget.ts` · all four API routes · `data/gazetteer.json`

### Builder B — interface (owns `app/`, `components/`)
Upload/paste/mic surface · records table · MapLibre map · filters · funnel strip · cluster &
brief panels · review queue · budget meter · export · accessibility · theming

**Builder A ships `fixtures/` by 10:00 and then does not touch `components/`.**
**Builder B works against fixtures until the real stream is green, and never edits `lib/`.**

---

## Timeline with hard gates

| Time | A | B | Gate |
|---|---|---|---|
| 09:45 | smoke-test `/v1/systemone` with the real key | `create-next-app` is done; shell layout + routes | **Contract proven before any UI** |
| 10:00 | **hand over `fixtures/`** | consuming fixtures | A is now unblocked from B |
| 10:30 | prefilter + event profile | table + filters rendering 50 fixture rows | |
| 11:00 | classify route streaming SSE | MapLibre up with fixture points | |
| **11:30** | — | — | **DEPLOY TO VERCEL. Ugly is fine. Non-negotiable.** |
| 12:15 | geoparse + gazetteer built | funnel strip + budget meter + confidence states | |
| 13:00 | link resolvers + screenshot OCR | paste box + mic + TTS | |
| 13:45 | Gemini vision + summaries | cluster/brief panels, citation chips | |
| 14:15 | First Nations layer + GeoJSON export | reserve overlay + community rollup | |
| 14:45 | budget/judge code/BYO key | a11y sweep: keyboard, contrast, hover-free, alt text | |
| **15:00** | **FEATURE FREEZE** | **FEATURE FREEZE** | **Only demo-path bugs after this** |
| 15:00–15:30 | writeup: architecture, honest limits, judge code, kill phrases | | |
| 15:30–15:45 | **record the fallback video** | | Venue wifi will not be trusted |
| 15:45–16:15 | rehearse the demo out loud, 3x, timed | | |
| 16:30 | **SUBMIT** | | |

Two rules that override everything: **deploy at 11:30 even if broken**, and **freeze at 15:00**.

### Ripcord — decide at 11:00, not at 15:00
If the classify stream is not producing labelled records by 11:00, cut in this order:
1. Gemini narrative summaries (extractive already works)
2. Image/vision path
3. Link resolvers
4. First Nations layer

Never cut: CSV ingest, classification, map, funnel counts, deploy.

---

## Demo script (3 minutes, memorised, not read)

1. **Hook, 15s.** "Kashechewan has been evacuated fourteen times since 2004. When the water
   comes, the first record of a submerged road is a post from someone standing in front of it.
   That record never reaches the people drawing the maps."
2. **Load, 20s.** One click, the provided 8,024 rows. Funnel fills on screen.
   "Eight thousand posts, classified in about forty-four seconds, for about fourteen cents."
3. **Explore, 40s.** Filter to `access_blocked`. Map clusters. Click a point → the post, the
   confidence, the reason. "Every point tells you how it got here and how sure it is."
4. **The Siksika beat, 30s.** "The dataset they gave us contains a First Nation."
   Click the reserve overlay. "Thirty posts about Siksika Nation flooding. The tool found the
   community, not just the coordinates."
5. **Paste a live link, 20s.** Paste an X post. It classifies and lands on the map.
   Hand the laptop to a judge. "Paste anything."
6. **Generalisation, 20s.** Upload an unseen CSV with different column names and a different
   hazard. The detected event profile changes on screen. "Nothing about flooding is hardcoded."
7. **Trust, 20s.** The unmappable count. The review queue. The audit log. The GeoJSON export.
   "This is a MapAki layer. Their GIS is where it goes."
8. **Ask, 15s.** "Ninety First Nation communities already work with CE Strategies. This runs on
   a laptop, costs cents, and stores nothing."

Do not demo: the login there isn't, the settings page, the tech-stack slide.

## Q&A prep

- *"How accurate is it?"* → Give the confidence distribution and the review-queue count. Never a
  bare percentage.
- *"Would you deploy this in an emergency tomorrow?"* → "No. It is decision support with a human
  in the loop. Here is what is missing: validation against labelled ground truth for this
  specific event, a community data agreement, and load testing."
- *"What if it is wrong?"* → "Low confidence routes to a human before anything is mapped as
  certain. The failure mode is extra work, never a false certainty."
- *"Where does the data go?"* → "Nowhere. Ephemeral processing, no persistence, redaction before
  any third-party call, one-click wipe."
- *"What did you cut?"* → Name the cut list confidently. It shows judgment.
