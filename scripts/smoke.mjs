/**
 * Contract smoke test. Run BEFORE writing any UI.
 *   node scripts/smoke.mjs
 *
 * Proves: the endpoint shape, the key works, the model id resolves, answers parse,
 * real cost per call, and observed latency. Prints the exact model version for the audit trail.
 */

import { readFileSync } from "node:fs";

// Minimal .env.local loader so this runs with no deps and no framework.
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  console.error("No .env.local found. Create it from .env.example first.");
  process.exit(1);
}

const KEY = process.env.OPENROUTER_API_KEY;
const BASE = process.env.SYSTEMONE_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL = process.env.SYSTEMONE_MODEL || "jev-1.13";

if (!KEY) {
  console.error("OPENROUTER_API_KEY is missing from .env.local");
  process.exit(1);
}

// Real rows from the provided dataset: one clear signal, one clear noise, one ambiguous.
const SAMPLES = [
  "@ZevKlymochko I skated (and loved) millennium park when I lived in Calgary. Is there any pics of millennium park post flood?",
  "Camping tomorrow. That would be fun.",
  "#News Floods displace nearly 200,000 in western Canada http://t.co/2q8NrnECDm",
];

const QUESTIONS = {
  relevant: {
    type: "noul",
    instructions: "Is this post about the ongoing flood emergency in Calgary, High River?",
  },
  category: {
    type: "choice",
    instructions: "What does this post report?",
    criteria: {
      access_blocked: "road, bridge, highway or route impassable or closed",
      evacuation: "people evacuating, displaced, sheltering, told to leave",
      damage: "property, home or infrastructure damaged",
      aid: "donations, volunteering, relief supplies, fundraising",
      sentiment: "opinion, thanks, solidarity, no operational detail",
    },
  },
  severity: {
    type: "score",
    instructions: "How urgent is this for a responder?",
    criteria: ["background", "notable", "urgent"],
  },
  has_place: {
    type: "noul",
    instructions: "Does this post name a specific place, road, bridge or neighbourhood?",
  },
};

async function decide(state) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 404
        ? "404 usually means a chat-completions path or SDK was used. This endpoint is /systemone."
        : res.status === 401
          ? "401 means wrong host or key mismatch."
          : res.status === 402
            ? "402 means the OpenRouter account needs credit."
            : res.status === 429
              ? "429 is rate limiting. Back off."
              : "";
    throw new Error(`HTTP ${res.status} in ${ms}ms. ${hint}\n${text.slice(0, 400)}`);
  }
  return { ms, body: JSON.parse(text) };
}

console.log(`POST ${BASE}/systemone   model=${MODEL}\n`);

let totalCost = 0;
let totalMs = 0;

for (const s of SAMPLES) {
  try {
    const { ms, body } = await decide(s);
    totalMs += ms;
    totalCost += body.usage?.cost ?? 0;

    console.log(`--- ${s.slice(0, 72)}${s.length > 72 ? "..." : ""}`);
    console.log(`    model:    ${body.model ?? "(none returned)"}`);
    console.log(`    latency:  ${ms}ms`);
    for (const [k, a] of Object.entries(body.answers ?? {})) {
      const v =
        a.noul !== undefined
          ? `noul=${a.noul.toFixed(3)}`
          : a.choice !== undefined
            ? `choice=${a.choice}`
            : `score=${a.score}`;
      const conf = a.confidence !== undefined ? ` conf=${a.confidence.toFixed(3)}` : "";
      console.log(`    ${k.padEnd(12)} ${v}${conf}`);
    }
    console.log(
      `    tokens:   in=${body.usage?.input_tokens} out=${body.usage?.output_tokens} cost=$${(body.usage?.cost ?? 0).toFixed(6)}`,
    );
    console.log();
  } catch (err) {
    console.error(`FAILED on: ${s.slice(0, 60)}`);
    console.error(err.message);
    process.exit(1);
  }
}

const perCall = totalCost / SAMPLES.length;
console.log("=== contract verified");
console.log(`avg latency:      ${Math.round(totalMs / SAMPLES.length)}ms`);
console.log(`avg cost/call:    $${perCall.toFixed(6)}`);
console.log(`projected 8,024:  $${(perCall * 8024).toFixed(2)}  (all rows, 4 questions)`);
console.log(`projected 4,500:  $${(perCall * 4500).toFixed(2)}  (after prefilter)`);
console.log("\nNote: the real run uses 9 questions, so multiply cost by roughly 2.");
