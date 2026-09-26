/**
 * Geoparser checks + measured mappable rate over the real corpus. No network, no cost.
 *   npx tsx scripts/test-geoparse.ts
 */

import { readFileSync } from "node:fs";
import { geoparse, communityRollup, knownPlaceAliases } from "../lib/geoparse";
import { dedupe, detectEventProfile, prefilter } from "../lib/prefilter";

const CASES: Array<{ text: string; expect: string | null; why: string }> = [
  { text: "Glenmore bridge is under water", expect: "Glenmore", why: "landmark alias" },
  { text: "Anyone know if Highway 22 is open? #yycflood", expect: "Highway 22", why: "road + hashtag compound" },
  { text: "flooding everywhere #yycflood", expect: "Calgary", why: "alias hidden inside a hashtag compound" },
  { text: "mandatory evacuation in Medicine Hat", expect: "Medicine Hat", why: "two-word name" },
  { text: "Siksika Nation declared a state of emergency", expect: "Siksika", why: "First Nation + community tag" },
  { text: "High River is gone", expect: "High River", why: "must not degrade to the river named River" },
  { text: "pics of millennium park post flood?", expect: "Millennium Park", why: "ambiguous: Calgary vs Chicago" },
  { text: "millennium park in Calgary was flooded", expect: "Millennium Park, Calgary", why: "context resolves ambiguity" },
  { text: "I love London", expect: "London", why: "ambiguous with no context" },
  { text: "just had the best sandwich", expect: null, why: "no place at all" },
  { text: "Camping tomorrow. That would be fun.", expect: null, why: "no place at all" },
];

let failures = 0;
console.log("case checks\n");
for (const c of CASES) {
  const hits = geoparse({ text: c.text });
  const top = hits[0];
  const ok = c.expect === null ? hits.length === 0 : Boolean(top?.name.includes(c.expect));
  if (!ok) failures++;
  const shown = top
    ? `${top.name} (${top.confidence.toFixed(2)}${top.alternatives ? `, +${top.alternatives.length} alt` : ""}${top.community ? `, community=${top.community.name}` : ""})`
    : "(none)";
  console.log(`  ${ok ? "ok  " : "FAIL"} ${shown.padEnd(52)} ${c.why}`);
  if (!ok) console.log(`       text: ${JSON.stringify(c.text)}  expected: ${c.expect}`);
}

// EXIF path must outrank text and must attribute a community.
const exif = geoparse({ text: "water over the deck", lat: 50.7667, lon: -112.8833, method: "exif" });
const exifOk = exif[0]?.method === "exif" && exif[0]?.community?.name === "Siksika Nation";
if (!exifOk) failures++;
console.log(
  `  ${exifOk ? "ok  " : "FAIL"} EXIF coords -> ${exif[0]?.method}, community=${exif[0]?.community?.name ?? "none"}`,
);

// --- corpus measurement ----------------------------------------------------
const raw = readFileSync(new URL("../public/sample/alberta-2013.csv", import.meta.url), "utf8");
const rows: string[] = [];
let field = "";
let inQuotes = false;
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i];
  if (inQuotes) {
    if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') inQuotes = false;
    else field += ch;
  } else if (ch === '"') inQuotes = true;
  else if (ch === "\n") { rows.push(field.replace(/\r$/, "")); field = ""; }
  else field += ch;
}
if (field) rows.push(field);

const texts = rows.slice(1).filter((t) => t.trim());
const { kept } = dedupe(texts.map((text, i) => ({ id: `r_${i}`, text })));
const profile = detectEventProfile(kept.map((r) => r.text), { knownPlaces: knownPlaceAliases() });
const { candidates } = prefilter(kept, profile);

const parsed = candidates.map((c) => ({ ...c, places: geoparse({ text: c.text }) }));
const mappable = parsed.filter((p) => p.places.length > 0);
const noPlace = parsed.length - mappable.length;

console.log(`\ncorpus (candidates only)`);
console.log(`  candidates          ${parsed.length}`);
console.log(`  mappable            ${mappable.length}  (${Math.round((mappable.length / parsed.length) * 100)}%)`);
console.log(`  mentions no place   ${noPlace}  <- shown in the UI as a number, never hidden`);

const placeCounts = new Map<string, number>();
for (const p of mappable) for (const hit of p.places) placeCounts.set(hit.name, (placeCounts.get(hit.name) ?? 0) + 1);
console.log(`\n  top places:`);
for (const [name, n] of [...placeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(n).padStart(5)}  ${name}`);
}

const communities = communityRollup(mappable);
console.log(`\n  First Nations communities detected:`);
for (const c of communities) console.log(`    ${String(c.count).padStart(5)}  ${c.name}`);

const lowConf = mappable.filter((p) => p.places[0].confidence < 0.5).length;
console.log(`\n  low-confidence placements (<0.50): ${lowConf} -> render as amber/review`);

if (failures) {
  console.error(`\n${failures} case check(s) failed`);
  process.exit(1);
}
console.log(`\nall case checks passed`);
