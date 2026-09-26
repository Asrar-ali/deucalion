/**
 * The one contract both builders code against.
 * Every front door (CSV, image, link, voice) produces a Record.
 * The UI never learns where a record came from.
 */

export type SourceKind = "csv" | "image" | "link" | "manual" | "voice";

export type GeoMethod = "provided" | "exif" | "gazetteer";

export type HazardType = "flood" | "fire" | "quake" | "storm" | "other";

export type Category =
  | "access_blocked" // roads, bridges, closures
  | "evacuation" // evacuation or displacement
  | "rescue_request" // someone needs help now
  | "damage" // property or infrastructure damage
  | "aid" // donations, volunteering, relief
  | "advisory" // official warnings, advice
  | "sentiment"; // solidarity, opinion, no operational content

/** A single typed answer from the decision model. Always carries confidence. */
export interface Decision<T = unknown> {
  value: T;
  /** 0..1. Gate behaviour on THIS, never on act_probability. */
  confidence: number;
  /** Present for choice/score questions. */
  distribution?: Record<string, number> | number[];
}

export interface PlaceHit {
  name: string;
  lat: number;
  lon: number;
  /** 0..1 — how sure we are this is the right place, not that a place was mentioned. */
  confidence: number;
  method: GeoMethod;
  /** Other gazetteer candidates we did not pick. Shown in the UI on demand. */
  alternatives?: Array<{ name: string; lat: number; lon: number }>;
  /** Set when the point falls inside a First Nations reserve polygon. */
  community?: { name: string; id: string };
}

export interface Provenance {
  sourceUrl?: string;
  fetchMethod?: "oembed" | "api" | "readability" | "ocr" | "manual";
  fetchedAt?: string;
  /** Hidden by default in the UI. Revealable per record. */
  author?: string;
}

export interface RecordLabels {
  relevant?: Decision<boolean>;
  hazard?: Decision<HazardType>;
  category?: Decision<Category>;
  /** 0..2 — background / notable / urgent */
  severity?: Decision<number>;
  has_place?: Decision<boolean>;
  is_request?: Decision<boolean>;
  has_pii?: Decision<boolean>;
  is_spam?: Decision<boolean>;
  firsthand?: Decision<boolean>;
}

export interface FloodRecord {
  id: string;
  source: SourceKind;

  /** Display text. Already PII-redacted when labels.has_pii is true. */
  text: string;
  /** Original text before redaction. Never sent to Gemini. Never rendered by default. */
  rawText?: string;

  imageRef?: string;
  /** Gemini-generated alt text. Required whenever imageRef is set. */
  imageAlt?: string;

  timestamp?: string;
  provenance?: Provenance;

  labels: RecordLabels;
  places: PlaceHit[];

  review: "auto" | "confirmed" | "rejected";

  /** How this record was classified. "heuristic" = circuit breaker was open. */
  classifier: "jev" | "laya" | "heuristic";
  /** Exact model version string echoed by the provider, for the audit trail. */
  modelVersion?: string;

  /** Collapsed near-duplicates. 1 means unique. */
  duplicateCount?: number;
}

/** Derived from the corpus, shown to the user, editable. This is how we generalise. */
export interface EventProfile {
  hazard: HazardType;
  /** Place names that dominate the corpus. */
  places: string[];
  /** Distinctive terms used to score similarity. */
  terms: string[];
  /** True when the user edited it — we stop overwriting. */
  userEdited: boolean;
}

/** Every stage count is displayed. No silent drops. */
export interface FunnelCounts {
  raw: number;
  deduped: number;
  prefiltered: number;
  relevant: number;
  mappable: number;
  noPlaceMentioned: number;
  rejectedRows: Array<{ row: number; reason: string }>;
}

export interface SpendState {
  /** Real dollars, summed from provider usage.cost. */
  used: number;
  budget: number;
  unlimited: boolean;
  /** Circuit breaker open => results are heuristic-labelled. */
  degraded: boolean;
}

export interface Cluster {
  id: string;
  /** Distinctive terms, extractive. Never model-generated. */
  label: string;
  recordIds: string[];
  size: number;
  representativeIds: string[];
  topPlaces: Array<{ name: string; count: number }>;
}

export interface Brief {
  /** Extractive, deterministic, always present. */
  extractive: string;
  /** Gemini narrative. Every sentence cites recordIds. Absent if Gemini unavailable. */
  narrative?: Array<{ sentence: string; citedRecordIds: string[] }>;
  /** Grade ~6 rewrite for the plain-language toggle. */
  plainLanguage?: string;
}
