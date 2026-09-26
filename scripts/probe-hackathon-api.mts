/**
 * Probes the hackathon Gemini proxy so we build against what it actually does, not the
 * README's happy path.
 *
 * Quota is 1,000 requests for the whole event and FAILED requests count against it, so this
 * script is deliberately small: 4 calls, each answering a question we cannot answer by reading.
 *
 *   npx tsx scripts/probe-hackathon-api.mts
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const BASE =
  "https://hackathon-api-new-152590733511.northamerica-northeast2.run.app";
const KEY = process.env.GEMINI_API_KEY ?? "";

async function call(label: string, body: unknown) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const ms = Date.now() - t0;
  const raw = await res.text();
  console.log(`\n--- ${label}`);
  console.log(`    HTTP ${res.status} in ${ms}ms`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`    non-JSON body: ${raw.slice(0, 300)}`);
    return { ok: res.ok, parsed: undefined };
  }
  const obj = parsed as { text?: string; requests_remaining?: number; detail?: unknown };
  if (obj.text !== undefined) {
    console.log(`    text: ${JSON.stringify(obj.text).slice(0, 400)}`);
    console.log(`    requests_remaining: ${obj.requests_remaining}`);
  } else {
    console.log(`    body: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return { ok: res.ok, parsed: obj };
}

// 1. Does the key work at all, and what is the real remaining quota?
await call("plain text generation", {
  contents: "Reply with only the number: what is 17 + 25?",
});

// 2. Structured output, the mechanism summarize.ts and vision.ts both depend on.
await call("structured output via response_schema", {
  contents:
    "A post reads: Glenmore bridge is under water, do not try it. Classify it.",
  response_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["access_blocked", "evacuation", "damage", "aid", "sentiment"],
      },
      urgent: { type: "boolean" },
      one_line: { type: "string" },
    },
    required: ["category", "urgent", "one_line"],
  },
});

// 3. THE decisive question: can `contents` carry an image? The README documents `contents`
// as a plain string, which would mean no vision, no alt text and no screenshot OCR through
// this proxy. Gemini natively accepts a parts array, so it is worth one request to find out
// whether the proxy passes that through.
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
await call("image via Gemini parts array", {
  contents: [
    {
      role: "user",
      parts: [
        { text: "Describe this image in one short sentence." },
        { inlineData: { mimeType: "image/png", data: PNG_1X1_B64 } },
      ],
    },
  ],
});

// 4. Is a non-default model accepted? Only useful if the organizers whitelisted more.
await call("explicit model id", {
  contents: "Reply with only: ok",
  model: "gemini-3-flash-preview",
});

console.log(
  "\nNote: failed requests also consume quota, so do not loop this script.",
);
