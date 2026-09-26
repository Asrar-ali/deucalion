# Deucalion

**Team Prometheus** · Thunder Bay AI Hackathon, 26 September 2026
**Challenge:** the Living Flood Map, set by CE Strategies

---

## For judges

- **Deployed app:** `<DEPLOY_URL>`
- **Repository:** https://github.com/Asrar-ali/deucalion
- **Judge access code:** `<JUDGE_ACCESS_CODE>`. Enter it in the settings panel. It removes
  the per-session processing budget, so you can load the full dataset, upload your own file
  and re-run classification as many times as you need without being blocked mid-evaluation.

No login, no account, no server-side storage. Loading the sample dataset or uploading your
own is the whole flow.

---

## Inspiration

CE Strategies works with more than 90 First Nation communities across Thunder Bay and
Winnipeg, and owns MapAki, a web-GIS product those communities already use. Their brief was
direct: flood sensors and satellite imagery miss what is happening on the ground. A submerged
road, an impassable bridge, an elder's home taking on water, is usually documented first by a
community member on social media, hours before any official sensor registers it. That
firsthand record sits apart from the GIS layers decision-makers rely on.

We named the project Deucalion. In the myth, Prometheus warned his son Deucalion that the
flood was coming, and Deucalion survived because he was told in time. A sensor tells you
afterwards. A person standing in front of the water tells you now, if anyone is listening.

The provided practice dataset, 8,024 posts from the 2013 Alberta floods, contains 30 posts
tagged `#siksika`. A First Nation was already in the data we were handed. We treated that as
the thread connecting a generic tweet-classification exercise to the sponsor's actual mission,
and built toward it rather than around it.

## What it does

Deucalion takes firsthand public posts about a hazard event and turns them into an auditable,
mappable, accessible picture, then hands the result to the GIS system a community already
uses.

Four front doors feed one pipeline: CSV upload (the provided dataset, or any file a judge
uploads), photo or drone image, a pasted link or block of text, and voice. Every door produces
the same record shape, so the map, table, filters and summaries never need to know where a
record came from.

From there:

1. A **local, free prefilter** removes duplicates and obvious spam before anything is sent to
   a paid model.
2. A **typed classifier** (Jev, via OpenRouter) decides whether each remaining post is
   relevant to the detected hazard, what category it falls into (access blocked, evacuation,
   rescue request, damage, aid, advisory, sentiment), whether it names a place, whether it
   contains personal information, and whether the author is reporting firsthand or resharing
   news. Every answer carries a confidence.
3. A **bundled gazetteer** extracts place names, including First Nations reserve polygons,
   with no geocoding API and no network call.
4. The result renders on an interactive map and in an identical sortable table (the map's
   text equivalent, not a lesser fallback), with a funnel strip showing raw, deduplicated,
   prefiltered, relevant, mapped and "mentions no place" counts, so nothing is silently
   dropped.
5. **Export** produces a GeoJSON layer built for MapAki, a CSV, a Markdown brief and an
   SMS-length digest for anyone without a smartphone.

The classifier is swappable: it speaks a fixed wire protocol, so moving from hosted Jev to a
self-hosted open-weights model is a base-URL change, not a rewrite.

## How we built it

Two builders, one day, a contract frozen before either of us wrote UI or pipeline code. The
seam was `docs/CONTRACT.md` and a set of fixtures: one of us owned `lib/` and the API routes,
the other owned the interface, and neither blocked on the other after the fixtures shipped.

The relevance question was the one piece of the product we refused to guess at. We scored
candidate phrasings against hand-labelled rows from the provided dataset. Naming the event's
place inside the question ("about the ongoing flood emergency in Calgary, High River") made
separation between relevant and irrelevant posts worse, not better, because a real headline
about the same flood that did not happen to name Calgary got hedged down. Splitting the
question in two, one asking about the hazard itself and one asking about the response
(evacuation, rescue, shelter, closure, relief), and taking the maximum of the two, moved
separation from 0.010 to 0.700 with nothing forced into a review queue. Posts like "mandatory
evacuation order issued in Medicine Hat" or "Red Cross reception centre is open" often never
say the word flood at all, and a single overloaded question was losing exactly the operational
reports a responder needs.

The geoparser works the same way in spirit: no geocoding API, so no key for a judge to trip
over, no rate limit, and it keeps working offline. It resolves landmark aliases, place names
hidden inside hashtag compounds, and disambiguates a name like Millennium Park by
co-occurring context, surfacing First Nations communities without ever being asked to look for
them specifically.

We treated the test scripts as part of the submission, not as scaffolding to delete before
judging: `scripts/test-prefilter.ts` measures the real funnel on the provided dataset and
fails the run if a hand-picked, obviously-relevant post (a bridge under water, an active
evacuation) would be dropped. `scripts/test-geoparse.ts` runs eleven cases plus a full-corpus
mappability measurement. `scripts/test-csv-edges.mts` runs 29 cases against encodings,
delimiters, ragged rows and formula injection, because a judge's file is one we have never
seen. `scripts/test-export.mts` checks that a PII-flagged record never exports its original
text and that the generated brief contains none of our banned phrases. `scripts/test-image-path.mts`
exists specifically because of a bug described below.

## Challenges we ran into

**A word boundary silently discarded the most obviously relevant rows in the dataset.** Our
first hazard-detection regex used `\bflood` to match the word "flood" only at a word boundary.
The provided dataset's dominant tags are `#yycflood` and `#abflood`, hashtag compounds with no
boundary between "yyc" and "flood". `\bflood` cannot match inside `#yycflood`. That one detail
silently discarded the 3,192 most obviously relevant rows in the corpus, and it would have
happened quietly, with no error and no crash, if we had not measured the funnel and noticed
the number looked wrong.

**The image front door dropped records with no error.** Image records carry no text until
vision fills it in, and our text-based prefilter treated empty text as nothing to check. Image
rows were silently removed at the prefilter stage and never streamed back to the client, which
then waited indefinitely for rows that would never arrive. `scripts/test-image-path.mts` now
asserts, as an explicit invariant, that every record posted to `/api/classify` comes back,
whatever door it entered through and whether or not vision is available.

**A redirect-following hole in the link resolver.** `fetch()` follows redirects by default.
A public-looking URL can answer with a redirect to `http://169.254.169.254/...` (a cloud
metadata endpoint) or to `127.0.0.1`, and the response body would come straight back to
whoever asked for it. We now follow redirects manually, capped at three hops, and re-run the
private-address check (loopback, `.local`, RFC 1918 ranges) on every single hop, not just the
first request.

**MapLibre's worker did not resolve under the bundler, and the map rendered blank.** MapLibre
6 ships its web worker as a separate module, located relative to `import.meta.url`. Next's
bundler moves the main chunk into its own build output but does not carry the worker file
along with it, so the worker 404s silently and the map area stays empty with no visible error.
Both of us hit this independently, on our own machines, within about an hour of each other,
and both arrived at the same fix: copy the worker file into `public/` before every dev server
and build, and point MapLibre at that stable path. Two people solving the same bug the same
way in under an hour said more about how sharp that particular edge is than either of our
individual debugging sessions did.

## Accomplishments we're proud of

- A relevance question tuned by measurement against hand-labelled data, not by intuition,
  with the actual numbers kept in the codebase (`lib/questions.ts`) as documentation of why it
  is shaped the way it is.
- A funnel that shows every stage, including the count of relevant posts that name no place at
  all, so the map's silence about a post is a disclosed fact rather than a hidden gap.
- A geoparser that surfaced a First Nation community from the data without being told to look
  for one, using nothing but a bundled, offline gazetteer.
- A test suite that treats a judge's unseen file as the normal case, not the edge case, and
  that turned three real production bugs (the word boundary, the image path, the redirect
  hole) into permanent, named regression tests instead of fixes we simply remembered to make.
- No server-side persistence, by design, not by omission, because the communities this project
  is meant to serve should own their own data.

## What we learned

The cheapest-looking mistakes cost the most. A missing word boundary in a regular expression
is a one-character bug, and it silently discarded the 3,192 most obviously relevant rows in an
8,024-row dataset without throwing a single error. The only reason we caught it was that we
had already committed to printing the funnel counts out loud at every stage, so a number that
should have been large looked suspiciously small.

Confidence from a model like this is a routing signal, not a measurement. This model family
returns very high, occasionally exactly 1.000, confidence on clear-cut rows, and we have no
labelled ground truth for this specific event to calibrate against. We chose to present
confidence as relative, useful for deciding what needs a human look and what does not, and
refused to describe it as accuracy.

And a genuinely small decision, splitting one classification question into two and taking the
max, moved measured separation from 0.010 to 0.700, further than any single change in prompt
wording did on its own. The biggest single improvement in the whole project was structural,
not verbal.

## What's next

- Validation against labelled ground truth for a specific real event, with a domain expert,
  before anyone would be asked to trust this in an actual emergency.
- A community data-sharing agreement with a First Nation partner, worked out with them, not
  handed to them, before any live deployment.
- Load testing beyond a single judge's session.
- A fluent-speaker validation pass before shipping any Anishinaabemowin or Oji-Cree interface
  labels; we deliberately shipped none rather than guess with machine translation.
- Reddit and Meta ingestion, blocked today only by credentials we do not have, not by
  anything architectural.
- A formal accessibility audit with a screen-reader user in the loop, to replace the
  self-assessment this submission currently relies on.

---

## Honest limits

This section exists because the honest version of this project is more useful to CE
Strategies than an inflated one.

- **Every label is a proposal with a confidence attached, never a verified fact.** Nothing in
  this system is described as verified or confirmed. A judge should read every classification
  as "the model estimated this with confidence X," not as ground truth.
- **This system reports on posts, not on people.** No number in this project, in the app or in
  this document, states a count of people affected by anything. We have a count of posts.
- **No timestamps exist in the provided dataset**, so there is no temporal spread to show on
  it. A date column in an uploaded file is supported. Nothing is faked to simulate one.
- **Location coverage is partial by nature.** On the real funnel run, roughly 1,472 posts
  classified relevant named no place at all, and that number is displayed in the funnel, not
  hidden from it.
- **Reddit and Meta both need API credentials this project does not have.** That is stated
  plainly, not worked around with a scraper.
- **Every `t.co` link in the provided dataset is dead**, because the dataset is from 2013.
  Link resolution in the demo is shown against a live post, not a row from the file.
- **No labelled ground truth exists for the 2013 Alberta event**, so confidence is presented
  as a relative signal for routing and review, never as a calibrated accuracy figure, and this
  submission never states a bare accuracy percentage.
- **Accessibility here is a self-assessment.** There has been no formal audit and no
  screen-reader user in the loop. The known gaps are listed in full in
  `docs/ACCESSIBILITY.md`.
- **This is batch processing over a provided corpus, not a real-time system,** and we would
  not describe it as ready to deploy in an active emergency tomorrow. It is decision support
  with a human expected in the loop, not a replacement for one.
