/**
 * Test for lib/summarize.ts, run over the 46 real-classified fixtures.
 *   npx tsx scripts/test-summarize.mts
 *
 * .mts because top-level await requires it -- npx tsx compiles a bare .ts as CJS here, and
 * CJS has no top-level await.
 */

import { readFileSync } from "node:fs";
import {
  clusterRecords,
  buildExtractiveBrief,
  communityBrief,
  narrate,
  plainLanguage,
  enforceCitations,
} from "../lib/summarize";
import type { FloodRecord } from "../lib/types";

// Minimal .env.local loader, same as scripts/smoke.mjs and scripts/test-routes.mts.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}

const records: FloodRecord[] = JSON.parse(
  readFileSync(new URL("../fixtures/records.json", import.meta.url), "utf8"),
);
const allIds = new Set(records.map((r) => r.id));

console.log(`=== fixtures: ${records.length} records loaded`);

// ---------------------------------------------------------------------------
// 1 + 2: clustering, printed and checked
// ---------------------------------------------------------------------------

console.log("\n=== clusterRecords");
const clusters = clusterRecords(records);

for (const c of clusters) {
  console.log(`\n[${c.id}] ${c.label}  (size ${c.size})`);
  console.log(`  representatives: ${c.representativeIds.join(", ")}`);
  console.log(`  top places: ${c.topPlaces.map((p) => `${p.name}(${p.count})`).join(", ") || "(none)"}`);
}

assert(clusters.length > 0, "at least one cluster was produced");
assert(
  clusters.every((c) => c.size > 0 && c.recordIds.length === c.size),
  "no empty clusters; size matches recordIds.length",
);
assert(
  clusters.every((c) => c.recordIds.every((id) => allIds.has(id))),
  "every cluster.recordIds entry exists in the input",
);
assert(
  clusters.every((c) => c.representativeIds.every((id) => allIds.has(id))),
  "every cluster.representativeIds entry exists in the input",
);
assert(
  clusters.every((c) => c.representativeIds.every((id) => c.recordIds.includes(id))),
  "every representative is actually a member of its own cluster",
);
assert(
  clusters.every((c) => c.representativeIds.length >= Math.min(2, c.size)),
  "clusters with 2+ members produce at least 2 representatives",
);

const relevantCount = records.filter((r) => r.labels.relevant?.value === true).length;
const noPlaceCount = records.filter(
  (r) => r.labels.relevant?.value === true && r.places.length === 0,
).length;

// ---------------------------------------------------------------------------
// 3: extractive brief + community brief
// ---------------------------------------------------------------------------

console.log("\n=== buildExtractiveBrief");
const extractive = buildExtractiveBrief(records, clusters);
console.log(extractive);

assert(
  extractive.includes(`${relevantCount} of ${records.length}`),
  `extractive brief states the real relevant count (${relevantCount} of ${records.length})`,
);
assert(
  extractive.includes(`${noPlaceCount} mention no place`),
  `extractive brief states the real no-place count (${noPlaceCount})`,
);

console.log("\n=== communityBrief(\"Siksika Nation\")");
const siksika = communityBrief(records, "Siksika Nation");
console.log(siksika);

const siksikaRecords = records.filter((r) =>
  r.places.some((p) => p.community?.name === "Siksika Nation"),
);
assert(siksikaRecords.length > 0, "fixtures actually contain Siksika Nation records");
assert(
  siksika.includes(`In Siksika Nation:`),
  "communityBrief is scoped with a named prefix",
);

// ---------------------------------------------------------------------------
// 5: prove enforcement drops a fabricated citation (unit-level, no network needed)
// ---------------------------------------------------------------------------

console.log("\n=== enforceCitations: fabricated id r_999");
const allowedIds = new Set(clusters.flatMap((c) => c.representativeIds));
const fabricated = [
  { sentence: "This is a fabricated claim.", citedRecordIds: ["r_999"] },
  { sentence: "This one cites nothing.", citedRecordIds: [] },
  { sentence: "This confirmed report is unverified spin.", citedRecordIds: [...allowedIds].slice(0, 1) },
  { sentence: "200,000 people were affected by this.", citedRecordIds: [...allowedIds].slice(0, 1) },
];
const enforcement = enforceCitations(fabricated, allowedIds);
console.log(`  kept: ${enforcement.kept.length}, dropped: ${enforcement.dropped.length}`);
for (const d of enforcement.dropped) console.log(`    dropped (${d.reason}): "${d.sentence}"`);

assert(enforcement.kept.length === 0, "all four fabricated/rule-breaking sentences were dropped");
assert(
  enforcement.dropped.some((d) => d.reason.includes("r_999")),
  "the r_999 fabrication was dropped specifically for citing an unknown id",
);
assert(
  enforcement.dropped.some((d) => d.reason === "no citations"),
  "the uncited sentence was dropped for having no citations",
);
assert(
  enforcement.dropped.some((d) => d.reason.includes("kill phrase")),
  "the verified/confirmed sentence was dropped as a kill phrase",
);
assert(
  enforcement.dropped.some((d) => d.reason.includes("people")),
  "the people-affected sentence was dropped as an unsupportable claim",
);

// ---------------------------------------------------------------------------
// 4 + 6: narrate, live with a key, then again with the key removed
// ---------------------------------------------------------------------------

const hadKey = process.env.GEMINI_API_KEY;

if (hadKey) {
  console.log("\n=== narrate (live Gemini call)");
  const narrative = await narrate(clusters, records);
  if (narrative) {
    console.log(`  ${narrative.length} sentence(s) survived enforcement:`);
    for (const n of narrative) {
      console.log(`    "${n.sentence}"  <- ${n.citedRecordIds.join(", ")}`);
    }
    assert(
      narrative.every((n) => n.citedRecordIds.every((id) => allIds.has(id))),
      "every surviving narrative citation references a real record id",
    );
    assert(
      narrative.every((n) => n.citedRecordIds.length > 0),
      "every surviving narrative sentence has at least one citation",
    );
  } else {
    console.log("  narrate() returned undefined (Gemini unavailable this run) -- acceptable per contract");
  }

  console.log("\n=== plainLanguage (live Gemini call)");
  const plain = await plainLanguage(extractive);
  if (plain) {
    console.log(`  ${plain}`);
    const numbers = extractive.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    assert(
      numbers.every((n) => plain.includes(n)),
      "plainLanguage rewrite preserves every number from the source brief",
    );
  } else {
    console.log("  plainLanguage() returned undefined (Gemini unavailable this run) -- acceptable per contract");
  }
} else {
  console.log("\n=== narrate / plainLanguage skipped: GEMINI_API_KEY not set in .env.local");
}

// ---------------------------------------------------------------------------
// 6: the whole module must degrade cleanly with no key
// ---------------------------------------------------------------------------

console.log("\n=== degraded mode: no provider key set");
// narrate() tries the fast OpenRouter path before the Gemini proxy, so both keys must be
// absent to simulate the real no-key situation this test is checking.
const hadOpenRouterKey = process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const degradedClusters = clusterRecords(records);
const degradedBrief = buildExtractiveBrief(records, degradedClusters);
const degradedNarrative = await narrate(degradedClusters, records);
const degradedPlain = await plainLanguage(degradedBrief);

assert(degradedClusters.length === clusters.length, "clustering is unaffected by no provider key being set");
assert(degradedBrief === extractive, "extractive brief is byte-identical with no key (no network involved)");
assert(degradedNarrative === undefined, "narrate() returns undefined with no provider key");
assert(degradedPlain === undefined, "plainLanguage() returns undefined with no key");

if (hadKey) process.env.GEMINI_API_KEY = hadKey;
if (hadOpenRouterKey) process.env.OPENROUTER_API_KEY = hadOpenRouterKey;

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
// process.exit() here races Node's own libuv teardown on Windows against an
// AbortSignal.timeout() left over from the LLM client (an unhandled async handle at
// shutdown), and occasionally crashes with "flags & UV_HANDLE_CLOSING" AFTER every
// assertion above has already printed and passed. Setting exitCode and returning lets
// the event loop drain normally instead of forcing a hard stop mid-teardown.
