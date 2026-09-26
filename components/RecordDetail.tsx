"use client";

/**
 * One post, and how it got here. Demo beat: "every point tells you how it got here and how
 * sure it is." Every claim on this panel is a proposal with its confidence and its method.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, X } from "@phosphor-icons/react/dist/ssr";

import { CATEGORY_META, SEVERITY_LABELS, severityBand } from "../lib/display";
import { CONFIDENCE_GATE } from "../lib/questions";
import type { FloodRecord } from "../lib/types";
import { CategoryTag, ClassifierTag, CommunityTag, PlaceChip, SeverityLadder } from "./Signals";
import { StaffGauge } from "./StaffGauge";
import { resolveGauge } from "./gaugeState";

export type ReviewAction = "confirmed" | "rejected";

export function RecordDetail({
  record,
  hazardNoun,
  onClose,
  onReview,
}: {
  record: FloodRecord;
  /** e.g. "the flood", from the detected event profile. */
  hazardNoun: string;
  onClose: () => void;
  onReview: (id: string, action: ReviewAction) => void;
}) {
  const [showAuthor, setShowAuthor] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { labels } = record;
  const category = labels.category?.value;

  // Move focus into the panel when it opens, so keyboard and screen-reader users land on it.
  useEffect(() => {
    heading.current?.focus();
    setShowAuthor(false);
  }, [record.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const relevance = resolveGauge({
    decision: labels.relevant,
    gate: CONFIDENCE_GATE.relevant,
    classifier: record.classifier,
    review: record.review,
    answer:
      labels.relevant?.value === false ? `Sure it's not about ${hazardNoun}` : `Sure it's about ${hazardNoun}`,
  });
  const categoryGauge = category
    ? resolveGauge({
        decision: labels.category,
        gate: CONFIDENCE_GATE.category,
        classifier: record.classifier,
        review: record.review === "rejected" ? "rejected" : "auto",
        answer: `Sure of category: ${CATEGORY_META[category].label}`,
      })
    : null;

  const via = labels.relevant?.via;
  const why =
    via === "response" ? "Describes the emergency response" : via === "hazard" ? `Describes ${hazardNoun} itself` : null;
  const band = severityBand(labels.severity?.value);

  return (
    <section
      aria-labelledby="detail-heading"
      className="flex flex-col gap-3 p-4 text-sm"
      style={{ background: "var(--surface-raised)", color: "var(--text)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1"
          style={{ border: "1px solid var(--line-strong)", color: "var(--text-muted)" }}
        >
          <ArrowLeft size={14} aria-hidden /> Back to the list
        </button>
        {/* Visible, so the focus ring that lands here on open can be seen (an sr-only target
            hid it from sighted keyboard users). */}
        <h2 id="detail-heading" ref={heading} tabIndex={-1} className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
          Report details
        </h2>
      </div>

      <div className="flex items-start gap-4">
        <StaffGauge view={relevance} gate={CONFIDENCE_GATE.relevant} size="lg" />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTag category={category} />
            {relevance.state === "below" && (
              <span className="rounded px-1.5 py-0.5 text-xs font-semibold" style={{ background: "var(--review-weak)" }}>
                Needs checking
              </span>
            )}
          </div>
          <p className="text-[15px] leading-relaxed">{record.text || "No text. This report is a photo."}</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {relevance.label}
            {relevance.number && relevance.state !== "below" ? `: ${relevance.number}` : ""}
          </p>
        </div>
      </div>

      {record.imageRef && (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the upload, not a remote asset
        <img
          width={640}
          height={360}
          loading="lazy"
          src={record.imageRef}
          onError={(e) => {
            // A missing image showed a broken alt-text box; hide it, the alt text is in the caption.
            e.currentTarget.style.display = "none";
          }}
          alt={record.imageAlt ?? ""}
          className="max-h-60 w-full rounded object-contain"
          style={{ border: "1px solid var(--line)" }}
        />
      )}

      {labels.has_pii?.value && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Personal details were removed from this post before it was shown or sent anywhere.
        </p>
      )}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
        {why && (
          <>
            <dt style={{ color: "var(--text-muted)" }}>Why</dt>
            <dd>{why}</dd>
          </>
        )}

        {categoryGauge && category && (
          <>
            <dt style={{ color: "var(--text-muted)" }}>Category</dt>
            <dd className="flex items-center gap-2">
              {CATEGORY_META[category].label}
              {categoryGauge.number && (
                <span style={{ color: "var(--text-faint)" }} title={categoryGauge.ariaText}>
                  {categoryGauge.number}
                </span>
              )}
            </dd>
          </>
        )}

        <dt style={{ color: "var(--text-muted)" }}>Location</dt>
        <dd className="flex flex-col gap-1.5">
          {record.places.length === 0 && <span>Names no place, so it is listed but not on the map</span>}
          {record.places.map((place) => (
            <div key={`${place.name}-${place.lat}`} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <PlaceChip place={place} />
                {place.kind && (
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {place.kind}
                  </span>
                )}
                {place.community && <CommunityTag name={place.community.name} />}
              </div>
              {place.alternatives?.length ? (
                <details className="text-xs" style={{ color: "var(--text-muted)" }}>
                  <summary className="cursor-pointer">Other possible places</summary>
                  <ul className="mt-1 list-disc pl-5">
                    {place.alternatives.map((alt) => (
                      <li key={`${alt.name}-${alt.lat}`}>{alt.name}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ))}
        </dd>

        {labels.severity && (
          <>
            <dt style={{ color: "var(--text-muted)" }}>Urgency</dt>
            <dd className="flex items-center gap-2">
              <SeverityLadder score={labels.severity.value} />
              {SEVERITY_LABELS[band]}
            </dd>
          </>
        )}

        {labels.firsthand && (
          <>
            <dt style={{ color: "var(--text-muted)" }}>Seen firsthand</dt>
            <dd>{labels.firsthand.value ? "Yes, the author describes what they saw" : "No, reshared or reported"}</dd>
          </>
        )}

        <dt style={{ color: "var(--text-muted)" }}>Classified by</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <ClassifierTag classifier={record.classifier} />
          {record.modelVersion && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {record.modelVersion}
            </span>
          )}
        </dd>

        {record.provenance?.author && (
          <>
            <dt style={{ color: "var(--text-muted)" }}>Author</dt>
            <dd>
              {showAuthor ? (
                <span>@{record.provenance.author}</span>
              ) : (
                <button type="button" className="underline" onClick={() => setShowAuthor(true)}>
                  Reveal author
                </button>
              )}
            </dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
        {record.review === "auto" ? (
          <>
            <button
              type="button"
              onClick={() => onReview(record.id, "confirmed")}
              className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 font-medium"
              style={{ background: "var(--accent)", color: "var(--accent-text)" }}
            >
              <Check size={14} aria-hidden /> Mark as checked
            </button>
            <button
              type="button"
              onClick={() => onReview(record.id, "rejected")}
              className="inline-flex items-center gap-1.5 rounded px-3 py-1.5"
              style={{ border: "1px solid var(--line-strong)", color: "var(--text)" }}
            >
              <X size={14} aria-hidden /> Not about {hazardNoun}
            </button>
          </>
        ) : (
          <span className="text-xs font-medium">
            {record.review === "confirmed" ? "Checked by a person" : "Rejected by a person"}. Recorded in the review log.
          </span>
        )}
      </div>
    </section>
  );
}
