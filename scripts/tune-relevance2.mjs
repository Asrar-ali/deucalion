/**
 * Phrasing B missed "mandatory evacuation order issued in Medicine Hat" (0.48) because the
 * post never says "flood". Emergency-response posts are exactly what a responder needs, so
 * relevance should be: about the hazard OR about the response to it.
 *
 * Tests whether a second parallel noul recovers that case without dragging negatives up.
 * Both questions ride in one request, so this costs no extra call.
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.SYSTEMONE_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL = process.env.SYSTEMONE_MODEL || "jev-1.13";

const POSITIVE = [
  "@ZevKlymochko I skated (and loved) millennium park when I lived in Calgary. Is there any pics of millennium park post flood?",
  "#News Floods displace nearly 200,000 in western Canada http://t.co/2q8NrnECDm",
  "Glenmore bridge is under water, do not try it",
  "Anyone know if Highway 22 is open? #yycflood",
  "Officials in #Calgary say evacuations will not end until water recedes",
  "Inn from the Cold has been forced to evacuate #yycflood",
  "RT @weathernetwork: A mandatory evacuation order has been issued in Medicine Hat",
  "Christy Clark donated $250 to Calgary flood to say on Global news that is joke!",
  "Red Cross reception centre is open at the Stampede grounds",
];

const NEGATIVE = [
  "Camping tomorrow. That would be fun.",
  "Happy Canada Day!!! #canadaday #july1st #lethbridge #hendersonpark #fun under the #sun #tan #mapleleaf",
  "Getting mask fitted tom so I can go out to the upgrader. #nowwearetalking #fortmac",
  "I'm at Los Chilitos Taco and Tequila House (Calgary, AB)",
  "Vestara did not see what happened next, exactly, because she was diving #into the cave after Ahri.",
  "if i could drive my life would be easier!",
  "@britanniaderm are you guys still open??",
  "Looking for a new job in Calgary, anyone hiring? #yyc #job",
  "Evacuated the office early to beat the long weekend traffic",
];

const QUESTIONS = {
  hazard_topic: {
    type: "noul",
    instructions: "Is this post about flooding, or its effects and aftermath?",
  },
  response_topic: {
    type: "noul",
    instructions:
      "Is this post about an emergency response: evacuation, rescue, shelter, road closure or relief effort?",
  },
};

async function ask(state) {
  const res = await fetch(`${BASE}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b = await res.json();
  return {
    h: b.answers.hazard_topic.noul,
    r: b.answers.response_topic.noul,
    cost: b.usage?.cost ?? 0,
  };
}

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

const pos = await mapLimit(POSITIVE, 9, ask);
const neg = await mapLimit(NEGATIVE, 9, ask);
const spend = [...pos, ...neg].reduce((a, x) => a + x.cost, 0);

const conf = (p) => Math.abs(p - 0.5) * 2;

function report(name, score) {
  const p = pos.map(score);
  const n = neg.map(score);
  const minPos = Math.min(...p);
  const maxNeg = Math.max(...n);
  const wrong = p.filter((x) => x < 0.5).length + n.filter((x) => x >= 0.5).length;
  const review = [...p, ...n].filter((x) => conf(x) < 0.6).length;
  console.log(`\n${name}`);
  console.log(`  worst positive ${minPos.toFixed(3)}   worst negative ${maxNeg.toFixed(3)}   separation ${(minPos - maxNeg).toFixed(3)}`);
  console.log(`  wrong side of 0.5: ${wrong}/${p.length + n.length}   forced to review: ${review}/${p.length + n.length}`);
  console.log(`  positives: ${p.map((x) => x.toFixed(2)).join(" ")}`);
  console.log(`  negatives: ${n.map((x) => x.toFixed(2)).join(" ")}`);
  return { name, wrong, review, minPos, separation: minPos - maxNeg };
}

const results = [
  report("hazard only (B)", (x) => x.h),
  report("response only", (x) => x.r),
  report("OR: max(hazard, response)", (x) => Math.max(x.h, x.r)),
  // Probabilistic OR: P(A or B) assuming independence. Softer than max.
  report("noisy-OR: 1-(1-h)(1-r)", (x) => 1 - (1 - x.h) * (1 - x.r)),
];

const best = results
  .slice()
  .sort((a, b) => a.wrong - b.wrong || a.review - b.review || b.separation - a.separation)[0];

console.log(`\n=== winner: ${best.name}`);
console.log(`spend: $${spend.toFixed(6)}`);
console.log("\nper-row detail (hazard / response):");
POSITIVE.forEach((t, i) =>
  console.log(`  POS ${pos[i].h.toFixed(2)} ${pos[i].r.toFixed(2)}  ${t.slice(0, 62)}`),
);
NEGATIVE.forEach((t, i) =>
  console.log(`  NEG ${neg[i].h.toFixed(2)} ${neg[i].r.toFixed(2)}  ${t.slice(0, 62)}`),
);
