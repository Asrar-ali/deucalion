// Ingests + classifies the real Alberta sample locally, then measures the export/summarize
// payload size before and after stripping rawText/imageRef, to confirm the 413 fix actually
// gets the request under the limit. Run: node --import tsx scripts/measure-payload.mts
import fs from "node:fs";
import { readEventStream } from "../lib/stream";

const base = process.env.BASE_URL ?? "http://localhost:3119";
const csv = fs.readFileSync("public/sample/alberta-2013.csv");
const form = new FormData();
form.append("file", new Blob([csv], { type: "text/csv" }), "alberta-2013.csv");

const ingestRes = await fetch(`${base}/api/ingest`, { method: "POST", body: form });
const ingest = (await ingestRes.json()) as { records: any[]; profile: any };
console.log("ingested", ingest.records.length, "records");

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

const full = JSON.stringify({ records, format: "csv" });
const trimmed = JSON.stringify({
  records: records.map(({ rawText, imageRef, ...rest }) => rest),
  format: "csv",
});
console.log("full payload bytes:", full.length, (full.length / 1024 / 1024).toFixed(2) + "MB");
console.log("trimmed payload bytes:", trimmed.length, (trimmed.length / 1024 / 1024).toFixed(2) + "MB");

const exportRes = await fetch(`${base}/api/export`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: trimmed,
});
console.log("export with trimmed payload:", exportRes.status);
