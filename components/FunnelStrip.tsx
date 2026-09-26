"use client";

/**
 * The funnel. Every stage count, always visible.
 *
 * This is the component that makes the system auditable: a user can see that 8,024 rows became
 * 4,074 candidates became 3,218 relevant, and that 2,312 relevant records mention no place at
 * all. A tool that quietly shows 906 pins and never mentions the other 2,312 is lying by
 * omission, and it is the specific failure the sponsor complained about in existing tools.
 *
 * Rendered as one sentence plus a single proportional bar, not five tiles: the numbers are the
 * point, not the boxes around them.
 */

import { count, formatClassified, formatEta, formatRate, type RunProgress } from "../lib/display";
import type { FunnelCounts } from "../lib/types";

interface Stage {
  key: string;
  /** Sentence-case label for the disclosure list. */
  label: string;
  /** Lowercase word(s) used inline in the summary sentence. */
  word: string;
  value: number;
  hint: string;
}

export function FunnelStrip({
  funnel,
  progress,
  summary,
}: {
  funnel: FunnelCounts | null;
  progress: RunProgress | null;
  summary?: { n: number; ms: number } | null;
}) {
  if (!funnel) return null;

  const running = !!progress && progress.total > 0 && progress.done < progress.total;
  const eta = running && progress?.rate ? formatEta(progress.total - progress.done, progress.rate) : "";

  const stages: Stage[] = [
    { key: "raw", label: "Posts", word: "posts", value: funnel.raw, hint: "Rows accepted from the source." },
    {
      key: "deduped",
      label: "Unique",
      word: "unique",
      value: funnel.deduped,
      hint: "After collapsing exact duplicates and retweets of the same body.",
    },
    {
      key: "prefiltered",
      label: "Sent to the model",
      word: "sent to the model",
      value: funnel.prefiltered,
      hint: "Survived the local keyword pass. Everything else was answered for free, without a model call.",
    },
    {
      key: "relevant",
      label: "About the event",
      word: "about the event",
      value: funnel.relevant,
      hint: "Classified as about this hazard, or about the response to it.",
    },
    {
      key: "mappable",
      label: "On the map",
      word: "on the map",
      value: funnel.mappable,
      hint: "A place was resolved to coordinates.",
    },
  ];

  // Every rejected row lands in exactly one of three buckets, and the three always sum to the
  // total loaded: mapped, relevant-but-unplaced, or dropped somewhere before that (deduped away,
  // filtered locally, or classified not relevant). No row disappears silently.
  const total = Math.max(funnel.raw, 1);
  const mappablePct = (funnel.mappable / total) * 100;
  const noPlacePct = (funnel.noPlaceMentioned / total) * 100;
  const droppedPct = Math.max(0, 100 - mappablePct - noPlacePct);

  return (
    <section aria-labelledby="funnel-heading" className="border-b" style={{ borderColor: "var(--line)" }}>
      <h2 id="funnel-heading" className="sr-only">
        Processing funnel
      </h2>

      <div className="min-w-0 px-4 py-2">
        {/* The sentence carries all five stage counts; nothing here is decorative. */}
        <p className="text-sm leading-snug" style={{ color: "var(--text)" }}>
          {stages.map((stage, i) => (
            // The space between stages sits outside the nowrap span: inside it, the sentence had
            // no break opportunity and ran 616px wide on a 390px phone.
            <span key={stage.key}>
              <span className="whitespace-nowrap">
                <strong className="font-semibold">{count(stage.value)}</strong> {stage.word}
                {i < stages.length - 1 ? "," : "."}
              </span>
              {i < stages.length - 1 ? " " : ""}
            </span>
          ))}
        </p>

        {/* One proportional bar standing in for the five mini-bars: on the map, relevant but
            unplaced (striped, same treatment as the below-threshold fill elsewhere), and
            everything else. Purely visual restatement of the sentence above. */}
        <div aria-hidden="true" className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full">
          <div style={{ width: `${mappablePct}%`, background: "var(--accent)" }} />
          <div
            style={{
              width: `${noPlacePct}%`,
              backgroundImage: "repeating-linear-gradient(135deg, var(--review) 0 4px, var(--text) 4px 6px)",
            }}
          />
          <div style={{ width: `${droppedPct}%`, background: "var(--line)" }} />
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm" style={{ color: "var(--text-muted)" }}>
          {/* The stage meanings were only in hover titles; this makes them reachable by keyboard
              and touch as well (ACCESSIBILITY.md: nothing hover-only). */}
          <details className="min-w-0">
            <summary className="cursor-pointer">What do these numbers mean?</summary>
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 pb-1">
              {stages.map((stage) => (
                <div key={stage.key} className="contents">
                  <dt className="font-medium" style={{ color: "var(--text)" }}>
                    {stage.label}
                  </dt>
                  <dd>{stage.hint}</dd>
                </div>
              ))}
            </dl>
          </details>

          {funnel.noPlaceMentioned > 0 && (
            <span>
              <strong style={{ color: "var(--text)" }}>{count(funnel.noPlaceMentioned)}</strong> relevant posts name
              no place, so they are listed but not on the map.
            </span>
          )}

          {funnel.rejectedRows.length > 0 && (
            <details className="min-w-0">
              <summary className="cursor-pointer">
                <strong style={{ color: "var(--review)" }}>{count(funnel.rejectedRows.length)}</strong> rows skipped
              </summary>
              <ul className="mt-1 max-h-32 overflow-auto font-mono text-xs">
                {funnel.rejectedRows.slice(0, 50).map((r, i) => (
                  <li key={`${r.row}-${i}`}>
                    {r.row ? `row ${r.row}: ` : ""}
                    {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {/* Announce only start and done. The changing numbers below are not in a live region. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {running ? "Classification started" : summary ? formatClassified(summary.n, summary.ms) : ""}
      </div>

      {running && progress && (
        <div
          className="flex flex-wrap items-baseline gap-x-3 px-4 py-1 text-sm"
          style={{ background: "var(--accent-weak)", color: "var(--accent)" }}
        >
          <span>
            {progress.stage === "prefilter" ? "Filtering locally" : "Classifying"}{" "}
            {count(progress.done)} of {count(progress.total)}
          </span>
          {progress.rate ? (
            <span style={{ color: "var(--text-muted)" }}>
              {formatRate(progress.rate)}
              {eta ? `, ${eta}` : ""}
            </span>
          ) : null}
        </div>
      )}

      {!running && summary && (
        <div
          className="px-4 py-1 text-sm"
          style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}
        >
          {formatClassified(summary.n, summary.ms)}
        </div>
      )}
    </section>
  );
}
