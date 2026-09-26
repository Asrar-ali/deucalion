"use client";

/**
 * The text equivalent of the map, and the primary surface for anyone using a screen reader,
 * a keyboard, or a phone on a bad connection.
 *
 * This is not a lesser fallback. It carries the same records, the same filters and the same
 * confidences as the map, because a map is unusable with assistive technology and a crisis
 * tool that only works for sighted mouse users is not finished. See docs/ACCESSIBILITY.md.
 */

import { useMemo, useState } from "react";
import { CaretDown, CaretUp, Image as ImageIcon, Link as LinkIcon, Microphone, Table } from "@phosphor-icons/react/dist/ssr";

import { CATEGORY_META, count, severityBand } from "../lib/display";
import { CONFIDENCE_GATE } from "../lib/questions";
import {
  CategoryTag,
  ClassifierTag,
  CommunityTag,
  PlaceChip,
  SeverityLadder,
} from "./Signals";
import { StaffGauge } from "./StaffGauge";
import { resolveGauge } from "./gaugeState";
import type { FloodRecord } from "../lib/types";

export type SortKey = "severity" | "confidence" | "category" | "place";

const SOURCE_ICON = {
  csv: Table,
  image: ImageIcon,
  link: LinkIcon,
  voice: Microphone,
  manual: Table,
} as const;

export function RecordsTable({
  records,
  selectedId,
  onSelect,
  sort,
  onSortChange,
  totalBeforeFilter,
}: {
  records: FloodRecord[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  sort: { key: SortKey; desc: boolean };
  onSortChange: (sort: { key: SortKey; desc: boolean }) => void;
  totalBeforeFilter: number;
}) {
  // How many rows are actually mounted. Every row carries a gauge, tags and place chips, so
  // mounting all of them costs about 30 DOM nodes apiece. A flood-focused world file has
  // thousands of matching rows, so mounting every one on each streamed refresh is a lot of DOM
  // (an estimate from the row markup, not a measured slowdown). Windowing the DOM keeps the cost
  // constant whatever the file size. The rows shown are the top of the current sort, which by
  // default is urgency, so what a responder needs first is what is on screen. The map still
  // plots everything, and the count below says plainly how many rows are not yet shown.
  const PAGE = 200;
  const [limit, setLimit] = useState(PAGE);

  const sorted = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    const value = (r: FloodRecord): number | string => {
      switch (sort.key) {
        case "severity":
          return severityBand(r.labels.severity?.value);
        case "confidence":
          return r.labels.relevant?.confidence ?? 0;
        case "category":
          return r.labels.category?.value ?? "zzz";
        case "place":
          return r.places[0]?.name ?? "zzz";
      }
    };
    return [...records].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
  }, [records, sort]);

  const toggleSort = (key: SortKey) =>
    onSortChange({ key, desc: sort.key === key ? !sort.desc : true });

  if (!records.length) {
    return (
      <div className="px-4 py-10 text-center" style={{ color: "var(--text-muted)" }}>
        <p className="text-sm">
          {totalBeforeFilter === 0
            ? "No relevant reports yet. Posts still being classified, and posts classified as unrelated, are not listed here."
            : `None of the ${count(totalBeforeFilter)} records match these filters.`}
        </p>
        {totalBeforeFilter > 0 && (
          <p className="mt-1 text-xs" style={{ color: "var(--text-faint)" }}>
            Widen the confidence threshold or clear a category to see more.
          </p>
        )}
      </div>
    );
  }

  const SortHeader = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th
      scope="col"
      className="px-2 py-1.5 text-left font-medium"
      // aria-sort belongs on the column header, not the button inside it: screen readers
      // ignore it on a button (axe: aria-allowed-attr, critical).
      aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:underline"
      >
        {children}
        {sort.key === k &&
          (sort.desc ? <CaretDown size={10} aria-hidden /> : <CaretUp size={10} aria-hidden />)}
      </button>
    </th>
  );

  return (
    // relative: the sr-only spans in cells are position:absolute; without a positioned ancestor
    // they escape this scroll box and widen the whole page on phones (horizontal scroll).
    <div className="relative overflow-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          {count(records.length)} flood reports, sortable. Each row gives the report text, what it
          was classified as, how confident that classification is, and where it was placed.
        </caption>
        <thead
          className="sticky top-0 z-10"
          style={{ background: "var(--surface-sunken)", color: "var(--text-muted)" }}
        >
          <tr style={{ borderBottom: "1px solid var(--line)" }}>
            <th scope="col" className="w-6 px-2 py-1.5">
              <span className="sr-only">Source</span>
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">
              Report
            </th>
            <SortHeader k="category">What</SortHeader>
            <SortHeader k="severity">Urgency</SortHeader>
            <SortHeader k="confidence">Relevance</SortHeader>
            <SortHeader k="place">Where</SortHeader>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, limit).map((record) => {
            const selected = record.id === selectedId;
            const Icon = SOURCE_ICON[record.source] ?? Table;
            const community = record.places.find((p) => p.community)?.community;
            const relevantGauge = resolveGauge({
              decision: record.labels.relevant,
              gate: CONFIDENCE_GATE.relevant,
              classifier: record.classifier,
              review: record.review,
              answer:
                record.labels.relevant?.value === false
                  ? "Sure it's not about the event"
                  : "Sure it's about the event",
            });

            return (
              <tr
                key={record.id}
                onClick={() => onSelect(selected ? null : record.id)}
                aria-current={selected ? "true" : undefined}
                className="cursor-pointer align-top"
                style={{
                  borderBottom: "1px solid var(--line)",
                  background: selected ? "var(--accent-weak)" : undefined,
                }}
              >
                <td className="px-2 py-2">
                  <Icon
                    size={13}
                    role="img"
                    aria-label={`Source: ${record.source}`}
                    style={{ color: "var(--text-faint)" }}
                  />
                </td>

                <td className="px-2 py-2" style={{ maxWidth: "38ch" }}>
                  {/* Focusable so keyboard users can reach every row without a mouse, and so
                      the row can be opened with Enter like any other control. */}
                  <button
                    type="button"
                    className="block text-left"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(selected ? null : record.id);
                    }}
                  >
                    <span style={{ color: "var(--text)" }}>{record.text || "(no text)"}</span>
                  </button>

                  {record.imageRef && (
                    <figure className="mt-1">
                      {/* eslint-disable-next-line @next/next/no-img-element -- data URLs from a
                          client-side upload; next/image cannot optimise these and would only add
                          a round trip. */}
                      <img
                        src={record.imageRef}
                        alt={record.imageAlt ?? "Uploaded photo, no description available"}
                        className="max-h-20 rounded"
                        style={{ border: "1px solid var(--line)" }}
                      />
                      {record.imageAlt && (
                        <figcaption className="mt-0.5 text-sm" style={{ color: "var(--text-faint)" }}>
                          {record.imageAlt}
                        </figcaption>
                      )}
                    </figure>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <ClassifierTag classifier={record.classifier} />
                    {community && <CommunityTag name={community.name} />}
                    {record.duplicateCount && record.duplicateCount > 1 && (
                      <span
                        className="font-mono text-sm"
                        style={{ color: "var(--text-faint)" }}
                        title="Identical or retweeted copies collapsed into this row."
                      >
                        x{record.duplicateCount}
                      </span>
                    )}
                    {record.provenance?.sourceUrl && (
                      <a
                        href={record.provenance.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-sm underline"
                        style={{ color: "var(--accent)" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        source
                      </a>
                    )}
                  </div>
                </td>

                <td className="px-2 py-2">
                  <CategoryTag category={record.labels.category?.value} />
                  {record.labels.is_request?.value && (
                    <div className="mt-1 text-sm" style={{ color: "var(--urgent)" }}>
                      asking for help
                    </div>
                  )}
                </td>

                <td className="px-2 py-2">
                  <SeverityLadder score={record.labels.severity?.value} />
                </td>

                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <StaffGauge size="sm" gate={CONFIDENCE_GATE.relevant} view={relevantGauge} />
                    {relevantGauge.state === "below" && (
                      <span
                        className="text-sm font-semibold px-1 py-0.5 rounded"
                        style={{ background: "var(--review-weak)", color: "var(--text)" }}
                      >
                        Needs checking
                      </span>
                    )}
                  </div>
                  {record.labels.relevant?.via && (
                    <div
                      className="mt-0.5 text-sm"
                      style={{ color: "var(--text-faint)" }}
                      title="Which question carried the relevance decision."
                    >
                      {record.labels.relevant.via === "hazard"
                        ? "describes the event itself"
                        : "describes the response"}
                    </div>
                  )}
                </td>

                <td className="px-2 py-2">
                  {record.places.length ? (
                    <div className="flex flex-col gap-1">
                      {record.places.slice(0, 2).map((place, i) => (
                        <PlaceChip key={`${place.name}-${i}`} place={place} />
                      ))}
                    </div>
                  ) : (
                    <span className="text-sm" style={{ color: "var(--text-faint)" }}>
                      no place named
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {sorted.length > limit && (
        <div
          className="flex flex-wrap items-center gap-3 px-3 py-3 text-sm"
          style={{ borderTop: "1px solid var(--line)", color: "var(--text-muted)" }}
        >
          {/* aria-live so a screen reader hears the new count after pressing a button. */}
          <span aria-live="polite">
            Showing {count(Math.min(limit, sorted.length))} of {count(sorted.length)} reports, in the
            current sort order. The map shows all of them.
          </span>
          <button
            type="button"
            onClick={() => setLimit((n) => n + PAGE)}
            className="rounded px-2.5 py-1"
            style={{ border: "1px solid var(--line-strong)", color: "var(--text)", borderRadius: "var(--radius)" }}
          >
            Show {count(Math.min(PAGE, sorted.length - limit))} more
          </button>
          <button
            type="button"
            onClick={() => setLimit(sorted.length)}
            className="rounded px-2.5 py-1"
            style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            title="Rendering thousands of rows can be slow. Use Export for the full data."
          >
            Show all
          </button>
        </div>
      )}
    </div>
  );
}

/** Legend, so colour and icon are never the only carriers of meaning. */
export function CategoryLegend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-sm">
      {Object.entries(CATEGORY_META).map(([key, meta]) => (
        <li key={key} className="flex items-center gap-1">
          <CategoryTag category={key as keyof typeof CATEGORY_META} />
          <span className="sr-only">{meta.hint}</span>
        </li>
      ))}
    </ul>
  );
}
