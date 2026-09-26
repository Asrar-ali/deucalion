/**
 * Test for lib/export.ts, run over the 46 real-classified fixtures plus a handful of
 * synthetic edge-case records (formula injection, RFC 4180 special characters, a PII
 * record with a rawText field present, an author field).
 *   npx tsx scripts/test-export.mts
 *
 * .mts because top-level await requires it -- npx tsx compiles a bare .ts as CJS here, and
 * CJS has no top-level await.
 */

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { toBriefMarkdown, toCsv, toGeoJSON, toSmsDigest } from "../lib/export";
import { buildExtractiveBrief, clusterRecords } from "../lib/summarize";
import type { Brief, EventProfile, FloodRecord, FunnelCounts } from "../lib/types";

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

const fixtures: FloodRecord[] = JSON.parse(
  readFileSync(new URL("../fixtures/records.json", import.meta.url), "utf8"),
);
console.log(`=== fixtures: ${fixtures.length} records loaded`);

// ---------------------------------------------------------------------------
// Synthetic edge-case records -- kept separate from the fixtures so the fixture-based
// counts (item 3) are never polluted by records invented for this test.
// ---------------------------------------------------------------------------

const formulaRecord: FloodRecord = {
  id: "syn_formula",
  source: "csv",
  text: "=cmd|'/c calc'!A1",
  labels: { relevant: { value: true, confidence: 0.9 }, category: { value: "access_blocked", confidence: 0.8 } },
  places: [{ name: "Test Point", lat: 51.05, lon: -114.07, confidence: 0.7, method: "gazetteer" }],
  review: "auto",
  classifier: "jev",
};

const specialCharsRecord: FloodRecord = {
  id: "syn_special",
  source: "csv",
  text: 'Water at 5th, "Main" St\nrising fast',
  labels: { relevant: { value: true, confidence: 0.9 }, category: { value: "damage", confidence: 0.8 } },
  places: [{ name: "5th and Main", lat: 51.02, lon: -114.05, confidence: 0.6, method: "gazetteer" }],
  review: "auto",
  classifier: "jev",
};

const piiRecord: FloodRecord = {
  id: "syn_pii",
  source: "link",
  text: "[name redacted] needs help at [address redacted]",
  rawText: "John Smith needs help at 123 Real Street",
  labels: {
    relevant: { value: true, confidence: 0.9 },
    category: { value: "rescue_request", confidence: 0.8 },
    has_pii: { value: true, confidence: 0.95 },
  },
  places: [{ name: "Somewhere", lat: 50.9, lon: -114.1, confidence: 0.5, method: "gazetteer" }],
  review: "auto",
  classifier: "jev",
};

const authorRecord: FloodRecord = {
  id: "syn_author",
  source: "link",
  text: "Bridge closed at Main St",
  provenance: { sourceUrl: "https://example.com/post/1", fetchMethod: "oembed", author: "someuser" },
  labels: { relevant: { value: true, confidence: 0.9 }, category: { value: "access_blocked", confidence: 0.8 } },
  places: [{ name: "Main St Bridge", lat: 51.03, lon: -114.06, confidence: 0.8, method: "gazetteer" }],
  review: "auto",
  classifier: "jev",
};

const multiPlaceRecord: FloodRecord = {
  id: "syn_multiplace",
  source: "csv",
  text: "Flooding reported in both Calgary and Canmore today",
  labels: { relevant: { value: true, confidence: 0.9 }, category: { value: "damage", confidence: 0.7 } },
  places: [
    { name: "Calgary, AB", lat: 51.0447, lon: -114.0719, confidence: 0.9, method: "gazetteer" },
    { name: "Canmore, AB", lat: 51.0884, lon: -115.3479, confidence: 0.8, method: "gazetteer" },
  ],
  review: "auto",
  classifier: "jev",
};

// ---------------------------------------------------------------------------
// 1 + 2: GeoJSON structure and [lon, lat] coordinate order
// ---------------------------------------------------------------------------

console.log("\n=== toGeoJSON: structural validity");
const relevantFixtures = fixtures.filter((r) => r.labels.relevant?.value === true);
const geo = toGeoJSON(relevantFixtures);

assert(geo.collection.type === "FeatureCollection", "collection.type is FeatureCollection");
assert(Array.isArray(geo.collection.features), "collection.features is an array");
assert(
  geo.collection.features.every((f) => f.type === "Feature" && f.geometry.type === "Point"),
  "every feature is a Point Feature",
);
assert(
  geo.collection.features.every((f) => Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length === 2),
  "every feature has a 2-element coordinate array",
);
assert(geo.collection.bbox !== undefined && geo.collection.bbox.length === 4, "bbox is present with 4 elements");

console.log("\n=== toGeoJSON: [lon, lat] coordinate order (Calgary, r_003)");
const calgaryFeature = geo.collection.features.find((f) => f.properties.id === "r_003");
assert(!!calgaryFeature, "r_003 (Calgary) produced a feature");
if (calgaryFeature) {
  const [lon, lat] = calgaryFeature.geometry.coordinates;
  console.log(`  r_003 coordinates: [${lon}, ${lat}]`);
  assert(lon < -100 && lon > -120, `first element is longitude near -114 (got ${lon})`);
  assert(lat > 45 && lat < 55, `second element is latitude near 51 (got ${lat})`);
}

// ---------------------------------------------------------------------------
// 3: feature count vs resolved places; omission count vs relevant-records-with-no-place
// ---------------------------------------------------------------------------

console.log("\n=== toGeoJSON: feature count and omission count against real fixture counts");
const expectedFeatureCount = relevantFixtures.reduce((n, r) => n + r.places.length, 0);
const expectedOmitted = relevantFixtures.filter((r) => r.places.length === 0).length;
console.log(`  relevant fixtures: ${relevantFixtures.length}, expected features: ${expectedFeatureCount}, expected omitted: ${expectedOmitted}`);

assert(geo.collection.features.length === expectedFeatureCount, "feature count equals the number of resolved places");
assert(geo.omittedNoPlace === expectedOmitted, "omittedNoPlace equals the number of relevant records with no place");

console.log("\n=== toGeoJSON: a record naming two places yields two features");
const multi = toGeoJSON([multiPlaceRecord]);
assert(multi.collection.features.length === 2, "one record with two places produced two features");
assert(multi.omittedNoPlace === 0, "no omissions when the record has places");

// ---------------------------------------------------------------------------
// 4: no rawText, no author unless includeAuthors
// ---------------------------------------------------------------------------

console.log("\n=== toGeoJSON: never rawText, author only when includeAuthors");
const allGeoText = JSON.stringify(geo.collection);
assert(!allGeoText.includes("rawText"), "no feature in the full fixture export contains the key rawText");

const authorDefault = toGeoJSON([authorRecord]);
assert(
  authorDefault.collection.features[0]?.properties.author === undefined,
  "author is absent by default (includeAuthors not set)",
);
const authorIncluded = toGeoJSON([authorRecord], { includeAuthors: true });
assert(
  authorIncluded.collection.features[0]?.properties.author === "someuser",
  "author appears when includeAuthors is true",
);

// ---------------------------------------------------------------------------
// 5: a PII-flagged record exports its redacted text, never the original
// ---------------------------------------------------------------------------

console.log("\n=== toGeoJSON: PII record exports redacted text only");
const piiGeo = toGeoJSON([piiRecord]);
const piiProps = piiGeo.collection.features[0]?.properties;
assert(piiProps?.text === piiRecord.text, "exported text equals the redacted display text");
assert(!JSON.stringify(piiGeo.collection).includes("John Smith"), "the original name never appears in the export");
assert(!JSON.stringify(piiGeo.collection).includes("rawText"), "the rawText key never appears in the export");

// ---------------------------------------------------------------------------
// 6: CSV formula-injection safety
// ---------------------------------------------------------------------------

console.log("\n=== toCsv: formula injection is neutralized");
const formulaCsv = toCsv([formulaRecord]);
const formulaRows = Papa.parse<Record<string, string>>(formulaCsv.replace(/^﻿/, ""), { header: true }).data;
const formulaText = formulaRows[0]?.text ?? "";
console.log(`  raw csv text field: ${JSON.stringify(formulaText)}`);
assert(formulaText.startsWith("'="), "the dangerous cell is prefixed with a single quote, not left as a bare '='");
assert(!formulaText.startsWith("=cmd"), "the cell no longer starts with a live formula prefix");

// ---------------------------------------------------------------------------
// 7: RFC 4180 round-trip through papaparse
// ---------------------------------------------------------------------------

console.log("\n=== toCsv: comma/quote/newline round-trip via papaparse");
const specialCsv = toCsv([specialCharsRecord]);
const specialRows = Papa.parse<Record<string, string>>(specialCsv.replace(/^﻿/, ""), { header: true }).data;
console.log(`  round-tripped text field: ${JSON.stringify(specialRows[0]?.text)}`);
assert(specialRows[0]?.text === specialCharsRecord.text, "comma, quote and newline all round-trip exactly");

// ---------------------------------------------------------------------------
// 8: UTF-8 BOM
// ---------------------------------------------------------------------------

console.log("\n=== toCsv: starts with a UTF-8 BOM");
assert(toCsv(relevantFixtures).charCodeAt(0) === 0xfeff, "csv output starts with the BOM code point");

// ---------------------------------------------------------------------------
// 9 + 10: brief markdown -- real counts, Siksika mention, no kill phrases
// ---------------------------------------------------------------------------

console.log("\n=== toBriefMarkdown: real counts, Siksika Nation, kill phrases");
const clusters = clusterRecords(fixtures);
const extractive = buildExtractiveBrief(fixtures, clusters);
const brief: Brief = { extractive };
const profile: EventProfile = { hazard: "flood", places: ["Calgary", "High River", "Canmore"], terms: [], userEdited: false };
const mappableFixtures = relevantFixtures.filter((r) => r.places.length > 0);
const funnel: FunnelCounts = {
  raw: fixtures.length,
  deduped: fixtures.length,
  prefiltered: fixtures.length,
  relevant: relevantFixtures.length,
  mappable: mappableFixtures.length,
  noPlaceMentioned: relevantFixtures.length - mappableFixtures.length,
  rejectedRows: [],
};
const markdown = toBriefMarkdown(fixtures, clusters, brief, profile, funnel);
console.log("\n----- generated brief -----\n");
console.log(markdown);
console.log("\n----- end brief -----\n");

assert(markdown.includes(`${relevantFixtures.length} classified relevant`), "brief states the real relevant count");
assert(
  markdown.includes(`${relevantFixtures.length - mappableFixtures.length} mention no place at all`),
  "brief states the real no-place count",
);
assert(markdown.includes("Siksika Nation"), "brief names Siksika Nation, present in the fixtures");

const killPhraseRegex = /\bverified\b|\bconfirmed\b|\breal-time\b|\baccurate\b|detected a flood at/i;
const peopleClaimRegex = /\b\d[\d,]*\s*(?:people|residents|persons|individuals|families)\b/i;
assert(!killPhraseRegex.test(markdown), "brief contains none of the section-8 kill phrases");
assert(!peopleClaimRegex.test(markdown), "brief never states a number of people affected");
assert(!markdown.includes("NaN"), "brief contains no NaN");

// ---------------------------------------------------------------------------
// 11: SMS digest -- character cap and no mid-word truncation
// ---------------------------------------------------------------------------

console.log("\n=== toSmsDigest: character cap respected, no mid-word cut");
const smsFull = toSmsDigest(relevantFixtures, 480);
console.log(`  full digest (480 cap, ${smsFull.length} chars): ${smsFull}`);
assert(smsFull.length <= 480, "default-length digest respects the 480 char cap");
assert(!smsFull.endsWith(" "), "digest has no trailing space");

const singleForTruncation: FloodRecord[] = [
  {
    id: "syn_sms",
    source: "csv",
    text: "Family stuck on the roof, need a boat now",
    labels: { relevant: { value: true, confidence: 0.9 }, category: { value: "rescue_request", confidence: 0.9 } },
    places: [{ name: "Elbow Park", lat: 50.99, lon: -114.08, confidence: 0.8, method: "gazetteer" }],
    review: "auto",
    classifier: "jev",
  },
];
const smsHeader = `Flood update, 1 auto-classified post(s):`;
const smallCap = smsHeader.length - 3;
const truncated = toSmsDigest(singleForTruncation, smallCap);
console.log(`  header: "${smsHeader}" (${smsHeader.length} chars), cap: ${smallCap}, truncated: "${truncated}"`);
assert(truncated.length <= smallCap, `truncated digest respects the ${smallCap}-char cap`);
assert(smsHeader.startsWith(truncated), "truncated digest is a clean prefix of the untruncated header");
const nextChar = smsHeader[truncated.length];
assert(nextChar === undefined || nextChar === " ", "truncation stopped at a word boundary, not mid-word");

// ---------------------------------------------------------------------------
// 12: every function behaves sanely on an empty record array
// ---------------------------------------------------------------------------

console.log("\n=== empty input: no crash, no NaN, no \"0 of 0\" nonsense");
const emptyGeo = toGeoJSON([]);
assert(emptyGeo.collection.features.length === 0, "toGeoJSON([]) yields zero features");
assert(emptyGeo.collection.bbox === undefined, "toGeoJSON([]) omits bbox entirely");
assert(emptyGeo.omittedNoPlace === 0, "toGeoJSON([]) reports zero omissions");

const emptyCsv = toCsv([]);
assert(emptyCsv.charCodeAt(0) === 0xfeff, "toCsv([]) still starts with the BOM");
assert(emptyCsv.split("\r\n").length === 1, "toCsv([]) is header-only, no data rows");
assert(!emptyCsv.includes("NaN"), "toCsv([]) contains no NaN");

const emptyBrief = toBriefMarkdown(
  [],
  [],
  { extractive: "" },
  { hazard: "other", places: [], terms: [], userEdited: false },
  { raw: 0, deduped: 0, prefiltered: 0, relevant: 0, mappable: 0, noPlaceMentioned: 0, rejectedRows: [] },
);
console.log(`  empty brief: ${JSON.stringify(emptyBrief)}`);
assert(!emptyBrief.includes("NaN"), "toBriefMarkdown([]) contains no NaN");
assert(!emptyBrief.includes("0 of 0"), 'toBriefMarkdown([]) does not print "0 of 0"');
assert(!killPhraseRegex.test(emptyBrief), "toBriefMarkdown([]) still contains no kill phrases");

const emptySms = toSmsDigest([]);
console.log(`  empty sms: ${JSON.stringify(emptySms)}`);
assert(emptySms === "No records to report.", "toSmsDigest([]) returns a clean, honest message");
assert(!emptySms.includes("NaN"), "toSmsDigest([]) contains no NaN");

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
