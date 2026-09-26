/**
 * POST /api/export -- the handoff. GeoJSON is a MapAki layer, CSV is the flat table any
 * GIS or spreadsheet opens, brief and sms are for a human. Stateless per docs/ARCHITECTURE.md
 * 6: the client posts the records it holds, the server computes the file and returns it,
 * nothing is written server-side.
 */

import { clusterRecords, buildExtractiveBrief } from "../../../lib/summarize";
import { toBriefMarkdown, toCsv, toGeoJSON, toSmsDigest } from "../../../lib/export";
import type { Brief, Cluster, EventProfile, FloodRecord, FunnelCounts } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The provided dataset tops out at 8,024 raw rows (docs/ARCHITECTURE.md 3). A single
// export call rebuilding a GeoJSON/CSV/brief over an unbounded body would rather fail
// loudly here than hang the function.
const MAX_RECORDS = 20000;

type ExportFormat = "geojson" | "csv" | "brief" | "sms";

interface ExportBody {
  records: FloodRecord[];
  format: ExportFormat;
  clusters?: Cluster[];
  brief?: Brief;
  profile?: EventProfile;
  funnel?: FunnelCounts;
  includeAuthors?: boolean;
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "geojson" || value === "csv" || value === "brief" || value === "sms";
}

function isValidBody(value: unknown): value is ExportBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.records)) return false;
  if (!isExportFormat(v.format)) return false;
  if (v.includeAuthors !== undefined && typeof v.includeAuthors !== "boolean") return false;
  return true;
}

/** Fills in what the brief needs when the client did not already have it computed. */
function resolveBriefInputs(body: ExportBody): {
  clusters: Cluster[];
  brief: Brief;
  profile: EventProfile;
  funnel: FunnelCounts;
} {
  const clusters = body.clusters ?? clusterRecords(body.records);
  const brief = body.brief ?? { extractive: buildExtractiveBrief(body.records, clusters) };
  const profile = body.profile ?? { hazard: "other", places: [], terms: [], userEdited: false };

  if (body.funnel) return { clusters, brief, profile, funnel: body.funnel };

  const relevant = body.records.filter((r) => r.labels.relevant?.value === true);
  const mappable = relevant.filter((r) => r.places.length > 0);
  const funnel: FunnelCounts = {
    raw: body.records.length,
    deduped: body.records.length,
    prefiltered: body.records.length,
    relevant: relevant.length,
    mappable: mappable.length,
    noPlaceMentioned: relevant.length - mappable.length,
    rejectedRows: [],
  };
  return { clusters, brief, profile, funnel };
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function attachmentHeaders(contentType: string, filename: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
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
      {
        error:
          'Expected { records: FloodRecord[], format: "geojson" | "csv" | "brief" | "sms", ' +
          "clusters?, brief?, profile?, funnel?, includeAuthors? }.",
      },
      { status: 400 },
    );
  }

  if (body.records.length > MAX_RECORDS) {
    return Response.json(
      { error: `Too many records (${body.records.length}). The limit is ${MAX_RECORDS} per export.` },
      { status: 413 },
    );
  }

  const stamp = todayStamp();
  const options = { includeAuthors: body.includeAuthors === true };

  switch (body.format) {
    case "geojson": {
      const { collection } = toGeoJSON(body.records, options);
      return new Response(JSON.stringify(collection), {
        headers: attachmentHeaders("application/geo+json", `deucalion-export-${stamp}.geojson`),
      });
    }

    case "csv": {
      const csv = toCsv(body.records, options);
      return new Response(csv, {
        headers: attachmentHeaders("text/csv; charset=utf-8", `deucalion-export-${stamp}.csv`),
      });
    }

    case "brief": {
      const { clusters, brief, profile, funnel } = resolveBriefInputs(body);
      const markdown = toBriefMarkdown(body.records, clusters, brief, profile, funnel);
      return new Response(markdown, {
        headers: attachmentHeaders("text/markdown; charset=utf-8", `deucalion-brief-${stamp}.md`),
      });
    }

    case "sms": {
      const digest = toSmsDigest(body.records);
      return new Response(digest, {
        headers: attachmentHeaders("text/plain; charset=utf-8", `deucalion-sms-${stamp}.txt`),
      });
    }
  }
}
