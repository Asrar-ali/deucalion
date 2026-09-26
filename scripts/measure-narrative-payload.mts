// Confirms the narrative call now carries only representative posts, not the full dataset.
// Run: node --env-file=.env.local --import tsx scripts/measure-narrative-payload.mts
import fs from "node:fs";
import { readEventStream } from "../lib/stream";
import { clusterRecords } from "../lib/summarize";

const base = process.env.BASE_URL ?? "http://localhost:3121";
const csv = fs.readFileSync("public/sample/alberta-2013.csv");
const form = new FormData();
form.append("file", new Blob([csv], { type: "text/csv" }), "alberta-2013.csv");

const ingestRes = await fetch(`${base}/api/ingest`, { method: "POST", body: form });
const ingest = (await ingestRes.json()) as { records: any[]; profile: any };

const classifyRes = await fetch(`${base}/api/classify`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ records: ingest.records, profile: ingest.profile }),
});
const records: any[] = [];
for await (const ev of readEventStream(classifyRes.body as any)) {
  if (ev.type === "record") records.push(ev.record);
}
console.log("classified", records.length, "records");

const clusters = clusterRecords(records);
const repIds = new Set(clusters.flatMap((c: any) => c.representativeIds));
const narrativeRecords = records
  .filter((r) => repIds.has(r.id))
  .map(({ rawText, imageRef, ...rest }) => rest);
console.log("representative records for narrative:", narrativeRecords.length, "of", records.length);

const body = JSON.stringify({ records: narrativeRecords, scope: { kind: "all" }, narrative: true });
console.log("narrative payload bytes:", body.length, (body.length / 1024).toFixed(1) + "KB");

const res = await fetch(`${base}/api/summarize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
console.log("summarize with narrative status:", res.status);
const data = await res.json();
console.log("narrative sentences:", data.brief?.narrative?.length ?? 0);
