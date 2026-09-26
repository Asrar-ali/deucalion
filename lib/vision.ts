/**
 * Gemini image understanding: scene description (for classification + alt text) and OCR
 * (for the screenshot fallback path — see docs/ARCHITECTURE.md 4.7: Facebook, Instagram and
 * Reddit block programmatic link resolution, so a user screenshots the post instead and this
 * is how we read it back out).
 *
 * Both exported functions return `null` on ANY failure — no key, quota, network, safety
 * block, malformed response — so the caller falls through to a text-only path. The app must
 * never blank because Gemini had a bad moment (docs/ARCHITECTURE.md 4.8).
 *
 * Honesty rules (docs/ARCHITECTURE.md section 8 — kill phrases):
 *  - The model never asserts a location from image content alone. `altText` and `caption`
 *    describe the SCENE (objects, water, weather), never a place, city or street name — if
 *    text in the image names a place, that belongs to `readImageText`'s transcription, and
 *    the existing geoparser (lib/geoparse.ts) decides what it means, not this module.
 *  - "verified" / "confirmed" are banned words. Stripped defensively below, because a model
 *    is not a compiler and does not reliably obey a system prompt.
 *  - `waterDepthCue` is a visible reference cue ("water at door-handle height"), never a
 *    measurement in centimetres or any unit.
 */

import { describeImageJson } from "./llm";
import type { Category, HazardType } from "./types";

const TIMEOUT_MS = 120_000;
const MAX_ALT_TEXT_LENGTH = 200;

const HAZARD_VALUES: readonly HazardType[] = ["flood", "fire", "quake", "storm", "other"];
const CATEGORY_VALUES: readonly Category[] = [
  "access_blocked",
  "evacuation",
  "rescue_request",
  "damage",
  "aid",
  "advisory",
  "sentiment",
];
const SUBMERGED_VALUES = [
  "road",
  "bridge",
  "house",
  "vehicle",
  "farmland",
  "business",
  "railway",
  "sidewalk",
  "none",
] as const;
type SubmergedItem = (typeof SUBMERGED_VALUES)[number];

const WATER_DEPTH_VALUES = ["none", "ankle", "knee", "waist", "above-waist", "unclear"] as const;
type WaterDepthCue = (typeof WATER_DEPTH_VALUES)[number];

export interface ImageDescription {
  /** REQUIRED. One factual sentence describing the visible scene, for screen-reader users. */
  altText: string;
  hazardVisible: boolean;
  hazard: HazardType;
  category: Category;
  submerged: SubmergedItem[];
  waterDepthCue: WaterDepthCue;
  /** The model's own stated confidence, 0..1. Not calibrated — see docs/ARCHITECTURE.md 4.4. */
  confidence: number;
  /** Short factual line usable as the record's `text` when the record has no text. */
  caption: string;
}

export interface ImageTextResult {
  /** The post's own body text, screen chrome excluded. Empty string if nothing readable. */
  text: string;
  isScreenshot: boolean;
  platform?: string;
}

type ImageInput = Buffer | ArrayBuffer | Uint8Array;

function toBase64(image: ImageInput): string {
  if (Buffer.isBuffer(image)) return image.toString("base64");
  if (image instanceof ArrayBuffer) return Buffer.from(image).toString("base64");
  return Buffer.from(image.buffer, image.byteOffset, image.byteLength).toString("base64");
}

const BANNED_WORDS = /\b(verified|confirmed)\b/gi;

function stripBannedWords(text: string): string {
  return text.replace(BANNED_WORDS, "reported").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/** Never trust the model's enum choice blindly — coerce anything unexpected to a safe default. */
function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const DESCRIBE_SCHEMA = {
  type: "object",
  properties: {
    altText: {
      type: "string",
      description:
        "One factual sentence describing the visible scene for a screen-reader user: " +
        "objects, water, colour, weather. Never name a place, city, street or landmark " +
        "(that is decided elsewhere from other evidence). Never use the words 'verified' or 'confirmed'.",
    },
    hazardVisible: {
      type: "boolean",
      description: "True only if a hazard is visibly depicted, not merely implied.",
    },
    hazard: {
      type: "string",
      enum: [...HAZARD_VALUES],
      description: "Best-guess hazard type visible in the image.",
    },
    category: {
      type: "string",
      enum: [...CATEGORY_VALUES],
      description: "What the image depicts operationally.",
    },
    submerged: {
      type: "array",
      items: { type: "string", enum: [...SUBMERGED_VALUES] },
      description: "Which listed things appear submerged. Use [\"none\"] if nothing is.",
    },
    waterDepthCue: {
      type: "string",
      enum: [...WATER_DEPTH_VALUES],
      description:
        "A visible reference cue for water depth, e.g. water reaching a car's wheel well. " +
        "This is a visual cue, NEVER a measurement in centimetres or any unit.",
    },
    confidence: {
      type: "number",
      description: "Your own confidence in this assessment, 0 to 1.",
    },
    caption: {
      type: "string",
      description: "Short factual caption usable as record text. Same rules as altText.",
    },
  },
  required: [
    "altText",
    "hazardVisible",
    "hazard",
    "category",
    "submerged",
    "waterDepthCue",
    "confidence",
    "caption",
  ],
};

/**
 * Describes what is visibly in an image for classification + a required alt-text string.
 * Returns `null` on any failure so the caller can fall through to a text-only path.
 */
export async function describeImage(
  image: ImageInput,
  mimeType: string,
): Promise<ImageDescription | null> {
  const prompt =
    "Describe only what is visibly depicted in this image for a flood-monitoring " +
    "tool: objects, water, weather, damage. Do not assert a place name, city, " +
    "street name or location — never guess where this was taken. Do not use the " +
    "words 'verified' or 'confirmed'. waterDepthCue is a visible reference cue, " +
    "never a measurement.";

  const parsed = await describeImageJson<Record<string, unknown>>(
    toBase64(image),
    mimeType,
    prompt,
    DESCRIBE_SCHEMA,
    { timeoutMs: TIMEOUT_MS },
  );

  if (!parsed) return null;

  const altTextRaw =
    typeof parsed.altText === "string" && parsed.altText.trim() ? parsed.altText : undefined;
  // altText is REQUIRED on success. Without one there is nothing honest to hand back.
  if (!altTextRaw) return null;

  const submergedRaw = Array.isArray(parsed.submerged) ? parsed.submerged : [];
  const submerged = submergedRaw.filter((s): s is SubmergedItem =>
    typeof s === "string" && (SUBMERGED_VALUES as readonly string[]).includes(s),
  );

  const confidenceRaw = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  const confidence = Math.min(1, Math.max(0, confidenceRaw));

  const captionRaw =
    typeof parsed.caption === "string" && parsed.caption.trim() ? parsed.caption : altTextRaw;

  return {
    altText: truncate(stripBannedWords(altTextRaw), MAX_ALT_TEXT_LENGTH),
    hazardVisible: parsed.hazardVisible === true,
    hazard: coerceEnum(parsed.hazard, HAZARD_VALUES, "other"),
    category: coerceEnum(parsed.category, CATEGORY_VALUES, "sentiment"),
    submerged: submerged.length ? submerged : ["none"],
    waterDepthCue: coerceEnum(parsed.waterDepthCue, WATER_DEPTH_VALUES, "unclear"),
    confidence,
    caption: truncate(stripBannedWords(captionRaw), MAX_ALT_TEXT_LENGTH),
  };
}

const OCR_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "The post's own text content, transcribed exactly. If this is a screenshot of a " +
        "social media post, transcribe ONLY the post's body text — never UI chrome such as " +
        "'Like Comment Share', reaction counts, timestamps or notification badges. Empty " +
        "string if there is no readable text.",
    },
    isScreenshot: {
      type: "boolean",
      description:
        "True if this looks like a screenshot of a social app (Facebook, Instagram, Reddit, " +
        "X/Twitter, etc.) rather than a photograph.",
    },
    platform: {
      type: "string",
      description:
        "Best guess at the platform shown in the screenshot chrome, lowercase (e.g. " +
        "'facebook', 'instagram', 'reddit', 'twitter'). Omit if not a screenshot or unclear.",
    },
  },
  required: ["text", "isScreenshot"],
};

/**
 * OCR for the screenshot fallback path. Returns the post's own text, not the surrounding
 * app chrome. Returns `null` on any failure so the caller can fall through to a text-only path.
 */
export async function readImageText(
  image: ImageInput,
  mimeType: string,
): Promise<ImageTextResult | null> {
  const prompt =
    "Transcribe only the post's own text if this is a screenshot of a social " +
    "media post. Exclude app UI chrome: like/comment/share counts, timestamps, " +
    "navigation bars, notification badges. If it is not a screenshot, transcribe " +
    "any readable text in the image, or return an empty string if there is none.";

  const parsed = await describeImageJson<Record<string, unknown>>(
    toBase64(image),
    mimeType,
    prompt,
    OCR_SCHEMA,
    { timeoutMs: TIMEOUT_MS },
  );

  if (!parsed) return null;

  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const isScreenshot = parsed.isScreenshot === true;
  const platformRaw =
    typeof parsed.platform === "string" ? parsed.platform.trim().toLowerCase() : "";

  return {
    text,
    isScreenshot,
    ...(platformRaw && platformRaw !== "unknown" ? { platform: platformRaw } : {}),
  };
}
