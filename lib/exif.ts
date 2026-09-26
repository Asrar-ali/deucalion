/**
 * EXIF GPS + timestamp extraction. No network, never throws.
 *
 * Why this matters: EXIF GPS is the only geo source in this whole system that is exact
 * rather than inferred — the gazetteer guesses a toponym from text, but a camera's GPS
 * chip recorded where the photo was actually taken. That is why `lib/geoparse.ts` treats
 * `method: "exif"` coordinates as outranking any text inference (see `geoparse()`, which
 * short-circuits on `input.lat`/`input.lon` before ever touching the gazetteer). It is
 * worth the extra care here: get it wrong and a report gets pinned to the wrong community.
 *
 * Images routinely arrive with no EXIF, stripped EXIF (every major social platform strips
 * it on upload), or corrupt EXIF from a re-encode. None of that is exceptional — it is the
 * common case — so this module reports absence as `{}` rather than throwing.
 */

import exifr from "exifr";

export interface ImageMeta {
  lat?: number;
  lon?: number;
  /** ISO 8601. Best of DateTimeOriginal / CreateDate / ModifyDate, in that order. */
  timestamp?: string;
  make?: string;
  model?: string;
}

/**
 * Rejects anything that isn't a real coordinate pair, including the (0,0) sentinel.
 * (0,0) is what a GPS-less camera or a stripped/zeroed EXIF block reports when it has
 * nothing — it is not a place off the coast of Ghana that people keep photographing.
 */
function isPlausibleCoord(lat: unknown, lon: unknown): lat is number {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

/** Coerces whatever shape exifr hands back for a date field into an ISO string. */
function toIso(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export async function readImageMeta(input: Buffer | ArrayBuffer): Promise<ImageMeta> {
  try {
    // Explicit segment list rather than exifr's defaults: we want gps + the tiff/exif tags
    // that carry Make/Model/dates, nothing else, regardless of which exifr build resolves.
    const tags = await exifr.parse(input, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: false,
      icc: false,
      iptc: false,
      jfif: false,
    });

    if (!tags) return {};

    const meta: ImageMeta = {};

    if (isPlausibleCoord(tags.latitude, tags.longitude)) {
      meta.lat = tags.latitude;
      meta.lon = tags.longitude;
    }

    const timestamp = toIso(tags.DateTimeOriginal ?? tags.CreateDate ?? tags.ModifyDate);
    if (timestamp) meta.timestamp = timestamp;

    const make = cleanString(tags.Make);
    if (make) meta.make = make;

    const model = cleanString(tags.Model);
    if (model) meta.model = model;

    return meta;
  } catch {
    // Corrupt/truncated/unsupported EXIF is routine, not exceptional. Degrade to "no metadata".
    return {};
  }
}
