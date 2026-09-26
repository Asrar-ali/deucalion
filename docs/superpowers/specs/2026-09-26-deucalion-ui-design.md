# Deucalion UI: design spec

**Owner:** Builder B · **Date:** 2026-09-26 · **Status:** awaiting review
**Freeze:** 15:00 · **Submit:** 16:30

The approved interface design. It sits on top of `docs/ARCHITECTURE.md`, `docs/CONTRACT.md`
and `docs/ACCESSIBILITY.md`, and does not repeat them. Where this spec and those docs
disagree, the docs win, and this file gets corrected.

---

## 1. Intent

**Outcome:** a deployed, single-page interface where a judge loads the provided dataset, or
their own unseen CSV, and within a minute can filter the relevant posts, read a summary, see
where activity is concentrated on a map, and see how sure the system is about every claim.

**Who it serves:** judges today, and the audience the brief names: community members, band-office
staff and emergency coordinators, often on a phone, outdoors, on satellite internet.

**Success criteria (these are the brief's four requirements, all P0):**
1. Accept a CSV, either the provided sample or an upload.
2. Show a related/unrelated decision for every post.
3. Let users explore relevant posts with filters, plus an overview or summary.
4. Plot the posts' locations on an interactive map.

**Constraints:**
- No login and no server-side state.
- The UI works against sample data until the live routes are wired.
- Never blocked by missing backend work: the UI sends fields the backend may not read yet,
  and they are harmless until it does.

## 2. Visual direction

**Base:** Builder A's tokens (`app/globals.css`) and trust primitives
(`components/Signals.tsx`) are adopted as they stand. That covers Geist, the signal-blue
accent, the status tones and the Phosphor icons.

**Colour carries urgency tier; icon and shape carry category.** Measured: no set of 7
categorical colours stays distinct across protanopia, deuteranopia and tritanopia (the best
possible minimum CIEDE2000 is 14.4), so colour is never asked to identify a category on its
own.

**The one bold element is the Staff Gauge, which replaces `ConfidenceMeter`.** It is a
vertical graduated meter modelled on a river staff gauge.

| Part | Spec |
|---|---|
| Frame | 1.5px `--text` border, 2px radius, tick every 0.1 on the right edge, longer tick at 0.5 |
| Fill | `--accent`, rising from the bottom to the confidence |
| Review line | `--review`, with a 1px `--text` outline, extending 4px past the frame. Its position is the per-answer `CONFIDENCE_GATE` from `lib/questions.ts` (relevance 0.6, category 0.5, hazard 0.5) |
| Number | Always visible, tabular figures |
| Sizes | `sm` 12×40 (list rows), `lg` 20×92 (detail panel), `xs` 8×24 (table cells) |

**States:**

| State | Condition | Appearance |
|---|---|---|
| measured | confidence ≥ the answer's threshold | solid fill |
| below | confidence < the answer's threshold | `--review`/`--text` diagonal stripes, plus the text "Needs checking" |
| no-reading | `classifier === "heuristic"` | empty, dashed frame, "Keyword match, not measured" |
| pending | no labels yet | empty, faint frame |
| checked | `review === "confirmed"` | solid fill with a cap mark, "Checked by a person" |
| rejected | `review === "rejected"` | no fill, frame struck through |

**Labels state the answer:** "Sure it's about the flood: 0.88", "Sure it's not about the flood: 0.91".
Confidence is distance from a coin flip, not a measure of relevance.

**Accessibility:** `role="meter"`, with `aria-valuetext` giving the answer, the value and
whether it is above or below the review line.

**Motion:** the only automatic motion in the app is each gauge filling over about 300ms when
its result arrives. It is removed entirely under `prefers-reduced-motion`.

**Copy rules:**
- Sentence case, plain verbs, no em-dashes.
- No ALL-CAPS eyebrows, no middle-dot metadata strings.
- Category labels come from `CATEGORY_META`.
- Kill phrases from ARCHITECTURE §8 are banned.

## 3. Screens

There is one route, `/`, which is the workspace. `/accessibility` is the statement page.

```
┌ Deucalion  [Flooding in southern Alberta, edit]      Load data  Export  Settings ┐
│ Funnel sentence + proportional bars                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Map] [Table] [Summary] [Communities]   category toggles · Seen firsthand ·    │
│                                         Needs checking                          │
├───────────────────────────────────────────────────────┬──────────────────────┤
│ active view                                            │ report list, or the  │
│                                                        │ detail panel         │
└───────────────────────────────────────────────────────┴──────────────────────┘
```

On a phone, the tabs become a segmented control and the right panel becomes a bottom sheet
over the map.

| # | Screen | Contents | Priority |
|---|---|---|---|
| 1 | Start | Primary action "Load the Alberta 2013 dataset (8,024 posts)". Also: upload a CSV; add photos (a caption per photo, which becomes the alt text); paste a link or text; speak a report (P2). "Nothing is stored. Close the tab and it's gone." A collapsed judge code / own-key field | P0 (sample + CSV) · P1 (link, photos) |
| 2 | Processing | The funnel sentence counts live, gauges fill, "Using column `tweet`. Change", the rejected rows listed, a fallback banner | P0 |
| 3 | Map | Canvas-drawn markers (urgency tone and category icon), a dashed outline for markers below the line, clusters, reserves drawn as points with 25km proximity rings labelled "proximity, not a boundary", keyboard navigation | P0 |
| 4 | Table | The same filtered set. Sortable by gauge, category, place and urgency. Sorting by gauge, lowest first, doubles as the review queue | P0 |
| 5 | Summary | The extractive brief (always), cluster labels, terms and representative posts, narrative sentences with citation chips when present, a plain-language toggle, print | P0 extractive · P1 narrative |
| 6 | Communities | `communityRollup()`: posts per First Nation, each with "Show on map" | P1 |
| 7 | Detail panel | Large relevance gauge, small category and location gauges, `via` reason, place with method, `kind` and alternatives, "Mark as checked" / "Not about the flood", read aloud, reveal author | P0 core · P1 actions |
| 8 | Export | GeoJSON (MapAki layer), CSV, brief, SMS digest via `/api/export`; audit log (client-side JSON); **Wipe everything** | P1 |
| 9 | Settings | Theme, legible font, large touch targets, low-data mode, EN/FR | P2 (theme and low-data are P1) |

## 4. Data flow

**Store:** `client/store.ts`, using `useSyncExternalStore` with no new dependency. It holds:
`records` (map by id plus an ordered id list), `profile`, `funnel`, `spend`, `status`
(`idle | ingesting | classifying | done | error`), `degradedReason`, `modelVersion`,
`filters`, `selectedId`, `view`, `auditLog`, `summaryCache` (keyed by a filter hash), and
`settings`. Only `settings`, the access code and the user's own key persist, in
`localStorage` wrapped in try/catch.

**API interface:** `client/api.ts` defines `ingest`, `classify` (a stream with
`onEvent` and an abort handle), `summarize`, `resolve` and `exportFile`.
- **Live:** `fetch`, with a POST stream parsed from a `ReadableStream`
  (`client/sse.ts`), because `EventSource` cannot POST.
- **Sample:** replays `fixtures/*` as a stream over about 3 seconds.
- **Selection:** `NEXT_PUBLIC_USE_FIXTURES=1` **or `?demo=1`**. The URL switch is the
  stage fallback and needs no redeploy.

**Sequence:**
1. Load sample: `GET /sample/alberta-2013.csv`, then `POST /api/ingest`. Render the rows
   immediately, with pending gauges.
2. `POST /api/classify { records, profile, accessCode?, byoKey? }`. Patch rows by id on
   `record`, update `funnel` and `spend` on those events, and finish on `done` or when every
   record has come back.
3. The Summary view calls `POST /api/summarize { records (relevant only, no imageRef), scope, narrative: true }` once per filter hash.
4. Editing the event profile re-classifies after a confirmation (it costs money).
5. Review actions mutate `record.review` locally and append `{id, action, at}` to `auditLog`.
6. Wipe clears the store and all persisted keys.

**Photos:**
- The browser reads GPS with `exifr`, downscales to about 1600px JPEG (which also strips
  EXIF), and sends `image`, `caption`, `lat` and `lon`.
- Screenshots get OCR in the browser (`tesseract.js`, lazy-loaded) and are sent as `text`
  with `fetchMethod=ocr`.
- The current ingest ignores the extra fields, so this degrades safely. The backend asks are
  in the handoff to Builder A.

**Map:**
- **Library:** MapLibre with OpenFreeMap styles (positron for light, dark for dark).
- **Rendering:** a GeoJSON source with clustering, drawn by canvas layers.
- **Keyboard:** a single focusable HTML marker follows the arrow-key position through the
  visible points. Enter opens the detail panel, and each move is announced in a live region.
- **Low-data mode:** no tiles, just a plain background style.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Rejected CSV rows | List of row number and reason. A column picker when detection is uncertain |
| Stream drops | Processed rows stay. "Stopped at X of Y. Resume" re-sends only the records still pending |
| `degraded` | Banner "Using local keyword rules only". Affected gauges show no-reading |
| Budget blocked | Panel with judge code, own key and mailto (the text from `blockedMessage`) |
| No narrative | Render the extractive brief only, with no error shown |
| `resolve` 409 | "This site blocks us. Upload a screenshot instead", followed by browser OCR |
| Map tiles fail | Switch to the plain style automatically |

Every state change is announced through a single `aria-live="polite"` region.

## 6. Testing

- **Logic, test-first:** `scripts/test-ui-*.mts` (tsx, repo style) covering the store
  reducer, the SSE parser, filter selectors and gauge state resolution.
- **UI:** Playwright screenshots at 1280 and 390 widths, in light and dark.
- **Accessibility:** the 8-step checklist in ACCESSIBILITY.md, at 14:45.
- **End to end:** a small CSV against the live routes, then the full 8,024-row sample on the
  Vercel deployment.

## 7. Out of scope

- RBAC and login. Access control belongs in MapAki, and we store nothing.
- Server-side persistence.
- Anishinaabemowin and Oji-Cree labels without a fluent validator.
- Temporal charts, since the provided dataset has no timestamps.

## 8. Dependencies to add

- `tesseract.js`, lazy-loaded, P1.
- Nothing else. MapLibre, `exifr`, Phosphor and papaparse are already installed.
