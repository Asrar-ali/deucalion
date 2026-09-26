/**
 * The trust primitives. Every place the interface makes a claim, it makes it through one of
 * these, so the honesty rules are enforced by construction rather than by remembering.
 *
 * Server components: no state, no effects, no client bundle cost.
 */

import {
  Barricade,
  ChatCircle,
  Crosshair,
  HandHeart,
  HouseLine,
  Lifebuoy,
  MapPin,
  Megaphone,
  PersonSimpleWalk,
  Question,
} from "@phosphor-icons/react/dist/ssr";
// The Icon type ships from the package root; only the components live under /dist/ssr.
import type { Icon } from "@phosphor-icons/react";

import {
  CATEGORY_META,
  CLASSIFIER_META,
  GEO_METHOD_META,
  SEVERITY_LABELS,
  pct,
  severityBand,
} from "../lib/display";
import { CONFIDENCE_GATE } from "../lib/questions";
import type { Category, FloodRecord, GeoMethod, PlaceHit } from "../lib/types";
import { resolveGauge } from "./gaugeState";
import { StaffGauge } from "./StaffGauge";

const ICONS: Record<string, Icon> = {
  Lifebuoy,
  Barricade,
  PersonSimpleWalk,
  HouseLine,
  Megaphone,
  HandHeart,
  ChatCircle,
};

const TONE_VAR: Record<string, { fg: string; bg: string }> = {
  urgent: { fg: "var(--urgent)", bg: "var(--urgent-weak)" },
  review: { fg: "var(--review)", bg: "var(--review-weak)" },
  settled: { fg: "var(--settled)", bg: "var(--settled-weak)" },
  inert: { fg: "var(--inert)", bg: "var(--inert-weak)" },
  accent: { fg: "var(--accent)", bg: "var(--accent-weak)" },
};

/** Category as icon + colour + text. Never any one of the three alone. */
export function CategoryTag({ category }: { category: Category | undefined }) {
  if (!category) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
        <Question size={14} aria-hidden />
        Unclassified
      </span>
    );
  }
  const meta = CATEGORY_META[category];
  const IconCmp = ICONS[meta.icon] ?? Question;
  const tone = TONE_VAR[meta.tone];

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color: tone.fg, background: tone.bg }}
      title={meta.hint}
    >
      <IconCmp size={13} weight="bold" aria-hidden />
      {meta.label}
      <span className="sr-only">: {meta.hint}</span>
    </span>
  );
}

/**
 * Confidence as a Staff Gauge: a vertical meter modelled on the graduated post read at river
 * gauging stations, filled to the confidence, with the review threshold painted on it like a
 * flood-stage mark. The number is always present: a bar alone is a vibe, and this model family
 * is documented as over-confident, so the reader is owed the actual figure.
 *
 * Pass `classifier` so rows labelled by local keyword rules show "no reading" instead of a
 * fill: their score is a ranking signal, not a probability. Pass `gate` for answers whose
 * review threshold differs from relevance (category 0.5, spam 0.7, personal details 0.3).
 */
export function ConfidenceMeter({
  value,
  label = "Confidence",
  compact = false,
  gate = CONFIDENCE_GATE.relevant,
  classifier,
  review,
}: {
  value: number | undefined;
  label?: string;
  compact?: boolean;
  gate?: number;
  classifier?: FloodRecord["classifier"];
  review?: FloodRecord["review"];
}) {
  const view = resolveGauge({
    decision: value == null ? undefined : { value: true, confidence: value },
    gate,
    classifier,
    review,
    answer: label,
  });
  return <StaffGauge view={view} gate={gate} size={compact ? "xs" : "sm"} />;
}

/** Severity as a three-step ladder. Reads as a shape even with colour stripped out. */
export function SeverityLadder({ score }: { score: number | undefined }) {
  const band = severityBand(score);
  const tone = band === 2 ? TONE_VAR.urgent : band === 1 ? TONE_VAR.review : TONE_VAR.inert;

  return (
    <span
      className="inline-flex items-end gap-0.5"
      title={`Severity: ${SEVERITY_LABELS[band]}${score != null ? ` (${score.toFixed(2)} of 2)` : ""}`}
      aria-label={`Severity ${SEVERITY_LABELS[band]}`}
    >
      {[0, 1, 2].map((step) => (
        <span
          key={step}
          className="block w-1 rounded-sm"
          style={{
            height: 4 + step * 3,
            background: step <= band ? tone.fg : "var(--surface-inset)",
          }}
        />
      ))}
      <span className="sr-only">{SEVERITY_LABELS[band]}</span>
    </span>
  );
}

/**
 * A place, with how we got it. The method is not decoration: EXIF is exact, a gazetteer match
 * is a guess, and a reader deciding whether to send a truck needs to know which one this is.
 */
export function PlaceChip({ place }: { place: PlaceHit }) {
  const meta = GEO_METHOD_META[place.method as GeoMethod];
  const exact = place.method !== "gazetteer";
  const IconCmp = exact ? Crosshair : MapPin;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs" title={meta.hint}>
      <IconCmp
        size={13}
        weight="bold"
        aria-hidden
        style={{ color: exact ? "var(--geo-exact)" : "var(--geo-inferred)" }}
      />
      <span style={{ color: "var(--text)" }}>{place.name}</span>
      <span className="sr-only">, {meta.hint}</span>
      <span className="font-mono" style={{ color: "var(--text-faint)" }}>
        {meta.label.toLowerCase()} {pct(place.confidence)}
      </span>
      {place.alternatives?.length ? (
        <span
          className="rounded px-1 font-mono"
          style={{ background: "var(--review-weak)", color: "var(--review)" }}
          title={`Also possible: ${place.alternatives.map((a) => a.name).join(", ")}`}
        >
          +{place.alternatives.length} other
          {/* title is hover-only; screen readers get the candidates as text. */}
          <span className="sr-only">: also possible {place.alternatives.map((a) => a.name).join(", ")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Says out loud when a row was not classified by the model. */
export function ClassifierTag({ classifier }: { classifier: FloodRecord["classifier"] }) {
  const meta = CLASSIFIER_META[classifier];
  const isModel = classifier !== "heuristic";
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs whitespace-nowrap"
      style={{
        color: isModel ? "var(--text-muted)" : "var(--review)",
        background: isModel ? "var(--surface-inset)" : "var(--review-weak)",
      }}
      title={meta.hint}
    >
      {meta.label}
      <span className="sr-only">: {meta.hint}</span>
    </span>
  );
}

/**
 * Community attribution. Deliberately understated: this is a 25km proximity match against a
 * community centroid, not a legal boundary determination, and the tooltip says so.
 */
export function CommunityTag({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
      style={{ color: "var(--accent)", background: "var(--accent-weak)" }}
      title="Matched by proximity to the community centroid, within 25km. Not a boundary determination."
    >
      {name}
      <span className="sr-only">, matched by proximity within 25 km, not a boundary</span>
    </span>
  );
}
