# Deucalion

**Team Prometheus** · Thunder Bay AI Hackathon, 26 September 2026
**Challenge:** the Living Flood Map, set by CE Strategies

- **Deployed app:** `<DEPLOY_URL>`
- **Repository:** https://github.com/Asrar-ali/deucalion
- **Judge access code:** `<JUDGE_ACCESS_CODE>` (enter it in the settings panel)

## Pitch

Deucalion is the living flood map for First Nations communities and emergency responders. It
takes firsthand public posts, finds the ones about flooding, places them on an interactive map
and lets people filter, read a summary and ask questions, with every answer cited to the posts
behind it. Results export as GeoJSON and CSV for CE Strategies' platforms. No login, and
nothing is stored on the server.

## The challenge and our answer

Sensors and satellites miss what is happening on the ground. A submerged road or an elder's
home taking on water is usually documented first by a person on social media. We built the
missing layer.

- Accept a CSV, provided or uploaded by a judge: done, plus text, links and photos.
- Classify each record as flood-related or not: done, with a confidence on every one.
- Explore with filters and a summary: done, with a question box that cites its sources.
- Extract places and plot them on an interactive map: done, including First Nations reserves.
- Deployed online: done.

## The demo, in 90 seconds

1. **Alberta sample (0:00 to 0:45).** Load the Alberta 2013 sample. Posts stream in and the
   map fills live. Filter by category, open a post, read the summary, ask a question and
   follow the citations.
2. **World feed (0:45 to 1:30).** Load the 61,159-row worldwide file covering many disasters.
   Deucalion says the file is mixed and focuses on floods. Zoom from the world view into a
   region, then export the layer.

## Judging criteria

**Accuracy and speed**
- The 61,159-row world file processes in about 20 to 40 seconds end to end.
- About 11,000 posts go to the model, at roughly $0.37 for the full run.
- In a random sample of 30 mapped flood posts, 27 were clearly about flooding.
- Exact counts in Ask are computed in code over all loaded posts, not estimated by the model.

**UI and UX**
- Every stage of the funnel is shown as a count, so nothing is dropped silently.
- Results are cached in the browser, so a repeat load is instant and free.
- Dark theme, legible font, large touch targets and a low-data mode for weak connections.

**Interesting features**
- Four ways in: CSV, pasted text or link, photos, and speech.
- A ring layer marks First Nations communities across Canada.
- A file that mixes many disasters is handled by focusing on floods and saying so.
- Exports for CE Strategies: GeoJSON, CSV and a short brief.

**Relevance**
- Built for the communities CE Strategies serves, with First Nations reserves in the gazetteer.
- Keyboard operable, skip link, screen reader friendly, with an accessibility statement page.
- Nothing is stored on the server, so data control stays with the user.
- Every result is a proposal with a confidence, so people decide what to act on.

## Next

Connecting to CE Strategies' flood models through the CSV and GeoJSON export.

## Team

Team Prometheus, two builders: Asrar Ali and Huzaifa Muaz.
