# Deucalion — Architecture & Design Spec

**Team Prometheus** (2 builders) · Thunder Bay AI Hackathon, 2026-09-26
**Challenge sponsor:** CE Strategies · **Status:** approved design, build in progress

> Canonical design document. Approved before implementation began.

---

## 1. The problem

CE Strategies (Thunder Bay + Winnipeg, founded 2010 by Jordan Shannon, 90+ First Nation
community partnerships, owner of the MapAki web-GIS product) states the gap plainly:

> Flood monitoring relies on sensors and satellite imagery, and those tools miss what is
> happening on the ground. A submerged road, an impassable bridge, or an elder's home taking
> on water is often documented first by community members on social media, well before any
> official sensor registers it. That firsthand record sits apart from the GIS layers and risk
> maps decision-makers rely on.

Context: Kashechewan First Nation evacuated 14+ times since 2004. Red Earth Cree Nation
evacuated 600+ members this spring. Peguis First Nation is considering relocating whole
neighbourhoods.

**Our job:** turn firsthand public posts into an auditable, mappable, accessible situational
picture a community can operate itself — and hand the result to the GIS system they already use.

## 2. Required capabilities (from the brief)

1. Accept a CSV of posts — provided dataset or **custom upload by judges**
2. Classify each record as related / unrelated to the disaster event
3. Interface to explore relevant records — filtering + overview/summary
4. Extract and plot geographic locations on an interactive map
5. **Deployed online.** Local-only demos are not accepted.

## 3. The provided dataset (measured, not assumed)

| Property | Value |
|---|---|
| Rows | 8,024 |
| Unique | 7,460 (564 removed: 462 exact + retweets of the same body) |
| Columns | 1 — `tweet` |
| Length | min 17 / mean 104.8 / **max 147 (hard-truncated)** |
| Event | 2013 Alberta floods |
| Top tags | `#yycflood` 1884 · `#abflood` 1308 · `#yyc` 529 · `#calgary` 186 |
| Places | Calgary 1672 · High River 99 · Medicine Hat 30 · Canmore 22 |
| Impact terms | water 367 · river 338 · evacuat 147 · bridge 124 · road 85 · damage 79 |
| Response terms | donat 337 · red cross 126 · `#yychelps` 106 |
| Noise | `#job` 118 · `#hiring` 113 · roleplay/novel fragments · restaurant check-ins |
| **`#siksika`** | **30 — a First Nation is already in this dataset** |
| Links | 3,027 rows contain `http`; **all `t.co` links are dead (2013)** |
| Absent | timestamps · author · coordinates · labels |

### Consequences for design

- **No timestamps** → no temporal spread on this dataset. We support a date column if an
  uploaded file has one. We do not fake it.
- **Hashtags are a trap.** `#yycflood` + `#abflood` alone label 3,192 of 8,024. That scores
  well today and collapses on the judges' unseen file. Relevance must generalise.
- **The unseen dataset may not be a flood.** Hazard type is inferred, never hardcoded.
- **`#siksika`** is the thread connecting this dataset to the sponsor's actual mission.

## 4. Architecture

### 4.1 Four front doors, one record

```
CSV upload  ─┐
image/photo ─┤
link / text ─┼─→ normalize → prefilter → Jev classify → geoparse → memory store → UI
voice (STT) ─┘
```

Every door produces the same `Record`. The map, table, filters, summaries and exports never
learn where a record came from.

### 4.2 The funnel (counts shown in the UI — no silent drops)

Measured on the provided dataset (`npx tsx scripts/test-prefilter.ts`):

```
8,024 raw
  → dedupe / normalize        7,460   (-564: 462 exact + retweets of the same body)
  → local prefilter           4,168   candidates, 107ms, $0, 148 dropped as spam
  → Jev typed decisions        3,748   relevant, 43.9s and $0.1369 for the whole corpus
  → geoparse + EXIF            2,276   mappable + 1,472 "no place mentioned"
```

The prefilter halves the paid calls. Its threshold is deliberately generous: a false
positive costs a fraction of a cent, a false negative silently loses a report from
someone standing in floodwater. `scripts/test-prefilter.ts` asserts that five
obviously-relevant rows survive, and fails the run if any are dropped.

### 4.3 Classifier — Jev via OpenRouter

Typed decisions do **not** use chat completions. That is the `404`/shape trap.

```http
POST https://openrouter.ai/api/v1/systemone
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```

```json
{ "model": "jev-1.13",
  "state": "Glenmore bridge is under water, do not try it",
  "questions": { "relevant": { "type": "noul", "instructions": "..." } } }
```

```json
{ "id": "gen-dec-...", "model": "typesafe/jev-1.13-20260917", "provider": "TypeSafe",
  "answers": { "relevant": { "type": "noul", "noul": 0.98 } },
  "usage": { "input_tokens": 275, "output_tokens": 20, "cost": 0.00003 } }
```

Facts that constrain the implementation:

- Pin `jev-1.13`. Never send the console id `jev-1.13.0`. Log the response `model` field so the
  submission can state the exact version audited.
- **$0.042 / M input tokens, output free.** Context on OpenRouter is **32k** (native is 64k).
- **P50 latency 0.26s.** Concurrency 20 → ~60s for the corpus; 40 → ~30s.
- Errors: `429` → our backoff · `402` → OpenRouter credit · `401` → wrong host/key ·
  `404`/shape → a chat SDK was used by mistake.
- **Plain `fetch` client, not the vendor SDK.** `laya-serve` exposes this identical
  `/v1/systemone` shape, so the fallback is a base-URL swap. Coupling to the SDK throws that away.

**Measured cost: ~$0.000033 per call at 4 questions (~500 input tokens), avg latency ~287ms,
model `typesafe/jev-1.13-20260917`. Over the full corpus, the 4,168 candidates that reached
the classifier took 43.9 seconds wall clock and cost $0.1369 total.**

Token spend is dominated by the 9 question definitions repeating on every call. Terse
`instructions` and `criteria` are a direct 2–3x cost lever.

### 4.4 The 10 questions (`lib/questions.ts` — the product lives here)

| Key | Type | Purpose |
|---|---|---|
| `hazard_topic` | noul | About the hazard itself |
| `response_topic` | noul | About the response: evacuation, rescue, shelter, closure, relief |
| *(derived)* `relevant` | — | **max(hazard_topic, response_topic)** — see the measurement below |
| `hazard` | choice | flood / fire / quake / storm / other → feeds event profile |
| `category` | choice | access-blocked · evacuation · rescue-request · damage · aid · advisory · sentiment |
| `severity` | score | 3 coarse levels (score is the weakest primitive — keep it coarse) |
| `has_place` | noul | Gates the geoparser |
| `is_request` | noul | Surfaces actionable posts |
| `has_pii` | noul | **Privacy gate** — redact before display and before any Gemini call |
| `is_spam` | noul | Kills recruiter/commercial noise |
| `firsthand` | noul | First-hand vs retweet/news — the sponsor's core thesis |

#### Relevance was measured, not guessed

`scripts/tune-relevance.mjs` and `tune-relevance2.mjs` scored candidate phrasings against
hand-labelled rows from the provided dataset. Total cost of the experiment: **$0.001**.

| Phrasing | Separation | Forced into review queue |
|---|---|---|
| "about the ongoing flood emergency in Calgary, High River" | 0.010 | 4/15 |
| topical framing ("would someone monitoring this want to read it") | 0.010 | 6/15 |
| hazard + explicit inclusions | 0.300 | 6/15 |
| hazard topic only | 0.360 | 2/18 |
| **max(hazard_topic, response_topic)** | **0.700** | **0/18** |

Two findings worth keeping:

1. **Naming the place in the question made it worse.** A headline reading "Floods displace
   nearly 200,000 in western Canada" was hedged down to 0.57 because it does not say
   Calgary. Place belongs to the geoparser, not to the relevance question.
2. **Response posts often never name the hazard.** "Mandatory evacuation order issued in
   Medicine Hat" scores hazard 0.49 / response 0.98. "Red Cross reception centre is open"
   scores 0.53 / 0.94. A single overloaded question loses both — and they are exactly the
   operational reports a responder needs.

Observed model behaviour also worth recording: `category` returned confidence of exactly
1.000 on clear-cut rows. This model family ships over-confident and expects temperature
calibration against labelled data, which we do not have for this event. So confidence is
presented as a **relative** signal for routing and review, never described as calibrated.

Rules, taken from the documented failure modes of this model family:

- Gate on **`confidence`**, never `act_probability` (AUROC 0.30 vs 0.77).
- **Never use boolean labels in `choice`** — the model follows label text over descriptions.
- Keep choice sets under ~20 options.
- Do not ask it about dates or numbers. Documented weakness.

### 4.5 Event profile — how we generalise

Derived from the corpus, shown to the user, editable:

> Detected event: **flooding**, southern Alberta — Calgary, High River, Canmore. *Edit →*

`relevance = informativeness x similarity(record, event profile)`

An earthquake CSV works with no code change, and the judge watches it adapt.

Mixed files (bonus round). Detection picks one hazard, which is wrong for a file that mixes
disasters. A file is "mixed" when two or more hazards each hold at least 15% of hazard
mentions. For a mixed file the prefilter focuses on flood (`focusProfile`) and stops crediting
other hazards' vocabulary, and the UI states that it did so. An explicit "flooding only" choice
takes priority. See `scripts/test-mixed.mts`.

### 4.6 Geoparser

Priority order, each point carrying `method` + `confidence`:

1. `provided` — lat/lon or place column in the upload
2. `exif` — image GPS. Exact. Highest-confidence tier.
3. `gazetteer` — toponym match against a bundled gazetteer: GeoNames Canada places +
   **First Nations reserve polygons** (NRCan Aboriginal Lands of Canada; Ontario GeoHub
   First Nation Reserve — both open, GeoJSON)
4. Ambiguous → keep all candidates, disambiguate by co-occurring places, expose alternatives
5. None → **explicit "mentions no place: n" bucket, displayed as a number**

No geocoding API: no key for judges to trip over, no rate limits, works offline.

### 4.7 Link resolution (verified working 2026-09-26)

| Source | Endpoint | Status |
|---|---|---|
| X / Twitter | `publish.x.com/oembed?url=...&omit_script=1` | OK 200, no auth (`publish.twitter.com` 301s) |
| Bluesky | `public.api.bsky.app/xrpc/app.bsky.feed.getPostThread` | OK 200, no auth, includes image embeds |
| Fediverse | `<instance>/api/v1/statuses/<id>` | OK 200 (public *timeline* needs auth; single status does not) |
| Reddit | `.../.json` | BLOCKED 403 — needs OAuth app creds. Out of scope. |
| Facebook / Instagram | oEmbed | BLOCKED — App Review + business verification. Out of scope. |
| Anything else | readability extraction | article / notice text |
| **Blocked / deleted / protected** | **screenshot → Gemini OCR** | never dead-ends |

The platform where First Nations flood posts actually live (Facebook) is the one that locks its
API. That is precisely why the screenshot path exists — say so in the pitch.

### 4.8 Summaries

- **Extractive, always:** cluster relevant records, label clusters by distinctive terms, show
  representative posts + counts. Deterministic, instant, cannot fabricate.
- **Gemini narrative, layered on:** every sentence cites the record IDs it came from.
  Unsupported sentences are dropped, not softened. PII-redacted input only.
- If Gemini is down the extractive layer still renders. The app never blanks.

### 4.9 Spend control

OpenRouter returns real `usage.cost` per call, so we meter actual spend, not estimates.

| Layer | Behaviour |
|---|---|
| Default budget | **$2.00 / session** ~ 80,000 records |
| Judge code | Unlimited. Published in the writeup so judges can never be blocked. |
| BYO key | User pastes their own OpenRouter key — browser-held, sent per request, never logged or stored |
| Over budget | Panel with `mailto:` + request code |
| Global | Daily ceiling + kill switch in env |
| Circuit breaker | On `402` / repeated `429` → degrade to local prefilter, label results `heuristic` |

**No row cap.** A judge must never be blocked mid-evaluation.

## 5. Module boundaries

```
lib/systemone.ts    Jev client. fetch only. baseURL + model from env.   <- swappable for laya
lib/questions.ts    The 9 typed questions. Pure data. No HTTP.
lib/prefilter.ts    Dedupe + event-profile similarity. Local, free, instant.
lib/geoparse.ts     Gazetteer + EXIF + confidence + method. Never touches the network.
lib/resolve.ts      Per-platform link adapters -> text. ~20 lines each.
lib/vision.ts       Gemini: image classify + alt text, one call.
lib/summarize.ts    Extractive clusters (always) + Gemini narrative (optional, cited).
lib/types.ts        Record shape. The one contract both of us code against.
lib/budget.ts       Session spend meter, judge code, BYO key, circuit breaker.
data/gazetteer.json GeoNames CA places + First Nations reserve polygons.
app/api/ingest      CSV / image / link -> normalized records
app/api/classify    SSE stream: prefilter -> Jev -> geoparse
app/api/summarize   Cluster labels + optional narrative
app/api/resolve     Single link -> text + provenance
```

Seams that matter: `systemone.ts` knows nothing about floods. `questions.ts` knows nothing about
HTTP. `geoparse.ts` makes no network calls. The UI consumes one record shape whether the source
was a CSV row or a drone photo.

## 6. Privacy & data sovereignty (OCAP)

CE Strategies works with 90+ First Nation communities; MapAki sells private, password-protected
maps. So:

- **No server-side persistence by default.** Processing is ephemeral.
- **A results cache lives in this browser only** (IndexedDB, `lib/resultCache.ts`). It holds
  classification labels and a SHA-256 hash of each post's text, never the text itself, so a
  repeat load is free. Only paid ("jev") results are cached, capped at 200,000 entries. The
  "Clear saved results" button and "Wipe everything" in the page footer both remove it.
- PII redacted before display and before any Gemini call (`has_pii` gate).
- Author handles hidden by default, revealable per record.
- One-click export, one-click wipe.
- Append-only decision log — the audit artifact.
- **GeoJSON export is a MapAki layer.** Their product is the destination, not a competitor.

## 7. Honest limits (state these out loud)

- Every label is a **proposal with a confidence**, never verified ground truth.
- No timestamps in the provided dataset → no temporal spread. Supported if uploaded.
- 462 duplicates, 147-char truncation — deduped and disclosed.
- Location coverage is partial by nature; the unmappable count is shown, not hidden.
- Reddit and Meta need credentials we do not have — named, not hidden.
- All `t.co` links in the provided dataset are dead; the paste feature is demoed with a live link.
- Chrome speech recognition sends audio to Google → disabled in low-bandwidth/sovereignty mode.

## 8. Kill phrases — never ship these words

- "verified" / "confirmed" about any classified record
- "X people were affected" — we have posts, not people
- "the model detected a flood at <place>" → say "n posts mentioning <place> were classified
  flood-related, mean confidence 0.8"
- "real-time" — this is batch over a provided corpus
- "accurate" without a number beside it
