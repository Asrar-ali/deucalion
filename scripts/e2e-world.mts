// Throwaway end-to-end timing for the 61k-row world CSV. Needs a running `npm start`.
// Run: PORT=3111 [MAX_COST=1] node --import tsx scripts/e2e-world.mts   (never prints keys)
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { knownPlaceAliases } from "../lib/geoparse";
import { detectEventProfile, focusProfile, normalize, prefilter } from "../lib/prefilter";
import { runClassify } from "../lib/stream";
import type { FloodRecord } from "../lib/types";

const base = `http://localhost:${process.env.PORT ?? "3111"}`;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) =>
  realFetch(typeof input === "string" && input.startsWith("/") ? base + input : input, init)) as typeof fetch;

let peak = 0;
const mem = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 200);

const file = "public/sample/bonus-global.csv";
const t0 = Date.now();
const parsed = Papa.parse<string[]>(readFileSync(file, "utf8"), { skipEmptyLines: true });
const [header, ...rows] = parsed.data;
const PER = 6000;
const chunkCount = Math.ceil(rows.length / PER);
const merged: FloodRecord[] = [];
const byText = new Map<string, FloodRecord>();
let raw = 0;
for (let c = 0; c < chunkCount; c++) {
  const csv = Papa.unparse([header, ...rows.slice(c * PER, (c + 1) * PER)]);
  const form = new FormData();
  form.set("file", new File([csv], `bonus-global.csv.part${c + 1}.csv`, { type: "text/csv" }));
  const res = await fetch("/api/ingest", { method: "POST", body: form });
  const data: any = await res.json();
  if (!res.ok || data.error) throw new Error(`ingest part ${c + 1}: ${data.error ?? res.status}`);
  raw += data.funnel.raw;
  for (const record of data.records as FloodRecord[]) {
    const key = record.text ? normalize(record.text) : "";
    const existing = key ? byText.get(key) : undefined;
    if (existing) { existing.duplicateCount = (existing.duplicateCount ?? 1) + (record.duplicateCount ?? 1); continue; }
    const u = { ...record, id: `k${c}_${record.id}` };
    if (key) byText.set(key, u);
    merged.push(u);
  }
}
const texts = merged.map((r) => r.text).filter(Boolean);
const opts = { knownPlaces: knownPlaceAliases() };
const profile = focusProfile(detectEventProfile(texts, opts), texts, opts);
const tIngest = (Date.now() - t0) / 1000;
console.log(`ingest ${tIngest.toFixed(1)}s raw=${raw} merged=${merged.length}`);

const cands = prefilter(merged.filter((r) => r.text.trim()).map((r) => ({ id: r.id, text: r.text })), profile as any).candidates.length;
const est = cands * 0.00004;
console.log(`local prefilter candidates=${cands} est cost=$${est.toFixed(3)}`);
if (est > Number(process.env.MAX_COST ?? 1)) { console.log("ABORT: over cost cap"); process.exit(2); }

const t1 = Date.now();
let got = 0, firstAt = 0;
const ids = new Set<string>();
const events: string[] = [];
let funnel: any, spend: any;
await runClassify({ records: merged, profile }, {
  onRecordBatch: (rs) => { if (!firstAt) firstAt = Date.now(); got += rs.length; for (const r of rs) ids.add(r.id); },
  onDegraded: (reason, m) => events.push(`degraded:${reason}:${m.slice(0, 80)}`),
  onError: (m) => events.push(`error:${m.slice(0, 120)}`),
  onDone: (f, s) => { funnel = f; spend = s; },
});
const tClassify = (Date.now() - t1) / 1000;
clearInterval(mem);
console.log(JSON.stringify({
  ingestS: +tIngest.toFixed(1), classifyS: +tClassify.toFixed(1), totalS: +(tIngest + tClassify).toFixed(1),
  firstRecordS: firstAt ? +((firstAt - t1) / 1000).toFixed(1) : null,
  received: got, uniqueIds: ids.size, posted: merged.length,
  funnel: funnel && { ...funnel, rejectedRows: funnel.rejectedRows?.length },
  spend, events, peakRssMB: Math.round(peak / 1e6),
}, null, 1));
