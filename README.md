# Deucalion

**Team Prometheus** (2 builders) · Thunder Bay AI Hackathon, 26 September 2026
**Challenge sponsor:** CE Strategies

*The living flood map.*

A submerged road or an elder's home taking on water is usually documented first by someone
standing in front of it, hours before any sensor registers it. That record rarely reaches the
people drawing the maps. Deucalion takes firsthand public posts from a flood, classifies what
is actually relevant, plots what can be placed on a map, and exports a layer that drops
straight into CE Strategies' MapAki.

The name: in the myth, Prometheus warned his son Deucalion that the flood was coming, and
Deucalion survived because he was told in time. Sensors tell you afterwards.

---

## Quick start

```bash
cp .env.example .env.local     # then paste your keys into .env.local
node scripts/smoke.mjs         # prove the model contract before anything else
npm run dev
```

`scripts/smoke.mjs` sends three real rows from the provided dataset to the live endpoint and
prints the answers, confidence, the exact model version string, latency and real cost per
call. If that fails, nothing downstream can be trusted, so it runs first.

`npm run dev` and `npm run build` both run `scripts/copy-maplibre-worker.mjs` first. MapLibre
6 loads its worker as a separate module relative to `import.meta.url`, and Next's bundler does
not carry that file along with the chunk that references it, so the script copies it into
`public/maplibre/` before every dev server and build.

## Docs

| File | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | The approved design spec, the measured dataset facts and the honest limits. Read this first. |
| `docs/CONTRACT.md` | Wire format between pipeline and UI. |
| `docs/superpowers/specs/2026-09-26-deucalion-ui-design.md` | The UI design spec. |
| `docs/WORKPLAN.md` | Timeline, hard gates, demo script. |
| `docs/ACCESSIBILITY.md` | WCAG baseline, crisis accessibility, known gaps. |
| `docs/SUBMISSION.md` | The Devpost-style writeup. |
| `docs/DEMO.md` | The three-minute demo script and Q&A prep. |

## What it does

Four front doors, one pipeline:

- **CSV upload**, the provided dataset, or any file a judge uploads
- **Photo / drone image**, vision classification, EXIF coordinates, automatic alt text
- **Paste a link or text**: X, Bluesky, fediverse, or any web page; a screenshot plus OCR
  when a platform blocks the resolver
- **Voice**, speak a report instead of typing it

Every door produces the same record shape. From there: a local, free prefilter narrows the
field; a typed classifier decides relevance and category with a confidence attached; a
bundled gazetteer extracts place names, including First Nations reserves, with no geocoding
API; the map, table and filters render the result; and export produces a GeoJSON layer for
MapAki, a CSV, a Markdown brief and an SMS-length digest.

## Architecture, briefly

```
CSV upload  ┐
image/photo ┤
link / text ┼─→ normalize → prefilter → classify → geoparse → UI (no server-side store)
voice (STT) ┘
```

- **Classifier:** Jev via OpenRouter, hit at `/v1/systemone` (typed decisions, not chat
  completions), model pinned to `jev-1.13` and logged back as
  `typesafe/jev-1.13-20260917`. A plain `fetch` client, not a vendor SDK, because
  `laya-serve` exposes the same wire shape and a self-hosted fallback should be a base-URL
  change, not a rewrite.
- **Relevance question:** not one overloaded question but two, `hazard_topic` and
  `response_topic`, combined with `max()`. See `lib/questions.ts` for the full reasoning and
  the measurement that produced it.
- **Geoparser:** a bundled gazetteer (GeoNames Canada places plus First Nations reserve
  polygons, 165 places in total including the world-feed flood regions), no geocoding API, no network call, so it works offline and has no key for a
  judge to trip over.
- **Text generation** (narrative summaries, plain-language mode) runs through the hackathon
  organizers' Gemini proxy. **Images go through OpenRouter instead**, because the proxy
  rejects multipart image payloads with a 422.
- **No server-side persistence.** `/api/classify` is stateless by design: the client posts
  the records it holds and the server keeps nothing, partly because a session map would not
  survive a serverless cold start, and partly because the communities this serves should own
  their own data. The browser keeps a local cache of classification labels and post text
  hashes (IndexedDB) so repeat loads are free; "Clear saved results" and "Wipe everything" in
  the page footer remove it.

Full design, module boundaries and the OCAP privacy stance are in `docs/ARCHITECTURE.md`.

## What is verified, and how

- **The dataset.** 8,024 rows, one `tweet` column, 2013 Alberta floods. `#siksika` appears 30
  times: a First Nation is already present in the data before any classification runs. See
  `docs/ARCHITECTURE.md` section 3.
- **The funnel, on a real run:** 8,024 rows loaded, 7,460 unique after retweet
  normalization, 4,168 worth checking after the local prefilter, roughly 3,748 classified
  relevant, roughly 2,276 of those mapped, roughly 1,472 relevant records that name no place at
  all. That last number is shown in the UI, never hidden. Reproduce the prefilter stage with
  `npx tsx scripts/test-prefilter.ts`.
- **The classifier.** Around 287ms per call, around $0.000033 per call, $0.1369
  to run the whole corpus. `scripts/test-prefilter.ts` also asserts that five
  obviously-relevant rows (a bridge under water, an evacuation, a road closure question) are
  never dropped by the prefilter, and fails the run if any are.
- **The relevance question was tuned by measurement, not guesswork.** Naming the place inside
  the question made separation worse (0.010). Splitting into `hazard_topic` and
  `response_topic` and taking the max moved separation to 0.700 with nothing forced into the
  review queue. Read the full comment block in `lib/questions.ts`.
- **World feed (CE Strategies bonus round).** A 61,159-row file of tweets about many
  disasters, roughly 53,000 unique posts after deduplication. The interface shows a world map
  of flood posts only, with a hazard filter to reveal the other disasters. Not yet measured:
  a full end-to-end run time and cost, and browser responsiveness at this size.
- **Mixed-file handling.** The prefilter measures the hazard mix instead of guessing one
  hazard per file. When two or more hazards each hold at least 15% of mentions, the file is
  "mixed", the pipeline focuses on flood and says so on screen. Run
  `npx tsx scripts/test-mixed.mts` to reproduce the checks (free, no network).
- **The geoparser.** `npx tsx scripts/test-geoparse.ts` runs eleven hand-picked cases
  (landmark aliases, hashtag-compound place names, ambiguous names resolved by context,
  reserve lookup via EXIF) and measures 94% of prefiltered candidates as mappable over the
  real corpus.
- **CSV ingest.** `npx tsx scripts/test-csv-edges.mts` runs 29 table-driven cases against
  encoding (UTF-8 BOM, UTF-16LE, Windows-1252), delimiter sniffing, ragged rows, formula
  injection, coordinate validation and a 50,000-row scale check, because a judge's upload is a
  file this system has never seen before.
- **Export.** `npx tsx scripts/test-export.mts` checks GeoJSON structure and coordinate
  order, that a PII-flagged record never exports its raw text, that CSV formula injection is
  neutralized, RFC 4180 round-tripping, and that the generated brief contains none of the
  banned phrases below.
- **The image front door.** `npx tsx scripts/test-image-path.mts` asserts that every record
  posted to `/api/classify` comes back, including image records, which carry no text and were
  once silently dropped by the text-based prefilter.
- **Link resolution**, verified 2026-09-26: X/Twitter oEmbed and Bluesky's public API both
  return 200 with no auth; a single fediverse status resolves without auth; Reddit and
  Facebook/Instagram are blocked by credential requirements and are named as out of scope,
  not worked around. All `t.co` links in the provided dataset are dead (2013), so the paste
  feature is demoed against a live link instead.

## Honest limits

- No timestamps in the provided dataset, so no temporal spread. Supported if an uploaded file
  has a date column; not faked when it does not.
- Location coverage is partial by nature. The unmappable count is a number shown in the UI,
  not a number hidden from it.
- Reddit and Meta APIs need credentials this project does not have. Named, not worked around.
- All `t.co` links in the provided dataset are dead, so link resolution is demonstrated with a
  live post rather than a row from the file.
- No labelled ground truth exists for this specific event, so confidence is a relative signal
  for routing and review, never a calibrated accuracy figure.
- Self-assessed accessibility. No formal audit, no screen-reader user in the loop. See
  `docs/ACCESSIBILITY.md` for the full list of known gaps.
- A record's classification is a proposal with a confidence attached, never a verified fact.
  This project reports on posts, not on people, and never states a count of people affected.

## Stack

Next.js 16 · React 19 · Tailwind · MapLibre GL · Jev (`jev-1.13`) via OpenRouter for typed
classification · the hackathon organizers' Gemini proxy for text generation · OpenRouter for
image classification and OCR · deployed on Vercel.
