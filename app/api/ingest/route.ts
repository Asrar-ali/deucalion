/**
 * POST /api/ingest — multipart. Turns any front door into normalized, UNCLASSIFIED records.
 *
 * Deliberately calls no model: ingest must be fast so the table renders immediately and
 * labels stream in afterwards. It also holds no server state — the client keeps the records
 * and posts them to /api/classify. That makes "no server-side persistence" literally true,
 * and means a judge's upload cannot vanish when a serverless instance recycles.
 */

import { parseCsv } from "../../../lib/csv";
import { dedupe, detectEventProfile, focusProfile } from "../../../lib/prefilter";
import { knownPlaceAliases } from "../../../lib/geoparse";
import type { FloodRecord, FunnelCounts } from "../../../lib/types";

export const runtime = "nodejs";
// Uploads are user data, never cached.
export const dynamic = "force-dynamic";

const MAX_BYTES = 80 * 1024 * 1024; // Vercel functions accept 100MB bodies; leave headroom.

function newRecord(partial: Partial<FloodRecord> & { id: string; text: string }): FloodRecord {
  return {
    source: "csv",
    labels: {},
    places: [],
    review: "auto",
    classifier: "jev",
    ...partial,
  };
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with one of: file, image, images, url, text." },
      { status: 400 },
    );
  }

  const records: FloodRecord[] = [];
  const rejected: FunnelCounts["rejectedRows"] = [];
  let headers: string[] = [];
  let chosenColumn = "";
  let mapped: Record<string, string | undefined> = {};
  let rawCount = 0;

  // ---- CSV -----------------------------------------------------------------
  const file = form.get("file");
  if (file instanceof File) {
    if (file.size > MAX_BYTES) {
      return Response.json(
        { error: `File is ${(file.size / 1e6).toFixed(0)}MB. The limit is ${MAX_BYTES / 1e6}MB.` },
        { status: 413 },
      );
    }
    const forced = typeof form.get("column") === "string" ? String(form.get("column")) : undefined;
    const parsed = parseCsv(await file.text(), forced);

    headers = parsed.headers;
    chosenColumn = parsed.chosenColumn;
    mapped = parsed.mapped;
    rejected.push(...parsed.rejected);
    rawCount += parsed.rows.length;

    for (const row of parsed.rows) {
      records.push(
        newRecord({
          id: `c${row.row}`,
          source: "csv",
          text: row.text,
          ...(row.timestamp ? { timestamp: row.timestamp } : {}),
          ...(row.author || row.lat != null
            ? {
                provenance: {
                  ...(row.author ? { author: row.author } : {}),
                  fetchMethod: "manual" as const,
                },
              }
            : {}),
          // Coordinates and place text ride along for the geoparser to use later.
          ...(row.lat != null && row.lon != null
            ? {
                places: [
                  {
                    name: row.place || "Provided coordinates",
                    kind: "point",
                    lat: row.lat,
                    lon: row.lon,
                    confidence: 1,
                    method: "provided" as const,
                  },
                ],
              }
            : {}),
        }),
      );
    }
  }

  // ---- pasted text ---------------------------------------------------------
  const text = form.get("text");
  if (typeof text === "string" && text.trim()) {
    const split = form.get("split") === "lines";
    const chunks = split
      ? text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean)
      : [text.trim()];
    rawCount += chunks.length;
    chunks.forEach((chunk, i) => {
      records.push(
        newRecord({
          id: `t${Date.now()}_${i}`,
          source: "manual",
          text: chunk,
          provenance: { fetchMethod: "manual", fetchedAt: new Date().toISOString() },
        }),
      );
    });
  }

  // ---- images --------------------------------------------------------------
  // EXIF and vision run in /api/classify so ingest stays fast; here we only carry the file
  // forward as a data URL the client can render and re-post.
  const images = [
    ...form.getAll("image"),
    ...form.getAll("images"),
  ].filter((v): v is File => v instanceof File);

  for (const [i, img] of images.entries()) {
    if (img.size > MAX_BYTES) {
      rejected.push({ row: 0, reason: `image ${img.name} is too large` });
      continue;
    }
    const buf = Buffer.from(await img.arrayBuffer());
    rawCount++;
    records.push(
      newRecord({
        id: `i${Date.now()}_${i}`,
        source: "image",
        text: "", // filled by vision during classify
        imageRef: `data:${img.type || "image/jpeg"};base64,${buf.toString("base64")}`,
        provenance: { fetchMethod: "manual", fetchedAt: new Date().toISOString() },
      }),
    );
  }

  // ---- link ----------------------------------------------------------------
  const url = form.get("url");
  if (typeof url === "string" && url.trim()) {
    // Resolution lives in /api/resolve so a single link can be retried without re-ingesting.
    return Response.json(
      { needsResolve: true, url: url.trim() },
      { status: 202 },
    );
  }

  if (!records.length) {
    return Response.json(
      {
        error: "Nothing to ingest.",
        detail: rejected.length ? rejected.slice(0, 20) : undefined,
      },
      { status: 400 },
    );
  }

  // ---- dedupe + event profile ---------------------------------------------
  const textual = records.filter((r) => r.text.trim());
  const { kept, removed } = dedupe(textual.map((r) => ({ id: r.id, text: r.text })));
  const keptIds = new Set(kept.map((k) => k.id));
  const dupCount = new Map(kept.map((k) => [k.id, k.duplicateCount]));

  const deduped = records.filter((r) => !r.text.trim() || keptIds.has(r.id));
  for (const r of deduped) {
    const n = dupCount.get(r.id);
    if (n && n > 1) r.duplicateCount = n;
  }

  const profileTexts = deduped.map((r) => r.text).filter(Boolean);
  const profileOpts = { knownPlaces: knownPlaceAliases() };
  // Detection first, then focus. A single-event corpus passes through untouched. A mixed one
  // (the CE Strategies world feed) is focused on flooding deliberately, and the response says
  // so via profile.mixed / detectedHazard so the UI can explain rather than hide the choice.
  const profile = focusProfile(
    detectEventProfile(profileTexts, profileOpts),
    profileTexts,
    profileOpts,
  );

  const funnel: FunnelCounts = {
    raw: rawCount,
    deduped: deduped.length,
    prefiltered: 0,
    relevant: 0,
    mappable: 0,
    noPlaceMentioned: 0,
    rejectedRows: rejected.slice(0, 200), // enough to be useful, bounded for the wire
  };

  return Response.json({
    records: deduped,
    profile,
    funnel,
    detectedColumns: headers,
    chosenColumn,
    mappedColumns: mapped,
    duplicatesRemoved: removed,
  });
}
