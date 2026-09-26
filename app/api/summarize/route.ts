/**
 * POST /api/summarize -- cluster labels + optional narrative.
 *
 * Stateless, per docs/CONTRACT.md: the client posts the records it holds, the server
 * computes and returns, nothing is kept. Clustering is deterministic (lib/summarize.ts
 * sorts clusters largest-first, ties broken alphabetically by category), so a client that
 * posts the same records twice gets the same cluster ids back -- that is what lets
 * scope.kind === "cluster" reference an id from an earlier "all" response.
 */

import { buildExtractiveBrief, clusterRecords, communityBrief, narrate, plainLanguage } from "../../../lib/summarize";
import type { Brief, Cluster, FloodRecord } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The provided dataset tops out at 8,024 raw rows (docs/ARCHITECTURE.md 3). A judge's
// unseen file is unlikely to dwarf that by an order of magnitude for a single summarize
// call; above this we would rather fail loudly than hang building clusters and asking
// Gemini to read an unbounded prompt.
const MAX_RECORDS = 20000;

type ScopeKind = "all" | "cluster" | "community" | "filter";

interface SummarizeBody {
  records: FloodRecord[];
  scope: { kind: ScopeKind; id?: string };
  narrative?: boolean;
}

function isScopeKind(value: unknown): value is ScopeKind {
  return value === "all" || value === "cluster" || value === "community" || value === "filter";
}

function isValidBody(value: unknown): value is SummarizeBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.records)) return false;
  if (typeof v.scope !== "object" || v.scope === null) return false;
  const scope = v.scope as Record<string, unknown>;
  if (!isScopeKind(scope.kind)) return false;
  if (scope.id !== undefined && typeof scope.id !== "string") return false;
  if (v.narrative !== undefined && typeof v.narrative !== "boolean") return false;
  return true;
}

/** Narrows the request to the records the requested scope actually covers. */
function selectScopedRecords(
  body: SummarizeBody,
  allClusters: Cluster[],
): { records: FloodRecord[]; scopeLabel?: string; error?: string } {
  const { records, scope } = body;

  switch (scope.kind) {
    case "all":
      return { records };

    case "cluster": {
      if (!scope.id) return { records: [], error: "scope.id is required for kind=\"cluster\"." };
      const cluster = allClusters.find((c) => c.id === scope.id);
      if (!cluster) return { records: [], error: `No cluster with id ${scope.id}.` };
      const ids = new Set(cluster.recordIds);
      return { records: records.filter((r) => ids.has(r.id)), scopeLabel: cluster.label };
    }

    case "community": {
      if (!scope.id) return { records: [], error: "scope.id (community name) is required for kind=\"community\"." };
      const needle = scope.id.trim().toLowerCase();
      const scoped = records.filter((r) =>
        r.places.some((p) => p.community?.name.toLowerCase() === needle || p.community?.id === scope.id),
      );
      return { records: scoped, scopeLabel: scope.id };
    }

    case "filter":
      // The client filters records itself and posts exactly the subset it wants
      // summarized -- there is no server-side session to look a saved filter up in
      // (see docs/CONTRACT.md, /api/classify: a session map dies across serverless
      // instances). scope.id is treated as a display label only, never re-derived here.
      return { records, scopeLabel: scope.id };
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json(
      { error: 'Expected { records: FloodRecord[], scope: { kind, id? }, narrative?: boolean }.' },
      { status: 400 },
    );
  }

  if (body.records.length > MAX_RECORDS) {
    return Response.json(
      { error: `Too many records (${body.records.length}). The limit is ${MAX_RECORDS} per call.` },
      { status: 413 },
    );
  }

  // Clusters over the FULL posted set are computed first because scope.kind === "cluster"
  // needs to resolve an id against them before we know which records are in scope.
  const allClusters = clusterRecords(body.records);
  const { records: scopedRecords, scopeLabel, error } = selectScopedRecords(body, allClusters);
  if (error) return Response.json({ error }, { status: 400 });

  // Recomputing over scopedRecords is redundant work for scope.kind === "all" (scopedRecords
  // IS body.records there) but keeps one code path instead of two, and clustering 20k rows
  // twice is still cheap relative to the network round trip.
  const clusters = clusterRecords(scopedRecords);

  const extractive =
    body.scope.kind === "community"
      ? communityBrief(body.records, body.scope.id ?? "")
      : buildExtractiveBrief(scopedRecords, clusters, scopeLabel);

  const brief: Brief = { extractive };

  // Both Gemini calls are gated behind the same opt-in flag: the accessibility rewrite is
  // only useful once there is a narrative-quality brief to simplify, and skipping it when
  // narrative is false avoids a second paid call the client did not ask for.
  if (body.narrative) {
    const narrative = await narrate(clusters, scopedRecords);
    if (narrative) brief.narrative = narrative;

    const plain = await plainLanguage(extractive);
    if (plain) brief.plainLanguage = plain;
  }

  return Response.json({ clusters, brief });
}
