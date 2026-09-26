/**
 * Turns FloodRecord[] into the formats a responder or a GIS analyst actually opens:
 * a MapAki-ready GeoJSON layer, a flat CSV, a printable brief, and an SMS digest for a
 * degraded link. See docs/ARCHITECTURE.md 4.6, 6, 7, 8 -- privacy, honest limits, kill
 * phrases. This module never fetches, never persists; it only reshapes what it is given.
 *
 * Field-name mapping used by both toGeoJSON and toCsv (documented once, reused everywhere,
 * per lib/display.ts's own rule that vocabulary lives in one place). Kept at or under 10
 * ASCII characters because Shapefile DBF truncates field names past that -- a GIS user
 * loading this through MapAki should never see two different columns collide into one.
 *
 *   id         record id
 *   text       display text (already PII-redacted when labels.has_pii is true)
 *   cat        category, machine value (lib/types.ts Category)
 *   cat_lbl    category, human label (lib/display.ts CATEGORY_META)
 *   sev        severity band, 0|1|2 (lib/display.ts severityBand)
 *   sev_lbl    severity band, human label (lib/display.ts SEVERITY_LABELS)
 *   rel_conf   confidence of the relevant decision, 0..1
 *   pl_conf    confidence of this specific place, 0..1
 *   geo_m      geo method, machine value (lib/types.ts GeoMethod)
 *   geo_lbl    geo method, human label (lib/display.ts GEO_METHOD_META)
 *   firsthand  true if the firsthand decision says this is a firsthand report
 *   clsfr      classifier that produced the labels: jev | laya | heuristic
 *   model_ver  exact model version string echoed by the provider, for the audit trail
 *   community  First Nations community name, if this place falls inside a reserve polygon
 *   src_url    source URL, if this record came from a link
 *   ts         record timestamp, if one was provided
 *   author     author handle -- present ONLY when options.includeAuthors is true
 *   lat / lon  CSV only (GeoJSON carries these in geometry.coordinates instead)
 */

import { CATEGORY_META, GEO_METHOD_META, SEVERITY_LABELS, severityBand } from "./display";
import type { Brief, Cluster, EventProfile, FloodRecord, FunnelCounts, PlaceHit } from "./types";

export interface ExportOptions {
  /** Author handles are hidden by default -- see docs/ARCHITECTURE.md 6. */
  includeAuthors?: boolean;
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

export interface GeoJsonFeatureProperties {
  id: string;
  text: string;
  cat?: string;
  cat_lbl?: string;
  sev: number;
  sev_lbl: string;
  rel_conf?: number;
  pl_conf: number;
  geo_m: string;
  geo_lbl: string;
  firsthand?: boolean;
  clsfr: string;
  model_ver?: string;
  community?: string;
  src_url?: string;
  ts?: string;
  author?: string;
}

export interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: GeoJsonFeatureProperties;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  /** [minLon, minLat, maxLon, maxLat]. Present only when there is at least one feature. */
  bbox?: [number, number, number, number];
}

export interface GeoJsonResult {
  collection: GeoJsonFeatureCollection;
  /** Records with zero resolved places, contributing zero features. Never hidden. */
  omittedNoPlace: number;
}

function featureProperties(
  record: FloodRecord,
  place: PlaceHit,
  options: ExportOptions,
): GeoJsonFeatureProperties {
  const category = record.labels.category?.value;
  const band = severityBand(record.labels.severity?.value);
  const geoMeta = GEO_METHOD_META[place.method];

  const properties: GeoJsonFeatureProperties = {
    id: record.id,
    text: record.text,
    sev: band,
    sev_lbl: SEVERITY_LABELS[band],
    pl_conf: place.confidence,
    geo_m: place.method,
    geo_lbl: geoMeta.label,
    clsfr: record.classifier,
  };

  if (category) {
    properties.cat = category;
    properties.cat_lbl = CATEGORY_META[category].label;
  }
  if (record.labels.relevant) properties.rel_conf = record.labels.relevant.confidence;
  if (record.labels.firsthand) properties.firsthand = record.labels.firsthand.value;
  if (record.modelVersion) properties.model_ver = record.modelVersion;
  if (place.community) properties.community = place.community.name;
  if (record.provenance?.sourceUrl) properties.src_url = record.provenance.sourceUrl;
  if (record.timestamp) properties.ts = record.timestamp;
  if (options.includeAuthors === true && record.provenance?.author) {
    properties.author = record.provenance.author;
  }

  return properties;
}

function computeBbox(features: GeoJsonFeature[]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * RFC 7946 order is [longitude, latitude] -- the opposite of how most people say a
 * coordinate out loud. Getting this backwards is the single most common GeoJSON bug and
 * it silently puts Calgary in Kazakhstan, so it is asserted explicitly in the test script
 * rather than trusted by inspection.
 */
export function toGeoJSON(records: FloodRecord[], options: ExportOptions = {}): GeoJsonResult {
  const features: GeoJsonFeature[] = [];
  let omittedNoPlace = 0;

  for (const record of records) {
    if (record.places.length === 0) {
      omittedNoPlace++;
      continue;
    }
    for (const place of record.places) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [place.lon, place.lat] },
        properties: featureProperties(record, place, options),
      });
    }
  }

  const collection: GeoJsonFeatureCollection = { type: "FeatureCollection", features };
  if (features.length > 0) collection.bbox = computeBbox(features);

  return { collection, omittedNoPlace };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  "id", "text", "cat", "cat_lbl", "sev", "sev_lbl", "rel_conf",
  "lat", "lon", "pl_conf", "geo_m", "geo_lbl", "firsthand", "clsfr",
  "model_ver", "community", "src_url", "ts",
] as const;

/**
 * A cell beginning =, +, -, @, tab or CR is read as a formula by Excel/Sheets regardless
 * of quoting. Prefixing a literal single quote is the standard mitigation: it is the same
 * character a person types to force a cell to text, and Excel strips it on display. We are
 * exporting attacker-supplied text (flood reports posted by the public) by definition, so
 * every field is run through this, not just the ones we expect to be free text.
 */
const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

function sanitizeFormula(value: string): string {
  return DANGEROUS_PREFIX.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote a field that contains a comma, quote or newline; double embedded quotes. */
function csvCell(value: string): string {
  const safe = sanitizeFormula(value);
  if (!/[",\n\r]/.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvFields(
  record: FloodRecord,
  place: PlaceHit | undefined,
  options: ExportOptions,
): Record<(typeof CSV_HEADERS)[number] | "author", string> {
  const category = record.labels.category?.value;
  const band = severityBand(record.labels.severity?.value);
  const geoMeta = place ? GEO_METHOD_META[place.method] : undefined;

  return {
    id: record.id,
    text: record.text,
    cat: category ?? "",
    cat_lbl: category ? CATEGORY_META[category].label : "",
    sev: String(band),
    sev_lbl: SEVERITY_LABELS[band],
    rel_conf: record.labels.relevant ? String(record.labels.relevant.confidence) : "",
    lat: place ? String(place.lat) : "",
    lon: place ? String(place.lon) : "",
    pl_conf: place ? String(place.confidence) : "",
    geo_m: place ? place.method : "",
    geo_lbl: geoMeta ? geoMeta.label : "",
    firsthand: record.labels.firsthand ? String(record.labels.firsthand.value) : "",
    clsfr: record.classifier,
    model_ver: record.modelVersion ?? "",
    community: place?.community?.name ?? "",
    src_url: record.provenance?.sourceUrl ?? "",
    ts: record.timestamp ?? "",
    author: options.includeAuthors === true ? record.provenance?.author ?? "" : "",
  };
}

/**
 * One row per resolved place, matching toGeoJSON's feature count, plus one blank-location
 * row for a record with no place at all -- a record is never silently dropped from the
 * audit trail just because it did not geocode. Starts with a UTF-8 BOM because Excel on
 * Windows otherwise mojibakes accented characters and any non-Latin script.
 */
export function toCsv(records: FloodRecord[], options: ExportOptions = {}): string {
  const headers = options.includeAuthors === true ? [...CSV_HEADERS, "author"] : [...CSV_HEADERS];
  const lines: string[] = [headers.join(",")];

  for (const record of records) {
    const places: Array<PlaceHit | undefined> = record.places.length > 0 ? record.places : [undefined];
    for (const place of places) {
      const fields = csvFields(record, place, options);
      lines.push(headers.map((h) => csvCell(fields[h as keyof typeof fields])).join(","));
    }
  }

  return `﻿${lines.join("\r\n")}`;
}

// ---------------------------------------------------------------------------
// Situation brief (Markdown)
// ---------------------------------------------------------------------------

function classifierMix(records: FloodRecord[]): {
  modelCount: number;
  ruleCount: number;
  modelVersions: string[];
} {
  let modelCount = 0;
  let ruleCount = 0;
  const versions = new Set<string>();
  for (const record of records) {
    if (record.classifier === "heuristic") {
      ruleCount++;
    } else {
      modelCount++;
      if (record.modelVersion) versions.add(record.modelVersion);
    }
  }
  return { modelCount, ruleCount, modelVersions: [...versions] };
}

function communityCounts(records: FloodRecord[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const place of record.places) {
      if (place.community) counts.set(place.community.name, (counts.get(place.community.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * A printable situation brief for an emergency manager, not a data dump. Every number is
 * computed here from the records actually being exported -- never copied from a stale
 * count -- and the wording is held to docs/ARCHITECTURE.md 8's kill-phrase list: no
 * "verified"/"confirmed" about a classified record, no claim about a number of people, no
 * "real-time", no bare "accurate".
 */
export function toBriefMarkdown(
  records: FloodRecord[],
  clusters: Cluster[],
  brief: Brief,
  profile: EventProfile,
  funnel: FunnelCounts,
): string {
  const generatedOn = new Date().toISOString().slice(0, 10);

  if (records.length === 0) {
    return [`# Situational brief (${generatedOn})`, "", "No records were provided for this brief."].join("\n");
  }

  const relevant = records.filter((r) => r.labels.relevant?.value === true);
  const mappable = relevant.filter((r) => r.places.length > 0);
  const noPlace = relevant.length - mappable.length;
  const { modelCount, ruleCount, modelVersions } = classifierMix(records);
  const communities = communityCounts(relevant);

  const lines: string[] = [];

  lines.push(`# Situational brief — ${profile.hazard} (draft, generated ${generatedOn})`);
  lines.push("");
  lines.push("## What this is");
  lines.push(
    "This brief is built from public posts run through an automated classifier. Every label " +
      "carries a confidence score and is a proposal for a person to check, not a settled fact. " +
      "It reflects one batch of records processed at generation time, not a live feed, and it " +
      "counts posts -- never people.",
  );
  lines.push("");
  lines.push(
    `Detected event: **${profile.hazard}**` +
      (profile.places.length ? `, near ${profile.places.slice(0, 5).join(", ")}` : "") +
      (profile.userEdited ? " (edited by a reviewer)." : " (auto-detected from the records; editable)."),
  );
  lines.push("");

  lines.push("## Coverage in this export");
  lines.push(`- ${records.length} record(s) in this export; ${relevant.length} classified relevant.`);
  lines.push(
    relevant.length > 0
      ? `- ${mappable.length} of ${relevant.length} relevant record(s) resolved to a mappable place; ${noPlace} mention no place at all.`
      : "- No relevant records resolved to a mappable place.",
  );
  lines.push(
    `- Classified by the decision model: ${modelCount} record(s); by local rules only ` +
      `(the model was unavailable or the record was filtered out before it ran): ${ruleCount} record(s).`,
  );
  lines.push(
    modelVersions.length
      ? `- Model version${modelVersions.length > 1 ? "s" : ""} in this export: ${modelVersions.join(", ")}.`
      : "- No model version recorded for this export (local rules only).",
  );
  lines.push("");

  if (communities.length) {
    lines.push("## First Nations communities named");
    for (const [name, count] of communities) lines.push(`- ${name}: ${count} record(s).`);
    lines.push("");
  }

  if (clusters.length) {
    lines.push("## Themes");
    for (const cluster of clusters) {
      const places = cluster.topPlaces.length
        ? ` -- top places: ${cluster.topPlaces.map((p) => `${p.name} (${p.count})`).join(", ")}`
        : "";
      lines.push(`- ${cluster.label} (${cluster.size})${places}`);
    }
    lines.push("");
  }

  lines.push("## Situation summary");
  lines.push(brief.extractive || "No summary available for this export.");
  lines.push("");

  if (brief.narrative?.length) {
    lines.push("## Notes (model-assisted, each line cites its source posts)");
    for (const sentence of brief.narrative) {
      lines.push(`- ${sentence.sentence} (sources: ${sentence.citedRecordIds.join(", ")})`);
    }
    lines.push("");
  }

  if (funnel.raw > 0) {
    lines.push("## Pipeline funnel for this upload");
    lines.push(
      `- ${funnel.raw} raw row(s) -> ${funnel.deduped} after removing duplicates -> ` +
        `${funnel.prefiltered} passed the local prefilter.`,
    );
    lines.push(
      `- ${funnel.relevant} classified relevant; ${funnel.mappable} resolved to a place; ` +
        `${funnel.noPlaceMentioned} mention no place.`,
    );
    if (funnel.rejectedRows.length) lines.push(`- ${funnel.rejectedRows.length} row(s) rejected during ingest.`);
    lines.push("");
  }

  lines.push("## Limits, stated plainly");
  lines.push(
    "- Every label above is a proposal with a confidence score from an automated classifier -- " +
      "a person should check anything used for a decision.",
  );
  lines.push("- This is a batch snapshot of public posts at generation time, not a live feed.");
  lines.push("- Location coverage is partial by nature; the count with no place is stated above, not hidden.");
  lines.push("- Counts above are of posts, not of people.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SMS digest
// ---------------------------------------------------------------------------

function smsScore(record: FloodRecord): number {
  const category = record.labels.category?.value;
  let score = 0;
  if (category === "rescue_request") score += 100;
  if (category === "access_blocked") score += 80;
  if (record.places.length > 0) score += 20;
  score += (record.labels.severity?.value ?? 0) * 5;
  if (record.labels.firsthand?.value === true) score += 5;
  return score;
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function snippetOf(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${truncateAtWordBoundary(text, Math.max(0, max - 3))}...`;
}

function smsLine(record: FloodRecord): string {
  const category = record.labels.category?.value;
  const label = category ? CATEGORY_META[category].label : "Report";
  const place = record.places[0]?.name;
  const snippet = snippetOf(record.text, 80);
  return place ? `${label} @ ${place}: ${snippet}` : `${label}: ${snippet}`;
}

/**
 * The most urgent, most specific items compressed for a text message -- for people without
 * a smartphone, and for satellite links too degraded for the web app. Rescue requests and
 * blocked routes with a resolved place sort first. Hard-truncated to maxChars without
 * cutting a word in half.
 */
export function toSmsDigest(records: FloodRecord[], maxChars = 480): string {
  if (records.length === 0) return "No records to report.";

  const relevant = records.filter((r) => r.labels.relevant?.value === true);
  if (relevant.length === 0) return "No relevant reports in this set.";

  const ranked = [...relevant].sort((a, b) => smsScore(b) - smsScore(a));

  const header = `Flood update, ${relevant.length} auto-classified post(s):`;
  const parts: string[] = [header];
  let used = header.length;

  for (const record of ranked) {
    const line = smsLine(record);
    const addedLength = line.length + 3; // " | " separator
    if (used + addedLength > maxChars) break;
    parts.push(line);
    used += addedLength;
  }

  return truncateAtWordBoundary(parts.join(" | "), maxChars);
}
