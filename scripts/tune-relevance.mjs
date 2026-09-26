/**
 * The relevance question is the core requirement of the challenge, so its wording is
 * worth measuring instead of guessing.
 *   node scripts/tune-relevance.mjs
 *
 * Costs about a tenth of a cent. Prints separation between hand-labelled positives and
 * negatives for each candidate phrasing, and the worst-case margin — which is what
 * actually decides whether real reports land in the review queue during a demo.
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.SYSTEMONE_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL = process.env.SYSTEMONE_MODEL || "jev-1.13";

// Real rows from the provided dataset, hand-labelled. Positives deliberately include the
// awkward cases: retrospective, headline-style, and place-free.
const POSITIVE = [
  "@ZevKlymochko I skated (and loved) millennium park when I lived in Calgary. Is there any pics of millennium park post flood?",
  "#News Floods displace nearly 200,000 in western Canada http://t.co/2q8NrnECDm",
  "Glenmore bridge is under water, do not try it",
  "Anyone know if Highway 22 is open? #yycflood",
  "Officials in #Calgary say evacuations will not end until water recedes",
  "Inn from the Cold has been forced to evacuate #yycflood",
  "RT @weathernetwork: A mandatory evacuation order has been issued in Medicine Hat",
  "Christy Clark donated $250 to Calgary flood to say on Global news that is joke!",
];

const NEGATIVE = [
  "Camping tomorrow. That would be fun.",
  "Happy Canada Day!!! #canadaday #july1st #lethbridge #hendersonpark #fun under the #sun #tan #mapleleaf",
  "Getting mask fitted tom so I can go out to the upgrader. #nowwearetalking #fortmac",
  "I'm at Los Chilitos Taco and Tequila House (Calgary, AB)",
  "Vestara did not see what happened next, exactly, because she was diving #into the cave after Ahri.",
  "if i could drive my life would be easier!",
  "@britanniaderm are you guys still open??",
];

const PHRASINGS = {
  "A: current + place (original)":
    "Is this post about the ongoing flood emergency in Calgary, High River?",
  "B: hazard only, no place":
    "Is this post about flooding, or its effects and aftermath?",
  "C: hazard + explicit inclusions":
    "Is this post about a flood? Include damage, evacuation, closures, relief efforts, and discussion of flood aftermath.",
  "D: topical framing":
    "Would someone monitoring this flood want to read this post?",
};

async function ask(state, instructions) {
  const res = await fetch(`${BASE}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      state,
      questions: { relevant: { type: "noul", instructions } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return { p: body.answers.relevant.noul, cost: body.usage?.cost ?? 0 };
}

// bounded concurrency so we do not trip rate limits
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

let spend = 0;
const results = [];

for (const [name, instructions] of Object.entries(PHRASINGS)) {
  const pos = await mapLimit(POSITIVE, 8, (t) => ask(t, instructions));
  const neg = await mapLimit(NEGATIVE, 8, (t) => ask(t, instructions));
  spend += [...pos, ...neg].reduce((a, r) => a + r.cost, 0);

  const posP = pos.map((r) => r.p);
  const negP = neg.map((r) => r.p);
  const meanPos = posP.reduce((a, b) => a + b, 0) / posP.length;
  const meanNeg = negP.reduce((a, b) => a + b, 0) / negP.length;
  const minPos = Math.min(...posP);
  const maxNeg = Math.max(...negP);

  // Records that would be forced into the review queue under our confidence gate.
  const conf = (p) => Math.abs(p - 0.5) * 2;
  const uncertain = [...posP, ...negP].filter((p) => conf(p) < 0.6).length;
  const misranked = posP.filter((p) => p < 0.5).length + negP.filter((p) => p >= 0.5).length;

  results.push({ name, meanPos, meanNeg, minPos, maxNeg, uncertain, misranked, posP, negP });

  console.log(`\n${name}`);
  console.log(`  mean positive   ${meanPos.toFixed(3)}    mean negative   ${meanNeg.toFixed(3)}`);
  console.log(`  worst positive  ${minPos.toFixed(3)}    worst negative  ${maxNeg.toFixed(3)}`);
  console.log(`  separation      ${(minPos - maxNeg).toFixed(3)}  (want > 0)`);
  console.log(`  wrong side of 0.5: ${misranked}/${POSITIVE.length + NEGATIVE.length}`);
  console.log(`  forced to review queue (conf < 0.6): ${uncertain}/${POSITIVE.length + NEGATIVE.length}`);
  console.log(`  positives: ${posP.map((p) => p.toFixed(2)).join(" ")}`);
  console.log(`  negatives: ${negP.map((p) => p.toFixed(2)).join(" ")}`);
}

const best = results
  .slice()
  .sort((a, b) => a.misranked - b.misranked || a.uncertain - b.uncertain || b.minPos - a.minPos)[0];

console.log(`\n=== winner: ${best.name}`);
console.log(`total spend on this experiment: $${spend.toFixed(6)}`);
