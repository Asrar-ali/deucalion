/**
 * Measures the real funnel on the provided dataset. No network, no cost.
 *   npx tsx scripts/test-prefilter.ts
 */

import { readFileSync } from "node:fs";
import { dedupe, detectEventProfile, prefilter, scoreRelevance } from "../lib/prefilter";

const raw = readFileSync(
  new URL("../public/sample/alberta-2013.csv", import.meta.url),
  "utf8",
);

// minimal single-column CSV parse with quoted fields
const rows: string[] = [];
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

const texts = rows.slice(1).filter((t) => t.trim());
const records = texts.map((text, i) => ({ id: `r_${i}`, text }));

const KNOWN_PLACES = [
  "Calgary", "High River", "Canmore", "Medicine Hat", "Siksika", "Bragg Creek",
  "Okotoks", "Lethbridge", "Banff", "Airdrie", "Cochrane", "Turner Valley",
  "Black Diamond", "Drumheller", "Edmonton", "Toronto", "Chicago",
];

console.log(`raw rows                ${texts.length}`);

const t0 = Date.now();
const { kept, removed } = dedupe(records);
console.log(`after dedupe            ${kept.length}  (-${removed})`);

const profile = detectEventProfile(
  kept.map((r) => r.text),
  { knownPlaces: KNOWN_PLACES },
);
console.log(`\ndetected hazard         ${profile.hazard}`);
console.log(`detected places         ${profile.places.join(", ") || "(none)"}`);
console.log(`top terms               ${profile.terms.slice(0, 14).join(", ")}`);

const { candidates, dropped } = prefilter(kept, profile);
const ms = Date.now() - t0;

console.log(`\nprefilter candidates    ${candidates.length}`);
console.log(`dropped                 ${dropped.length}`);
console.log(`  of which spam         ${dropped.filter((d) => d.prefilter.likelySpam).length}`);
console.log(`elapsed                 ${ms}ms (local, $0)`);

const perCall = 0.0000336; // measured later by smoke.mjs; 4-question placeholder
console.log(
  `\nprojected paid calls    ${candidates.length} instead of ${texts.length} ` +
    `(saves ${Math.round((1 - candidates.length / texts.length) * 100)}%)`,
);

console.log(`\ntop 5 candidates:`);
for (const c of candidates.slice(0, 5)) {
  console.log(`  ${c.prefilter.score.toFixed(2)} ${JSON.stringify(c.text.slice(0, 74))}`);
  console.log(`       ${c.prefilter.reasons.join(" | ")}`);
}

console.log(`\n5 dropped (check for false negatives — these are the expensive mistake):`);
for (const d of dropped.slice(0, 5)) {
  console.log(`  ${d.prefilter.score.toFixed(2)} ${JSON.stringify(d.text.slice(0, 74))}`);
}

// Records a human would obviously keep. If any of these score below threshold, the
// prefilter is too aggressive and we are losing real reports.
const MUST_KEEP = [
  "Glenmore bridge is under water, do not try it",
  "we are evacuating now, water is in the basement",
  "Anyone know if Highway 22 is open? #yycflood",
  "Siksika Nation has declared a state of emergency",
  "my mom is stranded on Memorial Drive, please help",
];
console.log(`\nsanity — must-keep rows:`);
let failures = 0;
for (const t of MUST_KEEP) {
  const s = scoreRelevance(t, profile);
  const ok = !s.likelySpam && s.score >= 0.15;
  if (!ok) failures++;
  console.log(`  ${ok ? "keep" : "LOST"}  ${s.score.toFixed(2)}  ${t.slice(0, 56)}`);
}
if (failures) {
  console.error(`\n${failures} must-keep rows would be dropped. Threshold is too high.`);
  process.exit(1);
}
