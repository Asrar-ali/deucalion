# Demo script: three minutes

Memorised, not read. Times are cumulative. Based on the draft in `docs/WORKPLAN.md`, corrected
against the measured funnel and cost numbers in `docs/ARCHITECTURE.md`.

Rehearse this out loud, timed, at least three times before 16:15.

---

## Opening hook (0:00–0:15)

Say this close to word for word:

> "Kashechewan has been evacuated fourteen times since 2004. When the water comes, the first
> record of a submerged road is a post from someone standing in front of it. That record
> never reaches the people drawing the maps. This is Deucalion. It closes that gap."

## Beat 1: Load (0:15-0:35)

One click: load the provided 2013 Alberta dataset. The funnel fills on screen as it runs.

> "Eight thousand and twenty-four posts. The funnel shows every stage, nothing dropped
> silently: seven thousand four hundred and sixty after removing duplicates and retweets,
> four thousand one hundred and sixty-nine worth checking after a free local filter, roughly
> one thousand eight hundred and seventy classified relevant. That whole classification pass
> costs well under twenty cents."

Do not round further than this. If asked for an exact figure live, say "roughly" and move on;
the exact run numbers are in `docs/ARCHITECTURE.md` and `docs/SUBMISSION.md`, not memorised
digits to defend under pressure.

## Beat 2: Explore (0:35-1:15)

Filter to `access_blocked`. Map clusters appear. Click a point and open the detail panel.

> "Every point tells you how it got there and how sure the system is. This gauge isn't
> accuracy, it's distance from a coin flip. Below the line, it goes to a review queue instead
> of onto the map as fact."

Show the table view briefly as the map's identical text equivalent, not a lesser fallback.

## Beat 3: The Siksika beat (1:15-1:45)

> "The dataset they gave us already contains a First Nation."

Click the reserve overlay.

> "Thirty posts mention Siksika Nation. The gazetteer found the community on its own. We
> didn't tell it to look for one."

## Beat 4: Paste a live link (1:45-2:05)

Paste a live X post (not a `t.co` link from the dataset; every one of those is dead, since the
dataset is from 2013). It resolves, classifies, and lands on the map. Hand the laptop to a
judge.

> "Paste anything. If a platform blocks us, it falls back to a screenshot and OCR instead of
> dead-ending."

## Beat 5: Generalisation (2:05-2:25)

Upload an unseen CSV with different column names and a different hazard word.

> "The detected event changes on screen. Nothing about flooding is hardcoded for a
> single-event file. The same pipeline runs on an earthquake file with no code change. A file
> that mixes disasters is handled in the bonus segment below."

## Beat 6: Trust and destination (2:25-2:50)

Point at the unmappable count in the funnel, the review queue, and the export panel.

> "This number of relevant posts that name no place isn't hidden, it's counted. Everything
> here exports as a GeoJSON layer that drops straight into MapAki. Their GIS is the
> destination. We're not building a competitor to it."

## Close (2:50–3:00)

> "Ninety-plus First Nation communities already work with CE Strategies. This runs on a
> laptop, costs cents, and stores nothing after the tab closes."

---

## Bonus round segment: the world feed (60-90 seconds)

Run this after Beat 6 if time allows, or as its own segment if the judges ask for the bonus
round. Times are relative to the start of the segment.

1. **Load (0:00-0:15).** Load the world feed. About 53,000 unique posts after removing
   duplicates and retweets.
   > "New file, from all over the world, several disaster types. Same pipeline."
2. **The message (0:15-0:30).** Point at the notice saying the file mixes several disasters.
   > "It measured the file. Storm posts are 53% of the hazard mentions, flood 32%. It does not
   > pretend this is a flood file. It says so, and it focuses on flood because that is the
   > task."
3. **Flood-only default (0:30-0:45).** Show the map with only flood posts.
   > "Our first version guessed one hazard for the whole file. It guessed storm, and real flood
   > posts scored 0.08 against a 0.15 threshold and vanished. That is fixed."
4. **Hazard filter (0:45-1:00).** Open the hazard filter and reveal the other disasters.
   > "Nothing is thrown away. The other disasters are one click away."
5. **World-scale map (1:00-1:15).** Zoom out to the world view, then into Queensland, then
   Colorado. Click a cluster.
   > "Queensland dominates, Colorado and the Philippines follow. That is where the flood posts
   > are, by keyword. The map is honest about being lopsided."
6. **Limits (1:15-1:30).**
   > "We have not timed a full run of this file end to end, and we have not tested the browser
   > on 53,000 rows in a live tab. We have no labelled ground truth, so we do not quote an
   > accuracy number."

If the full classification is not finished, say so and show what has streamed so far. Do not
promise a finish time. None has been measured.

---

## Do NOT demo

- The login screen. There isn't one, and there shouldn't be a pause where a judge wonders if
  one is missing.
- The settings page, beyond the low-data and font toggles if directly asked about
  accessibility.
- A tech-stack slide. Say the stack once if asked in Q&A; do not build a beat around it.
- Any `t.co` link from the provided CSV. They are all dead. Use a live link prepared in
  advance.
- Anything requiring venue wifi as a single point of failure. Have the fixture-mode fallback
  (`?demo=1`) ready, and the recorded fallback video as the last resort.

---

## Q&A prep

**"How accurate is it?"**
Give the confidence distribution and the review-queue count, not a bare percentage. There is
no labelled ground truth for this specific event, so "accurate" without a number beside it is
a phrase we deliberately don't use. Say instead: "roughly 3,748 of the 4,168 checked posts
were classified relevant, and anything below the confidence line goes to a human before it is
shown as anything more than a proposal."

**"Would you deploy this in an emergency tomorrow?"**
"No. It's decision support with a human in the loop. What's missing: validation against
labelled ground truth for a specific real event, a community data-sharing agreement, and load
testing beyond a single judge's session."

**"What if it's wrong?"**
"Low confidence routes to a human before anything is mapped as certain. The failure mode we
designed for is extra review work, never a false certainty presented as fact."

**"What does this cost to run?"**
"The classifier is metered per call from the provider's own reported cost, not an estimate.
Roughly $0.000033 per call, about 287 milliseconds. The full corpus, all 8,024 rows, runs for
$0.1369 total. A local, free prefilter removes obvious duplicates and spam
before anything paid runs at all, so most of that cost is never spent."

**"What's in the review queue, and who looks at it?"**
"Any answer below its confidence threshold, sorted lowest-confidence first, doubling as the
review queue in the table view. Nobody looks at it automatically today, that's community
judgment we're not going to simulate. A person marks a record checked or rejects it, and that
action is appended to a client-side audit log."

**"What happens if the model is unavailable?"**
"A circuit breaker watches for repeated rate-limit or billing errors from the provider. When
it trips, the app degrades to the local keyword prefilter and labels those results
`heuristic`, visibly, rather than guessing with a model that isn't responding. The extractive
summary never depends on a model at all, it's built by clustering and counting, so it always
renders even when every network call fails."

**"Where does the data go?"**
"Nowhere, by default. Processing is ephemeral, there's no server-side persistence,
personally identifying content is redacted before display and before any third-party call, and
there's a one-click wipe. Anything sent to the hackathon's Gemini proxy or to OpenRouter for
image classification is out of our hands the moment it's sent, so redaction happens before
that call, not after."

**"What did you cut?"**
Name the cut list with the same confidence as everything else. In priority order, cuttable if
the classify stream stalled by 11:00: Gemini narrative summaries (the extractive summary
already works without a model), the image and vision path, the link resolvers, the First
Nations overlay. None of CSV ingest, classification, the map, the funnel counts or the
deployment itself were ever on that list.

**"How do you know it is a flood post?"**
"We do not know. The classifier proposes that a post is flood-related and attaches a
confidence. A local prefilter first removes duplicates and posts with no flood signal, then a
typed classifier scores the rest. Anything below the confidence line goes to review instead of
onto the map as fact. There is no labelled ground truth for this file, so we do not state an
accuracy number."

**"What about Bangladesh?"**
"924 posts name Bangladesh. 617 of them are about a building collapse. None mention flooding.
So it is correctly absent from the flood map."

**"Why not just search for the word flood?"**
"Keyword scoring against one guessed hazard dropped real flood posts on this file, because
storm vocabulary outnumbers flood vocabulary there. Flood posts do not always use the word,
and a word search would also pull in metaphors and news resharing. We use keyword counts to
measure the file and to cut cost, and a classifier to decide relevance. The place counts we
quote are keyword matches, not classifications."
