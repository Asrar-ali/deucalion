/**
 * POST /api/resolve — link -> { text, provenance, images }, or a 409 asking for a screenshot.
 *
 * Thin wrapper: every adapter and the SSRF guard live in lib/resolve.ts so they stay
 * testable with plain tsx and free of Next's request/response plumbing.
 */

import { isBlocked, isInvalid, resolveMany, resolveUrl, type ResolveOutcome } from "../../../lib/resolve";

export const runtime = "nodejs";
// Every call fetches a live third-party URL; the response must never be cached.
export const dynamic = "force-dynamic";

const MAX_BATCH = 20;

interface ResolveBody {
  url?: unknown;
  urls?: unknown;
}

/** The single-url response: 400 for a bad/unsafe URL, 409 when the platform refuses, 200 on success. */
function singleResponse(outcome: ResolveOutcome): Response {
  if (isInvalid(outcome)) {
    return Response.json({ error: outcome.detail }, { status: 400 });
  }
  if (isBlocked(outcome)) {
    return Response.json(
      { needsScreenshot: true, reason: outcome.reason, detail: outcome.detail },
      { status: 409 },
    );
  }
  return Response.json(outcome, { status: 200 });
}

/** Batch items carry no HTTP status of their own, so an invalid URL is reported the same
 * shape as a blocked one -- the UI only ever branches on "did this item succeed". */
function batchItem(outcome: ResolveOutcome): unknown {
  if (isInvalid(outcome)) {
    return { needsScreenshot: true, reason: "invalid_url", detail: outcome.detail };
  }
  if (isBlocked(outcome)) {
    return { needsScreenshot: true, reason: outcome.reason, detail: outcome.detail };
  }
  return outcome;
}

export async function POST(request: Request): Promise<Response> {
  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return Response.json({ error: "Expected a JSON body with { url } or { urls }." }, { status: 400 });
  }

  if (Array.isArray(body.urls)) {
    if (body.urls.length === 0) {
      return Response.json({ error: "urls must be a non-empty array." }, { status: 400 });
    }
    if (!body.urls.every((u): u is string => typeof u === "string")) {
      return Response.json({ error: "urls must be an array of strings." }, { status: 400 });
    }
    if (body.urls.length > MAX_BATCH) {
      return Response.json({ error: `urls is capped at ${MAX_BATCH}.` }, { status: 400 });
    }
    const outcomes = await resolveMany(body.urls);
    return Response.json(outcomes.map(batchItem), { status: 200 });
  }

  if (typeof body.url !== "string" || !body.url.trim()) {
    return Response.json({ error: "Expected { url: string } or { urls: string[] }." }, { status: 400 });
  }

  const outcome = await resolveUrl(body.url);
  return singleResponse(outcome);
}
