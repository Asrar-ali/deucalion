/**
 * End-to-end test of the ingest -> classify pipeline, calling the route handlers directly.
 * No dev server, no port. Uses a small slice so the paid cost is a fraction of a cent.
 *
 *   npx tsx scripts/test-routes.ts [rowCount]
 */

import { readFileSync } from "node:fs";
import { POST as ingest } from "../app/api/ingest/route";
import { POST as classify } from "../app/api/classify/route";
import type { FloodRecord, FunnelCounts } from "../lib/types";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const ROWS = Number(process.argv[2] ?? 40);

// Build a small CSV from the real dataset, with a deliberately awkward column name and a
// couple of extra columns so the sniffing logic is actually exercised.
const full = readFileSync(new URL("../public/sample/alberta-2013.csv", import.meta.url), "utf8");
const lines = full.split(/\r?\n/).slice(1).filter(Boolean);
const sample = lines.slice(0, ROWS);
const csv =
  "Tweet Text (cleaned),Posted At,Screen Name\n" +
  sample
    .map((l, i) => {
      const text = l.startsWith('"') ? l : `"${l.replace(/"/g, '""')}"`;
      return `${text},2013-06-2${(i % 9) + 1}T12:00:00Z,user_${i}`;
    })
    .join("\n");

console.log(`=== POST /api/ingest  (${ROWS} rows, odd column names)`);

const form = new FormData();
form.set("file", new File([csv], "sample.csv", { type: "text/csv" }));

const ingestRes = await ingest(new Request("http://local/api/ingest", { method: "POST", body: form }));
if (!ingestRes.ok) {
  console.error(`ingest failed ${ingestRes.status}:`, await ingestRes.text());
  process.exit(1);
}
const ingested = (await ingestRes.json()) as {
  records: FloodRecord[];
  profile: { hazard: string; places: string[]; terms: string[] };
  funnel: FunnelCounts;
  detectedColumns: string[];
  chosenColumn: string;
  mappedColumns: Record<string, string | undefined>;
  duplicatesRemoved: number;
};

console.log(`  detected columns   ${ingested.detectedColumns.join(" | ")}`);
console.log(`  chose text column  "${ingested.chosenColumn}"   <- inferred, not hardcoded`);
console.log(`  mapped             ${JSON.stringify(ingested.mappedColumns)}`);
console.log(`  records            ${ingested.records.length}  (removed ${ingested.duplicatesRemoved} dupes)`);
console.log(`  rejected rows      ${ingested.funnel.rejectedRows.length}`);
console.log(`  timestamp carried  ${ingested.records[0]?.timestamp ?? "(none)"}`);
console.log(`  detected hazard    ${ingested.profile.hazard}`);
console.log(`  detected places    ${ingested.profile.places.slice(0, 6).join(", ")}`);

console.log(`\n=== POST /api/classify  (SSE)`);
const t0 = Date.now();
const classifyRes = await classify(
  new Request("http://local/api/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ records: ingested.records, profile: ingested.profile }),
  }),
);

console.log(`  status             ${classifyRes.status}`);
console.log(`  content-type       ${classifyRes.headers.get("content-type")}`);
console.log(`  set-cookie         ${classifyRes.headers.get("set-cookie") ? "present (spend metered)" : "none"}`);

const reader = classifyRes.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
const eventCounts = new Map<string, number>();
const got: FloodRecord[] = [];
let finalFunnel: FunnelCounts | undefined;
let finalSpend: { used: number; budget: number; unlimited: boolean } | undefined;
let modelVersion: string | undefined;
const degradedMessages: string[] = [];

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.replace(/^data: /, "").trim();
    if (!line) continue;
    const evt = JSON.parse(line);
    eventCounts.set(evt.type, (eventCounts.get(evt.type) ?? 0) + 1);
    if (evt.type === "record") got.push(evt.record);
    if (evt.type === "done") {
      finalFunnel = evt.funnel;
      finalSpend = evt.spend;
      modelVersion = evt.modelVersion;
    }
    if (evt.type === "degraded") degradedMessages.push(`${evt.reason}: ${evt.message}`);
    if (evt.type === "error") console.error("  STREAM ERROR:", evt.message);
  }
}
const elapsed = Date.now() - t0;

console.log(`  events             ${[...eventCounts].map(([k, v]) => `${k}=${v}`).join("  ")}`);
console.log(`  records streamed   ${got.length} / ${ingested.records.length}`);
console.log(`  elapsed            ${elapsed}ms`);
console.log(`  model version      ${modelVersion ?? "(none — degraded?)"}`);
if (degradedMessages.length) console.log(`  degraded           ${degradedMessages.join(" | ")}`);
if (finalSpend) console.log(`  spend              $${finalSpend.used.toFixed(6)} of $${finalSpend.budget}`);
if (finalFunnel) {
  console.log(
    `  funnel             raw=${finalFunnel.raw} prefiltered=${finalFunnel.prefiltered} ` +
      `relevant=${finalFunnel.relevant} mappable=${finalFunnel.mappable} noPlace=${finalFunnel.noPlaceMentioned}`,
  );
}

const byClassifier = new Map<string, number>();
for (const r of got) byClassifier.set(r.classifier, (byClassifier.get(r.classifier) ?? 0) + 1);
console.log(`  classifier mix     ${[...byClassifier].map(([k, v]) => `${k}=${v}`).join("  ")}`);

console.log(`\n  sample of relevant, mapped records:`);
for (const r of got.filter((x) => x.labels.relevant?.value && x.places.length).slice(0, 6)) {
  const p = r.places[0];
  console.log(
    `    rel=${r.labels.relevant!.confidence.toFixed(2)} via=${r.labels.relevant!.via} ` +
      `cat=${r.labels.category?.value ?? "-"} sev=${r.labels.severity?.value?.toFixed?.(1) ?? "-"} ` +
      `| ${p.name} (${p.confidence.toFixed(2)}/${p.method})`,
  );
  console.log(`       ${JSON.stringify(r.text.slice(0, 84))}`);
}

// --- assertions ------------------------------------------------------------
const problems: string[] = [];
if (got.length !== ingested.records.length) problems.push("not every record was streamed back");
if (!eventCounts.get("done")) problems.push("no done event");
if (!finalFunnel) problems.push("no final funnel");
if (got.some((r) => r.labels.relevant === undefined)) problems.push("a record came back with no relevance label");
if (got.some((r) => r.places.some((p) => !p.method || p.confidence == null)))
  problems.push("a place hit is missing method or confidence");
const pii = got.filter((r) => r.labels.has_pii?.value);
if (pii.some((r) => r.rawText)) problems.push("rawText survived on a PII-flagged record");

if (problems.length) {
  console.error(`\nFAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nall assertions passed`);
