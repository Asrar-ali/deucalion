# Deucalion

The living flood map for First Nations communities and emergency responders. Built for the
Thunder Bay AI Hackathon by team Prometheus, for the challenge set by CE Strategies.

People standing in front of floodwater post about it long before a sensor reports it.
Deucalion finds those posts, places them on a map and turns them into something a community
can act on.

## Who it is for

- **Community members:** see whether flooding is reaching your area.
- **Community leaders:** see which places and roads are affected and what to act on first.
- **Emergency responders:** see the most urgent posts first, with how sure we are about each place.
- **CE Strategies, as operator:** take the exported results into its own flood models and platforms.

## What it does

- Upload a CSV, paste text or a link, or add photos.
- Finds the flood posts and places them on a map, with filters and a written summary.
- Answers questions about the data, with citations to the posts behind each answer.
- Exports GeoJSON, CSV and a short brief.
- Dark theme, legible font, large touch targets, low-data mode, full keyboard use and screen reader support.
- Works on a file it has never seen. Given a worldwide file about many disasters, it focuses on floods and says so.

## How it works

- Jev makes typed decisions to classify each post, and every answer carries a confidence.
- A local prefilter removes noise for free before any model is called.
- A bundled gazetteer recognizes places, including First Nations reserves, with no geocoding service.
- Gemini writes the summary and the answers to questions.
- Results stream to the screen live as they are classified.

Every result is a proposal with a confidence, never a confirmed fact.

## Run it locally

```bash
cp .env.example .env.local   # add your keys
npm install
npm run dev
```

Environment variables: `OPENROUTER_API_KEY`, `SYSTEMONE_BASE_URL`, `SYSTEMONE_MODEL`,
`GEMINI_API_KEY`, `GEMINI_PROXY_BASE_URL`, `GEMINI_MODEL`, `VISION_MODEL`, `JUDGE_ACCESS_CODE`.
The rest in `.env.example` are optional tuning.

No keys? Set `NEXT_PUBLIC_USE_FIXTURES=1` (or visit with `?demo=1`) to run entirely on bundled,
pre-classified sample data — no network calls, nothing to configure. The hosted demo runs this way.

Next: connecting to CE Strategies' flood models through the CSV and GeoJSON export.

Detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
