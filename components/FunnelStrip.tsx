"use client";

/**
 * The funnel. Every stage count, always visible.
 *
 * This is the component that makes the system auditable: a user can see that 8,024 rows became
 * 4,074 candidates became 3,218 relevant, and that 2,312 relevant records mention no place at
 * all. A tool that quietly shows 906 pins and never mentions the other 2,312 is lying by
 * omission, and it is the specific failure the sponsor complained about in existing tools.
 */

import { count } from "../lib/display";
import type { FunnelCounts } from "../lib/types";

interface Stage {
  key: string;
  label: string;
  value: number;
  hint: string;
}

export function FunnelStrip({
  funnel,
  progress,
}: {
  funnel: FunnelCounts | null;
  progress: { done: number; total: number; stage: string } | null;
}) {
  if (!funnel) return null;

  const stages: Stage[] = [
    { key: "raw", label: "Loaded", value: funnel.raw, hint: "Rows accepted from the source." },
    {
      key: "deduped",
      label: "Unique",
      value: funnel.deduped,
      hint: "After collapsing exact duplicates and retweets of the same body.",
    },
    {
      key: "prefiltered",
      label: "Worth checking",
      value: funnel.prefiltered,
      hint: "Survived the local keyword pass. Everything else was answered for free, without a model call.",
    },
    {
      key: "relevant",
      label: "Relevant",
      value: funnel.relevant,
      hint: "Classified as about this hazard, or about the response to it.",
    },
    {
      key: "mappable",
      label: "On the map",
      value: funnel.mappable,
      hint: "A place was resolved to coordinates.",
    },
  ];

  const widest = Math.max(...stages.map((s) => s.value), 1);

  return (
    <section aria-labelledby="funnel-heading" className="border-b" style={{ borderColor: "var(--line)" }}>
      <h2 id="funnel-heading" className="sr-only">
        Processing funnel
      </h2>

      <ol className="flex flex-wrap items-stretch">
        {stages.map((stage, i) => (
          <li
            key={stage.key}
            className="flex-1 min-w-[104px] border-r px-3 py-2 last:border-r-0"
            style={{ borderColor: "var(--line)" }}
            title={stage.hint}
          >
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-lg leading-none" style={{ color: "var(--text)" }}>
                {count(stage.value)}
              </span>
              {i > 0 && stages[i - 1].value > 0 && (
                <span className="font-mono text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {Math.round((stage.value / stages[i - 1].value) * 100)}%
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
              {stage.label}
            </div>
            {/* Width encodes the drop-off, so the shape of the funnel is readable at a glance
                without needing to compare five numbers. */}
            <div className="mt-1 h-0.5 rounded-full" style={{ background: "var(--surface-inset)" }}>
              <div
                className="h-0.5 rounded-full"
                style={{
                  width: `${Math.max(2, (stage.value / widest) * 100)}%`,
                  background: i >= 3 ? "var(--accent)" : "var(--inert)",
                }}
              />
            </div>
          </li>
        ))}
      </ol>

      {/* The honest counter. Deliberately given the same visual weight as the funnel itself. */}
      {(funnel.noPlaceMentioned > 0 || funnel.rejectedRows.length > 0) && (
        <div
          className="flex flex-wrap gap-x-5 gap-y-1 px-3 py-1.5 text-[11px]"
          style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}
        >
          {funnel.noPlaceMentioned > 0 && (
            <span>
              <strong className="font-mono" style={{ color: "var(--text)" }}>
                {count(funnel.noPlaceMentioned)}
              </strong>{" "}
              relevant, no place named. Listed below, not on the map.
            </span>
          )}
          {funnel.rejectedRows.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                <strong className="font-mono" style={{ color: "var(--review)" }}>
                  {count(funnel.rejectedRows.length)}
                </strong>{" "}
                rows skipped
              </summary>
              <ul className="mt-1 max-h-32 overflow-auto font-mono text-[10px]">
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
      )}

      {progress && progress.total > 0 && progress.done < progress.total && (
        <div
          className="px-3 py-1 text-[11px]"
          style={{ background: "var(--accent-weak)", color: "var(--accent)" }}
          aria-live="polite"
          aria-atomic="true"
        >
          {progress.stage === "prefilter" ? "Filtering locally" : "Classifying"}{" "}
          <span className="font-mono">
            {count(progress.done)} of {count(progress.total)}
          </span>
        </div>
      )}
    </section>
  );
}
