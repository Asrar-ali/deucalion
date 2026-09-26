/**
 * Hits the live internet through every adapter in lib/resolve.ts, calling the route
 * handler directly -- no dev server, no port -- exactly like scripts/test-routes.mts does
 * for ingest/classify.
 *
 *   npx tsx scripts/test-resolve.mts
 */

import { POST } from "../app/api/resolve/route";

interface Case {
  name: string;
  url: string;
  expectStatus: number[];
}

async function callResolve(url: string): Promise<{ status: number; body: unknown }> {
  const res = await POST(
    new Request("http://local/api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Bluesky posts get deleted; find a live one instead of hardcoding an rkey.
async function findBlueskyUrl(): Promise<string> {
  const res = await fetch(
    "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=bsky.app&limit=1",
    { headers: { "User-Agent": "Deucalion/0.1 (+https://github.com/Asrar-ali/deucalion)" } },
  );
  const data = (await res.json()) as {
    feed?: Array<{ post?: { uri?: string; author?: { handle?: string } } }>;
  };
  const post = data.feed?.[0]?.post;
  if (!post?.uri || !post.author?.handle) {
    throw new Error("could not find a live Bluesky post via getAuthorFeed");
  }
  const rkey = post.uri.split("/").pop();
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

const problems: string[] = [];

console.log("=== POST /api/resolve  (live internet)\n");

const blueskyUrl = await findBlueskyUrl();

const cases: Case[] = [
  { name: "X post (jack/status/20)", url: "https://twitter.com/jack/status/20", expectStatus: [200] },
  { name: "Bluesky post", url: blueskyUrl, expectStatus: [200] },
  { name: "Mastodon status (Gargron/1)", url: "https://mastodon.social/@Gargron/1", expectStatus: [200] },
  {
    name: "News/article URL",
    url: "https://en.wikipedia.org/wiki/2013_Alberta_floods",
    expectStatus: [200],
  },
  { name: "Reddit (must 409)", url: "https://www.reddit.com/r/test", expectStatus: [409] },
  { name: "Facebook (must 409)", url: "https://www.facebook.com/zuck", expectStatus: [409] },
  { name: "localhost (must 400)", url: "http://localhost:3000/x", expectStatus: [400] },
  { name: "garbage URL", url: "not a url at all", expectStatus: [400, 409] },
];

for (const c of cases) {
  const { status, body } = await callResolve(c.url);
  const ok = c.expectStatus.includes(status);
  const marker = ok ? "OK  " : "FAIL";
  const summary =
    status === 200
      ? JSON.stringify((body as { text?: string })?.text ?? "").slice(0, 90)
      : JSON.stringify(body);
  console.log(`${marker} [${status}] ${c.name.padEnd(28)} ${summary}`);
  if (!ok) {
    problems.push(`${c.name}: expected status in [${c.expectStatus.join(",")}], got ${status} (${JSON.stringify(body)})`);
  }
}

// Ground truth for this specific tweet (docs/CONTRACT.md example uses the same shape).
const jack = await callResolve("https://twitter.com/jack/status/20");
if (jack.status === 200) {
  const text = (jack.body as { text?: string }).text;
  if (text !== "just setting up my twttr") {
    problems.push(`jack/status/20 text mismatch: got ${JSON.stringify(text)}`);
  } else {
    console.log(`\nground truth OK: jack/status/20 text === "just setting up my twttr"`);
  }
} else {
  problems.push(`jack/status/20 did not return 200 on the ground-truth check (got ${jack.status})`);
}

// Batch smoke test: one success, one hard-blocked platform, same request.
console.log(`\n=== POST /api/resolve  (batch)`);
const batchRes = await POST(
  new Request("http://local/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: ["https://twitter.com/jack/status/20", "https://www.reddit.com/r/test"] }),
  }),
);
const batchBody = (await batchRes.json()) as unknown[];
console.log(`  status ${batchRes.status}, ${Array.isArray(batchBody) ? batchBody.length : "?"} results`);
if (batchRes.status !== 200 || !Array.isArray(batchBody) || batchBody.length !== 2) {
  problems.push("batch call did not return 200 with 2 results");
} else {
  const [first, second] = batchBody as Array<{ text?: string; needsScreenshot?: boolean }>;
  if (first.text !== "just setting up my twttr") problems.push("batch item 0 (X post) did not resolve correctly");
  if (second.needsScreenshot !== true) problems.push("batch item 1 (Reddit) was not reported as needsScreenshot");
}

if (problems.length) {
  console.error(`\nFAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("\nall assertions passed");
