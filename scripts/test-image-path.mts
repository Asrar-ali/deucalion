/**
 * The image front door had a silent data-loss bug: image rows carry no text, so the text
 * prefilter dropped them and they were never streamed back. The client waited forever for
 * rows that would never arrive.
 *
 * This asserts the invariant that actually matters: EVERY record posted to /api/classify
 * comes back, whatever door it came in through, and whether or not vision is available.
 *
 *   npx tsx scripts/test-image-path.mts
 */

import { readFileSync } from "node:fs";
import { POST as ingest } from "../app/api/ingest/route";
import { POST as classify } from "../app/api/classify/route";
import type { FloodRecord } from "../lib/types";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

// A real, valid 1x1 PNG. No EXIF, which is the common case: every major social platform
// strips it, so "no coordinates" is the path that must not crash.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

console.log("=== ingest: one image plus one text row");

const form = new FormData();
form.set("image", new File([new Uint8Array(PNG_1X1)], "flood.png", { type: "image/png" }));
form.set("text", "Glenmore bridge is under water, do not try it");

const ingestRes = await ingest(new Request("http://local/api/ingest", { method: "POST", body: form }));
if (!ingestRes.ok) {
  console.error(`ingest failed ${ingestRes.status}: ${await ingestRes.text()}`);
  process.exit(1);
}
const ingested = (await ingestRes.json()) as {
  records: FloodRecord[];
  profile: { hazard: string; places: string[]; terms: string[] };
};

const imageRows = ingested.records.filter((r) => r.source === "image");
check(ingested.records.length === 2, `ingest returned 2 records (got ${ingested.records.length})`);
check(imageRows.length === 1, "one record has source=image");
check(Boolean(imageRows[0]?.imageRef?.startsWith("data:image/png;base64,")), "image carried as a data URL");
check(imageRows[0]?.text === "", "image row starts with empty text (vision fills it later)");

console.log("\n=== classify: every posted record must come back");

const classifyRes = await classify(
  new Request("http://local/api/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ records: ingested.records, profile: ingested.profile }),
  }),
);

const reader = classifyRes.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
const returned: FloodRecord[] = [];
let sawDone = false;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.replace(/^data: /, "").trim();
    if (!line) continue;
    const evt = JSON.parse(line) as { type: string; record?: FloodRecord };
    if (evt.type === "record" && evt.record) returned.push(evt.record);
    if (evt.type === "done") sawDone = true;
  }
}

const postedIds = new Set(ingested.records.map((r) => r.id));
const returnedIds = new Set(returned.map((r) => r.id));
const lost = [...postedIds].filter((id) => !returnedIds.has(id));

check(sawDone, "stream completed with a done event");
check(lost.length === 0, `no records lost (missing: ${lost.join(", ") || "none"})`);
check(returned.length === ingested.records.length, `${returned.length} of ${ingested.records.length} records returned`);

const imageBack = returned.find((r) => r.source === "image");
check(Boolean(imageBack), "the image record came back");
check(imageBack?.labels.relevant !== undefined, "the image record carries a relevance label");

// Without a working Gemini key, vision returns null and the record must be marked honestly
// rather than given an invented classification.
const geminiWorking = Boolean(imageBack?.imageAlt);
if (geminiWorking) {
  check(
    typeof imageBack?.imageAlt === "string" && imageBack.imageAlt.length > 0,
    "vision produced alt text (required for accessibility whenever an image is present)",
  );
  console.log(`       alt text: ${JSON.stringify(imageBack?.imageAlt)}`);
  console.log(`       caption/text: ${JSON.stringify(imageBack?.text)}`);
} else {
  check(
    imageBack?.classifier === "heuristic" && imageBack?.labels.relevant?.confidence === 0,
    "vision unavailable, so the image is labelled heuristic with zero confidence, not guessed",
  );
  console.log("       note: Gemini key invalid in this environment, so alt text is untested.");
}

console.log(`\n${failures.length ? `FAILED: ${failures.length}` : "all assertions passed"}`);
process.exit(failures.length ? 1 : 0);
