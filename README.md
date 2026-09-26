# Living Flood Map

**Team Prometheus** · Thunder Bay AI Hackathon, 26 September 2026
**Challenge sponsor:** CE Strategies

Firsthand public posts about a flood, turned into an auditable, mappable, accessible situational
picture — and handed to the GIS system a community already uses.

A submerged road or an elder's home taking on water is usually documented first by someone
standing in front of it, hours before any sensor registers it. That record never reaches the
people drawing the maps. This closes that gap.

---

## Quick start

```bash
cp .env.example .env.local     # then paste your keys into .env.local
node scripts/smoke.mjs         # prove the model contract before anything else
npm run dev
```

`scripts/smoke.mjs` hits the real endpoint with three rows from the provided dataset and prints
answers, confidence, the exact model version, latency and real cost per call. If that fails,
nothing else matters yet.

## Docs

| File | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | The approved design spec. Read this first. |
| `docs/CONTRACT.md` | Wire format between pipeline and UI. Frozen. |
| `docs/WORKPLAN.md` | Who builds what, timeline, hard gates, demo script |
| `docs/ACCESSIBILITY.md` | WCAG baseline, crisis accessibility, known gaps |

## What it does

Four front doors, one pipeline:

- **CSV upload** — the provided dataset, or any file judges upload
- **Photo / drone image** — Gemini vision, EXIF coordinates, automatic alt text
- **Paste a link or text** — X, Bluesky, fediverse, any web page; screenshot + OCR when a
  platform blocks us
- **Voice** — speak a report instead of typing it

Then: classify with typed, calibrated decisions · extract place names against a bundled
gazetteer · plot on an interactive map with a First Nations reserve overlay · filter, cluster
and summarise · export GeoJSON.

## Design commitments

- **Every label is a proposal with a confidence.** Nothing is presented as verified.
- **No silent drops.** The funnel shows raw → deduped → prefiltered → relevant → mappable, and
  the count of records that mention no place at all.
- **Ephemeral by default.** No server-side persistence, PII redacted before any third-party
  call, one-click wipe. The communities this serves own their data.
- **Extractive summaries always work.** The model-written narrative is an optional layer, and
  every sentence in it cites the records it came from.
- **The classifier is swappable.** It speaks the `/v1/systemone` wire protocol, so hosted Jev
  and a self-hosted open-weights model are a base-URL change apart.
- **Accessibility is the feature, not the polish.** A flood is exactly when someone is on a
  phone, outdoors, on satellite internet, possibly unable to read the screen.

## Honest limits

- No timestamps in the provided dataset, so no temporal spread. Supported if an uploaded file
  has a date column; not faked when it does not.
- Location coverage is partial by nature. The unmappable count is displayed, not hidden.
- Reddit and Meta APIs need credentials we do not have. Named, not worked around.
- All `t.co` links in the provided dataset are dead (2013), so link resolution is demonstrated
  with a live post.
- Self-assessed accessibility. No formal audit, no screen-reader user in the loop.

## Stack

Next.js 16 · React 19 · Tailwind · MapLibre GL · Jev (`jev-1.13`) via OpenRouter for typed
classification · Gemini for vision, OCR and narrative summaries · deployed on Vercel.
