/**
 * CSV ingest. Judges upload an unseen file, so this has to survive unknown column names,
 * unknown delimiters, BOMs, and rows that are simply broken — without swallowing errors.
 *
 * Per WCAG 3.3 and plain decency, every rejected row is reported with its row number and
 * a reason. "Invalid CSV" is not an acceptable message.
 */

import Papa from "papaparse";

/** Column names we will pick up automatically, best guess first. */
const TEXT_COLUMN_CANDIDATES = [
  "text", "tweet", "tweet_text", "content", "body", "message", "post",
  "full_text", "description", "comment", "status", "caption",
];

const LAT_CANDIDATES = ["lat", "latitude", "y", "lat_dd"];
const LON_CANDIDATES = ["lon", "lng", "long", "longitude", "x", "lon_dd"];
const TIME_CANDIDATES = ["created_at", "timestamp", "date", "time", "datetime", "posted_at"];
const AUTHOR_CANDIDATES = ["author", "user", "username", "screen_name", "handle", "user_name"];
const PLACE_CANDIDATES = ["place", "location", "place_name", "city", "region", "geo"];

export interface ParsedCsv {
  rows: Array<{
    row: number;
    text: string;
    lat?: number;
    lon?: number;
    timestamp?: string;
    author?: string;
    place?: string;
  }>;
  headers: string[];
  chosenColumn: string;
  /** Other columns we mapped, so the ingest panel can show what it understood. */
  mapped: Record<string, string | undefined>;
  rejected: Array<{ row: number; reason: string }>;
}

/**
 * "Posted At", "posted_at", "posted-at" and "PostedAt" must all match the same candidate,
 * so punctuation collapses to a single underscore before comparing.
 */
function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pick(headers: string[], candidates: string[]): string | undefined {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }));

  for (const candidate of candidates) {
    const hit = normalized.find((h) => h.key === candidate);
    if (hit) return hit.raw;
  }

  // Partial match catches "tweet_text_cleaned" for "tweet_text". Short candidates are
  // EXCLUDED from this pass: "x" as a longitude alias otherwise matches the x inside
  // "Tweet Text", and a text column silently becomes a coordinate column.
  for (const candidate of candidates) {
    if (candidate.length < 4) continue;
    const hit = normalized.find((h) => h.key.includes(candidate));
    if (hit) return hit.raw;
  }

  // Last resort for short aliases: match a whole underscore-separated segment, so "x"
  // matches "geo_x" but never "text".
  for (const candidate of candidates) {
    if (candidate.length >= 4) continue;
    const hit = normalized.find((h) => h.key.split("_").includes(candidate));
    if (hit) return hit.raw;
  }

  return undefined;
}

/**
 * Chooses the text column when no header matches a known name: the column whose values
 * look most like prose — longest average length, and mostly not numeric.
 */
function inferTextColumn(headers: string[], sample: Array<Record<string, string>>): string {
  let best = headers[0];
  let bestScore = -1;

  for (const h of headers) {
    const values = sample.map((r) => r[h] ?? "").filter(Boolean);
    if (!values.length) continue;
    const avgLen = values.reduce((a, v) => a + v.length, 0) / values.length;
    const numericShare = values.filter((v) => /^[\d.,\s-]+$/.test(v)).length / values.length;
    const spaceShare = values.filter((v) => v.includes(" ")).length / values.length;
    // Prose is long, contains spaces, and is rarely all digits.
    const score = avgLen * (1 - numericShare) * (0.5 + spaceShare / 2);
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCsv(input: string, forcedColumn?: string): ParsedCsv {
  // Strip a UTF-8 BOM. Left in place it becomes part of the first header name and every
  // column lookup silently misses.
  const text = input.replace(/^﻿/, "");

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    // "greedy" also treats a whitespace-only line as empty and drops it before we ever
    // see it — a row whose text is only spaces then vanishes with no rejection, which
    // breaks the "never swallowed" rule. Plain `true` only skips genuinely zero-length
    // lines, so a whitespace-only row still reaches the per-row check below and gets
    // rejected with its real row number.
    skipEmptyLines: true,
    // Empty string means "sniff it" — handles tab- and semicolon-delimited uploads.
    delimiter: "",
    transformHeader: (h) => h.trim(),
  });

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  if (!headers.length) {
    return {
      rows: [], headers: [], chosenColumn: "", mapped: {},
      rejected: [{ row: 0, reason: "no header row found — is this a CSV?" }],
    };
  }

  const data = parsed.data ?? [];
  const chosenColumn =
    forcedColumn && headers.includes(forcedColumn)
      ? forcedColumn
      : pick(headers, TEXT_COLUMN_CANDIDATES) ?? inferTextColumn(headers, data.slice(0, 200));

  const mapped = {
    text: chosenColumn,
    lat: pick(headers, LAT_CANDIDATES),
    lon: pick(headers, LON_CANDIDATES),
    timestamp: pick(headers, TIME_CANDIDATES),
    author: pick(headers, AUTHOR_CANDIDATES),
    place: pick(headers, PLACE_CANDIDATES),
  };

  const rows: ParsedCsv["rows"] = [];
  const rejected: ParsedCsv["rejected"] = [];

  data.forEach((raw, i) => {
    const rowNumber = i + 2; // +1 for zero-index, +1 for the header line
    const value = (raw[chosenColumn] ?? "").trim();
    if (!value) {
      rejected.push({ row: rowNumber, reason: `column "${chosenColumn}" was empty` });
      return;
    }
    const lat = mapped.lat ? num(raw[mapped.lat]) : undefined;
    const lon = mapped.lon ? num(raw[mapped.lon]) : undefined;
    // Only trust a coordinate pair that is actually on Earth.
    const geoOk =
      lat != null && lon != null &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0); // 0,0 is the classic "missing data" sentinel

    rows.push({
      row: rowNumber,
      text: value,
      ...(geoOk ? { lat, lon } : {}),
      ...(mapped.timestamp && raw[mapped.timestamp] ? { timestamp: raw[mapped.timestamp] } : {}),
      ...(mapped.author && raw[mapped.author] ? { author: raw[mapped.author] } : {}),
      ...(mapped.place && raw[mapped.place] ? { place: raw[mapped.place] } : {}),
    });
  });

  // Papaparse reports structural problems per row; surface them rather than hiding them.
  // Exception: "UndetectableDelimiter" is not a row problem at all — Papa emits it whenever
  // there is not enough information to compare candidate delimiters (a single-column file,
  // which is exactly the shape of the provided dataset's `tweet` column, or a one-line
  // file). It always carries `row: undefined`, so surfacing it verbatim would attach a
  // confusing, wrong-looking "row 2" complaint to every single-column upload even though
  // the parse is completely correct. Real splitting mistakes still show up as their own
  // TooFewFields/TooManyFields errors below, which DO carry a real row.
  for (const err of parsed.errors ?? []) {
    if (err.code === "UndetectableDelimiter") continue;
    rejected.push({
      row: (err.row ?? 0) + 2,
      reason: err.message || String(err.type),
    });
  }

  // A header row with zero data rows parses "successfully" with nothing to show for it.
  // Say so plainly instead of returning an empty rejected list next to zero rows, which
  // reads like the parse silently swallowed something.
  if (data.length === 0) {
    rejected.push({ row: 1, reason: "header row found, but the file has no data rows" });
  }

  return { rows, headers, chosenColumn, mapped, rejected };
}
