# API Contract

**Frozen at 09:45.** Builder B codes the UI against this and the fixtures, without waiting for
Builder A. If this needs to change, say so out loud before changing it.

Types live in `lib/types.ts`. That file is the source of truth; this doc is the wire format.

---

## Fixtures — use these, do not wait for the backend

```
fixtures/records.json   50 fully-classified FloodRecord objects (mix of relevant/irrelevant,
                        mapped/unmapped, high/low confidence, one with PII redacted,
                        one image record with alt text, one inside a reserve polygon)
fixtures/funnel.json    FunnelCounts
fixtures/clusters.json  Cluster[]
fixtures/brief.json     Brief
fixtures/profile.json   EventProfile
```

`NEXT_PUBLIC_USE_FIXTURES=1` makes every client call read fixtures instead of the network.
Keep that switch working all day — it is also the demo fallback if the API dies on stage.

---

## `POST /api/ingest`

`multipart/form-data`, one of:

| Field | Meaning |
|---|---|
| `file` | CSV file |
| `image` | image file (jpg/png/heic) |
| `images` | multiple image files |
| `url` | a link to resolve |
| `text` | raw pasted text (one record per line if `split=lines`) |

Optional: `column` to force which CSV column holds the text.

**Response**

```json
{
  "sessionId": "s_8fj2",
  "records": [{ "id": "r_001", "source": "csv", "text": "...", "labels": {}, "places": [], "review": "auto", "classifier": "jev" }],
  "profile": { "hazard": "flood", "places": ["Calgary", "High River"], "terms": ["flood", "water"], "userEdited": false },
  "funnel": { "raw": 8024, "deduped": 7562, "prefiltered": 0, "relevant": 0, "mappable": 0, "noPlaceMentioned": 0, "rejectedRows": [] },
  "detectedColumns": ["tweet"],
  "chosenColumn": "tweet"
}
```

Records come back **unclassified** (`labels: {}`). Ingest is fast and never calls a model, so
the UI can render the table immediately and fill labels in as classification streams.

Errors are per row, never fatal: `rejectedRows: [{ "row": 412, "reason": "empty text" }]`.
Show them. Do not swallow them.

---

## `POST /api/classify` — Server-Sent Events

```json
{ "sessionId": "s_8fj2", "profile": { "...": "edited profile" }, "byoKey": "optional" }
```

Stream of `data:` lines, each a JSON object with a `type`:

| `type` | Payload | UI action |
|---|---|---|
| `progress` | `{ done, total, stage: "prefilter" \| "classify" \| "geoparse" }` | progress bar + funnel |
| `record` | `{ record: FloodRecord }` | patch that row in place |
| `funnel` | `{ funnel: FunnelCounts }` | update the funnel strip |
| `spend` | `{ spend: SpendState }` | budget meter |
| `degraded` | `{ reason: "402" \| "429" \| "no_key" }` | banner: results are `heuristic` |
| `done` | `{ funnel, spend, modelVersion }` | enable summaries + export |
| `error` | `{ message }` | inline error, keep partial results |

Records arrive in completion order, not input order. Patch by `id`.

---

## `POST /api/summarize`

```json
{ "sessionId": "s_8fj2", "scope": { "kind": "all" | "cluster" | "community" | "filter", "id": "..." }, "narrative": true }
```

**Response** — `{ clusters: Cluster[], brief: Brief }`

`brief.extractive` is always present and never calls a network. `brief.narrative` is absent when
Gemini is unavailable; render the extractive text and do not show an error for that.

Every narrative sentence carries `citedRecordIds`. **Render the citation as a clickable chip.**
A sentence with no citations must not be displayed — that is the anti-fabrication rule.

---

## `POST /api/resolve`

```json
{ "url": "https://x.com/user/status/123" }
```

**Response**

```json
{ "text": "just setting up my twttr", "provenance": { "sourceUrl": "...", "fetchMethod": "oembed", "fetchedAt": "2026-09-26T13:44:00Z", "author": "jack" }, "images": [] }
```

`409` with `{ "needsScreenshot": true, "reason": "blocked" }` when the platform refuses.
The UI then prompts for a screenshot and posts it to `/api/ingest` as `image`.

---

## Client-side only, no endpoint

- **TTS** — `window.speechSynthesis`. Free, offline, no server.
- **STT** — `window.SpeechRecognition` / `webkitSpeechRecognition`. Feature-detect and hide the
  mic when absent. **Disabled in low-bandwidth/sovereignty mode** (Chrome sends audio to Google).
- **Budget display** reads the last `spend` event. Never compute cost in the browser.
- **BYO key** lives in `localStorage` only, is sent per request, and is never logged or persisted
  server-side.

---

## Rules that are not negotiable

1. **Gate on `confidence`**, never on a raw probability or `act_probability`.
2. Anything below `CONFIDENCE_GATE` renders in the **amber/review** state, not as a fact.
3. Never plot a point without `method` and `confidence`.
4. `noPlaceMentioned` is **displayed as a number**. Unmappable records are not hidden.
5. Records where `labels.has_pii.value === true` render `text` (redacted). `rawText` never
   reaches the DOM and never reaches Gemini.
6. Author handles hidden by default, revealable per record.
7. No colour-only encoding anywhere: colour **plus** icon **plus** text label.
