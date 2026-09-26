/**
 * Generates fixtures/ from real rows in the provided dataset.
 *   node scripts/make-fixtures.mjs
 *
 * Real text, hand-tuned labels. No model calls, so Builder B is never blocked on the API,
 * and NEXT_PUBLIC_USE_FIXTURES=1 stays a working stage fallback all day.
 *
 * Deliberately includes every edge case the UI must render:
 *   irrelevant, spam, low-confidence/review, PII-redacted, no place mentioned,
 *   ambiguous place with alternatives, an image record with alt text,
 *   a point inside a First Nations reserve, and a heuristic-classified record.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CSV = new URL("../public/sample/alberta-2013.csv", import.meta.url);
const OUT = new URL("../fixtures/", import.meta.url);
mkdirSync(OUT, { recursive: true });

// --- parse just enough CSV (quoted fields, one column) ----------------------
const raw = readFileSync(CSV, "utf8");
const rows = [];
let field = "";
let inQuotes = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (inQuotes) {
    if (c === '"' && raw[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') inQuotes = false;
    else field += c;
  } else if (c === '"') inQuotes = true;
  else if (c === "\n") { rows.push(field.replace(/\r$/, "")); field = ""; }
  else field += c;
}
if (field) rows.push(field);
const tweets = rows.slice(1).filter((t) => t.trim().length > 0);

// --- place lookup (a tiny slice of the real gazetteer) ---------------------
const PLACES = {
  calgary: { name: "Calgary, AB", lat: 51.0447, lon: -114.0719 },
  "high river": { name: "High River, AB", lat: 50.5808, lon: -113.8744 },
  canmore: { name: "Canmore, AB", lat: 51.0884, lon: -115.3479 },
  "medicine hat": { name: "Medicine Hat, AB", lat: 50.0405, lon: -110.6764 },
  siksika: { name: "Siksika Nation 146", lat: 50.7667, lon: -112.8833 },
  bragg: { name: "Bragg Creek, AB", lat: 50.9503, lon: -114.5697 },
  okotoks: { name: "Okotoks, AB", lat: 50.7256, lon: -113.9749 },
  lethbridge: { name: "Lethbridge, AB", lat: 49.6956, lon: -112.8451 },
};
const AMBIGUOUS = {
  // Same toponym, several real candidates. The UI must expose the ones we did not pick.
  "millennium park": [
    { name: "Millennium Park, Calgary, AB", lat: 51.0452, lon: -114.0913 },
    { name: "Millennium Park, Chicago, IL", lat: 41.8826, lon: -87.6226 },
  ],
};

const CATS = [
  "access_blocked", "evacuation", "rescue_request",
  "damage", "aid", "advisory", "sentiment",
];

const RULES = [
  // Stems use \w*, never a trailing \b. A \b after a prefix like "evacuat" can never
  // match "evacuated" or "evacuations" because the word continues -- that bug silently
  // emptied the evacuation category on the first run. Same trap applies to prefilter.ts.
  // Order matters: first match wins, so the most operationally specific rule goes first.
  [/\b(?:trapped|stranded|rescue|missing)\w*/i, "rescue_request", 2],
  [/\b(?:evacuat|displac|shelter|reception centre)\w*/i, "evacuation", 2],
  [/\b(?:bridge|road|highway|closed|closure|impassable|detour)\w*|washed out/i, "access_blocked", 2],
  [/\b(?:damag|destro|ruin|collaps|submerg)\w*|under water/i, "damage", 1],
  [/\b(?:donat|volunteer|fundrais|sandbag)\w*|red cross|yychelps/i, "aid", 1],
  [/\b(?:warning|advisory|mandatory)\w*|do not|please avoid|state of emergency|boil water/i, "advisory", 2],
];

const SPAM = /#job|#hiring|we are hiring|apply now|taco|tequila|check in|i'm at /i;
const FLOODY = /flood|yycflood|abflood|water|river|evacuat|rain|submerg|sandbag/i;

function classify(text) {
  const spam = SPAM.test(text);
  const floody = FLOODY.test(text);

  let category = "sentiment";
  let severity = 0;
  for (const [re, cat, sev] of RULES) {
    if (re.test(text)) { category = cat; severity = sev; break; }
  }

  const places = [];
  const lower = text.toLowerCase();
  for (const [key, list] of Object.entries(AMBIGUOUS)) {
    if (lower.includes(key)) {
      const [pick, ...alts] = list;
      places.push({
        ...pick, confidence: 0.42, method: "gazetteer",
        alternatives: alts.map(({ name, lat, lon }) => ({ name, lat, lon })),
      });
    }
  }
  if (!places.length) {
    for (const [key, p] of Object.entries(PLACES)) {
      if (lower.includes(key)) {
        places.push({
          ...p,
          confidence: key === "calgary" ? 0.94 : 0.81,
          method: "gazetteer",
          ...(key === "siksika"
            ? { community: { name: "Siksika Nation", id: "430" } }
            : {}),
        });
        break;
      }
    }
  }

  // Confidence deliberately varied so the UI must render amber/review states.
  const relConf = spam ? 0.91 : floody ? 0.88 : 0.34;
  const d = (value, confidence, extra = {}) => ({ value, confidence, ...extra });

  return {
    labels: {
      relevant: d(floody && !spam, relConf),
      hazard: d(floody ? "flood" : "other", floody ? 0.93 : 0.55),
      category: d(category, category === "sentiment" ? 0.48 : 0.76),
      severity: d(severity, 0.61),
      has_place: d(places.length > 0, places.length ? 0.86 : 0.72),
      is_request: d(/\b(help|need|anyone know|please)\b/i.test(text), 0.58),
      has_pii: d(false, 0.95),
      is_spam: d(spam, spam ? 0.89 : 0.93),
      firsthand: d(!/^RT |http/i.test(text), 0.64),
    },
    places,
  };
}

// --- pick a spread: relevant, irrelevant, spam, placed, unplaced -----------
const wanted = [
  ...tweets.filter((t) => /bridge|road|closed/i.test(t)).slice(0, 8),
  ...tweets.filter((t) => /evacuat/i.test(t)).slice(0, 6),
  ...tweets.filter((t) => /siksika/i.test(t)).slice(0, 4),
  ...tweets.filter((t) => /donat|yychelps|red cross/i.test(t)).slice(0, 6),
  ...tweets.filter((t) => /high river|canmore|medicine hat/i.test(t)).slice(0, 6),
  ...tweets.filter((t) => /millennium park/i.test(t)).slice(0, 2),
  ...tweets.filter((t) => SPAM.test(t)).slice(0, 5),
  ...tweets.filter((t) => !FLOODY.test(t) && !SPAM.test(t)).slice(0, 8),
  ...tweets.filter((t) => FLOODY.test(t)).slice(0, 5),
];
const seen = new Set();
const picked = wanted.filter((t) => !seen.has(t) && seen.add(t)).slice(0, 48);

const records = picked.map((text, i) => {
  const { labels, places } = classify(text);
  return {
    id: `r_${String(i + 1).padStart(3, "0")}`,
    source: "csv",
    text,
    labels,
    places,
    review: labels.relevant.confidence < 0.6 ? "auto" : "auto",
    classifier: "jev",
    modelVersion: "typesafe/jev-1.13-20260917",
    duplicateCount: 1,
  };
});

// Two hand-authored records for cases the CSV cannot supply.
records.push({
  id: "r_049",
  source: "image",
  text: "Photo submitted from the ground. Water over the deck of the bridge.",
  imageRef: "/sample/demo-bridge.jpg",
  imageAlt:
    "Brown floodwater covering a two-lane concrete bridge deck, guardrail partly submerged, overcast sky.",
  timestamp: "2013-06-21T14:12:00Z",
  provenance: { fetchMethod: "manual", fetchedAt: "2026-09-26T14:12:00Z" },
  labels: {
    relevant: { value: true, confidence: 0.96 },
    hazard: { value: "flood", confidence: 0.97 },
    category: { value: "access_blocked", confidence: 0.88 },
    severity: { value: 2, confidence: 0.79 },
    has_place: { value: true, confidence: 0.99 },
    is_request: { value: false, confidence: 0.81 },
    has_pii: { value: false, confidence: 0.9 },
    is_spam: { value: false, confidence: 0.97 },
    firsthand: { value: true, confidence: 0.92 },
  },
  // EXIF is the highest-confidence geo tier: exact, not inferred.
  places: [
    { name: "EXIF coordinates", lat: 50.5772, lon: -113.8741, confidence: 1, method: "exif" },
  ],
  review: "confirmed",
  classifier: "jev",
  modelVersion: "typesafe/jev-1.13-20260917",
});

records.push({
  id: "r_050",
  source: "link",
  // PII-redacted: rawText is deliberately absent so it can never leak to the DOM or to Gemini.
  text: "Checking on [name redacted] at [address redacted] — no answer since the water came up.",
  provenance: {
    sourceUrl: "https://x.com/example/status/000",
    fetchMethod: "oembed",
    fetchedAt: "2026-09-26T14:20:00Z",
    author: "redacted",
  },
  labels: {
    relevant: { value: true, confidence: 0.83 },
    hazard: { value: "flood", confidence: 0.86 },
    category: { value: "rescue_request", confidence: 0.71 },
    severity: { value: 2, confidence: 0.68 },
    has_place: { value: false, confidence: 0.55 },
    is_request: { value: true, confidence: 0.9 },
    has_pii: { value: true, confidence: 0.94 },
    is_spam: { value: false, confidence: 0.96 },
    firsthand: { value: true, confidence: 0.74 },
  },
  places: [],
  review: "auto",
  // Circuit breaker was open for this one: results must be visibly labelled heuristic.
  classifier: "heuristic",
});

const mappable = records.filter((r) => r.places.length > 0).length;
const relevant = records.filter((r) => r.labels.relevant?.value).length;

const funnel = {
  raw: 8024,
  deduped: 7562,
  prefiltered: 4487,
  relevant: 3218,
  mappable: 906,
  noPlaceMentioned: 2312,
  rejectedRows: [
    { row: 412, reason: "empty text column" },
    { row: 5891, reason: "duplicate of row 5104" },
  ],
};

const profile = {
  hazard: "flood",
  places: ["Calgary", "High River", "Canmore", "Medicine Hat"],
  terms: ["flood", "yycflood", "abflood", "water", "evacuation", "sandbag"],
  userEdited: false,
};

const CLUSTER_LABELS = {
  access_blocked: "roads and bridges blocked",
  evacuation: "evacuation and shelter",
  rescue_request: "requests for help",
  damage: "property and infrastructure damage",
  aid: "donations and volunteers",
  advisory: "official advisories",
  sentiment: "solidarity and commentary",
};

// Clusters are DERIVED from the records, never hardcoded. Hardcoded ids drift the
// moment the sample changes, and a cluster pointing at the wrong rows is worse
// than no cluster.
const byCategory = new Map();
for (const r of records) {
  if (!r.labels.relevant?.value) continue;
  const cat = r.labels.category?.value;
  if (!cat) continue;
  if (!byCategory.has(cat)) byCategory.set(cat, []);
  byCategory.get(cat).push(r);
}

const clusters = [...byCategory.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([cat, rs], i) => {
    const placeCounts = new Map();
    for (const r of rs)
      for (const pl of r.places)
        placeCounts.set(pl.name, (placeCounts.get(pl.name) ?? 0) + 1);
    return {
      id: `c_${i + 1}`,
      label: CLUSTER_LABELS[cat] ?? cat,
      recordIds: rs.map((r) => r.id),
      size: rs.length,
      representativeIds: rs.slice(0, 2).map((r) => r.id),
      topPlaces: [...placeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => ({ name, count })),
    };
  });

// Every narrative sentence must cite records that exist. A sentence with no
// citations is not rendered -- that is the anti-fabrication rule, enforced here
// rather than trusted.
const narrative = clusters
  .slice(0, 3)
  .map((c) => ({
    sentence:
      `${c.size} relevant posts report ${c.label}` +
      (c.topPlaces.length ? `, most often naming ${c.topPlaces[0].name}` : "") +
      ".",
    citedRecordIds: c.recordIds.slice(0, 3),
  }))
  .filter((n) => n.citedRecordIds.length > 0);

const brief = {
  extractive:
    "3,218 of 8,024 posts were classified as related to flooding in southern Alberta. " +
    "The largest themes are donations and volunteering (337 posts), road and bridge closures (412), " +
    "and evacuation or displacement (147). 906 posts name a place specific enough to map; " +
    "2,312 relevant posts mention no place at all and are listed but not plotted. " +
    "30 posts reference Siksika Nation.",
  narrative,
  plainLanguage:
    "About 3,200 of 8,000 posts are about the flood. Most talk about donations, closed roads, and people leaving their homes. " +
    "About 900 posts say exactly where. 30 posts are about Siksika Nation.",
};

const write = (name, data) => {
  writeFileSync(new URL(name, OUT), JSON.stringify(data, null, 2) + "\n");
  console.log(`fixtures/${name}`);
};

const ids = new Set(records.map((r) => r.id));
const dangling = [
  ...clusters.flatMap((c) => [...c.recordIds, ...c.representativeIds]),
  ...narrative.flatMap((n) => n.citedRecordIds),
].filter((id) => !ids.has(id));
if (dangling.length) throw new Error(`dangling record ids: ${dangling.join(", ")}`);
if (narrative.some((n) => n.citedRecordIds.length === 0))
  throw new Error("a narrative sentence has no citations");

write("records.json", records);
write("funnel.json", funnel);
write("clusters.json", clusters);
write("brief.json", brief);
write("profile.json", profile);

console.log(
  `\n${records.length} records | ${relevant} relevant | ${mappable} with places | ` +
    `${records.filter((r) => r.labels.has_pii?.value).length} PII-redacted | ` +
    `${records.filter((r) => r.classifier === "heuristic").length} heuristic`,
);
