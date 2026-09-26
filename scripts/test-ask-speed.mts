/**
 * Timing + correctness probe for POST /api/ask (3 old-style calls, 3 current calls = 6 total).
 *   node --env-file=.env.local --import tsx scripts/test-ask-speed.mts
 *
 * Loads the Alberta sample CSV as records (all marked relevant, text only), then:
 *  - "old": replicates the previous prompt (200 posts, full text, no facts) via generateJson
 *  - "new": calls the route handler directly with 60 posts plus computed facts
 */

import { readFileSync } from "node:fs";
import { computeAskFacts, selectRecordsForQuestion } from "../lib/askFacts";
import { generateJson } from "../lib/llm";
import { POST } from "../app/api/ask/route";
import type { FloodRecord } from "../lib/types";

const text = readFileSync(new URL("../public/sample/alberta-2013.csv", import.meta.url), "utf8");
const rows = text.split(/\r?\n/).slice(1).filter((l) => l.trim());
const records = rows.map((l, i) => ({
  id: `c${i}`,
  source: "csv",
  text: l.replace(/^"|"$/g, ""),
  labels: { relevant: { value: true, confidence: 0.9 }, severity: { value: 0.3, confidence: 0.5 } },
  places: [],
  review: "auto",
  classifier: "heuristic",
})) as unknown as FloodRecord[];
console.log(`loaded ${records.length} posts`);

const QUESTIONS = [
  "How many posts mention Calgary?",
  "Which roads or bridges are reported closed?",
  "What do people need most right now?",
];
const SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "array",
      items: {
        type: "object",
        properties: { sentence: { type: "string" }, citedRecordIds: { type: "array", items: { type: "string" } } },
        required: ["sentence", "citedRecordIds"],
      },
    },
  },
  required: ["answer"],
};

const mode = process.argv[2] ?? "both";

for (const q of QUESTIONS) {
  if (mode !== "new") {
    const sel = selectRecordsForQuestion(q, records, 200);
    const ctx = sel.map((r, i) => `${i + 1}. [id=${r.id}] ${r.text}`).join("\n");
    const prompt =
      "You answer a question about flood posts using ONLY the numbered posts. Write 1 to 5 short sentences, each with citedRecordIds.\n\nQuestion: " +
      q + "\n\nPosts:\n" + ctx;
    const t0 = Date.now();
    const out = await generateJson<{ answer: Array<{ sentence: string }> }>(prompt, SCHEMA);
    console.log(`OLD ${((Date.now() - t0) / 1000).toFixed(1)}s prompt=${prompt.length}ch :: ${q}\n   ${out?.answer?.map((a) => a.sentence).join(" ") ?? "(null)"}`);
  }
  if (mode !== "old") {
    const sel = selectRecordsForQuestion(q, records, 60);
    const facts = computeAskFacts(q, records);
    const t0 = Date.now();
    const res = await POST(
      new Request("http://x/api/ask", {
        method: "POST",
        body: JSON.stringify({ question: q, records: sel, facts }),
      }),
    );
    const data = await res.json();
    console.log(`NEW ${((Date.now() - t0) / 1000).toFixed(1)}s status=${res.status} facts=${JSON.stringify(facts.terms)} :: ${q}\n   ${data.answer?.map((a: { sentence: string }) => a.sentence).join(" ") ?? JSON.stringify(data)}`);
  }
}
