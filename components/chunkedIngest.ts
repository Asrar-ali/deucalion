"use client";

/**
 * Large CSV upload. Vercel caps a request body at ~4.5 MB and a response at the same, so the
 * 6.3 MB / 61k-row bonus file failed with a plain-text "Request Entity Too Large" that the
 * client then tried to parse as JSON. Files over the threshold are split in the browser into
 * row chunks, each posted to /api/ingest on its own, then merged: ids made unique per chunk,
 * exact duplicates collapsed across chunks, and the event profile recomputed over everything.
 */

import Papa from "papaparse";

import { knownPlaceAliases } from "../lib/geoparse";
import { detectEventProfile, normalize } from "../lib/prefilter";
import type { FloodRecord } from "../lib/types";
import type { IngestResult } from "./Intake";

export const CHUNK_THRESHOLD_BYTES = 3_000_000;
const ROWS_PER_CHUNK = 6000;

/** Reads an ingest response that may not be JSON (Vercel's 413 page is plain text). */
export async function readIngestResponse(res: Response): Promise<IngestResult & { error?: string }> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as IngestResult & { error?: string };
  } catch {
    const reason =
      res.status === 413
        ? "This file is too large to send in one piece."
        : `The server answered ${res.status} ${res.statusText || ""}`.trim();
    return { error: `${reason} ${raw.slice(0, 80)}`.trim() } as IngestResult & { error?: string };
  }
}

export async function ingestLargeCsv(
  file: File,
  column: string | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<IngestResult> {
  const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: true });
  const [header, ...rows] = parsed.data;
  if (!header || rows.length === 0) throw new Error("The file has no rows after the header.");

  const chunkCount = Math.ceil(rows.length / ROWS_PER_CHUNK);
  const merged: FloodRecord[] = [];
  const byText = new Map<string, FloodRecord>();
  let raw = 0;
  let duplicatesRemoved = 0;
  let first: IngestResult | undefined;
  const rejectedRows: IngestResult["funnel"]["rejectedRows"] = [];

  for (let c = 0; c < chunkCount; c++) {
    const slice = rows.slice(c * ROWS_PER_CHUNK, (c + 1) * ROWS_PER_CHUNK);
    const csv = Papa.unparse([header, ...slice]);
    const form = new FormData();
    form.set("file", new File([csv], `${file.name}.part${c + 1}.csv`, { type: "text/csv" }));
    if (column) form.set("column", column);

    const res = await fetch("/api/ingest", { method: "POST", body: form });
    const data = await readIngestResponse(res);
    if (!res.ok || data.error) {
      throw new Error(`Part ${c + 1} of ${chunkCount}: ${data.error ?? `ingest failed (${res.status})`}`);
    }
    first ??= data;
    raw += data.funnel.raw;
    duplicatesRemoved += data.duplicatesRemoved ?? 0;
    const offset = c * ROWS_PER_CHUNK;
    for (const r of data.funnel.rejectedRows) {
      rejectedRows.push({ ...r, row: r.row ? r.row + offset : r.row });
    }
    for (const record of data.records) {
      const key = record.text ? normalize(record.text) : "";
      const existing = key ? byText.get(key) : undefined;
      if (existing) {
        existing.duplicateCount = (existing.duplicateCount ?? 1) + (record.duplicateCount ?? 1);
        duplicatesRemoved++;
        continue;
      }
      const unique = { ...record, id: `k${c}_${record.id}` };
      if (key) byText.set(key, unique);
      merged.push(unique);
    }
    onProgress(c + 1, chunkCount);
  }

  const profile = detectEventProfile(
    merged.map((r) => r.text).filter(Boolean),
    { knownPlaces: knownPlaceAliases() },
  );

  return {
    records: merged,
    profile,
    funnel: {
      raw,
      deduped: merged.length,
      prefiltered: 0,
      relevant: 0,
      mappable: 0,
      noPlaceMentioned: 0,
      rejectedRows: rejectedRows.slice(0, 200),
    },
    detectedColumns: first?.detectedColumns,
    chosenColumn: first?.chosenColumn,
    mappedColumns: first?.mappedColumns,
    duplicatesRemoved,
  };
}
