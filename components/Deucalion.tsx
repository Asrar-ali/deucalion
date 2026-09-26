"use client";

/**
 * The application. Holds all state client-side on purpose: the server stores nothing, so a
 * recycled serverless instance cannot lose a judge's upload, and "your data never persists
 * on our side" is a fact about the architecture rather than a promise. See ARCHITECTURE 6.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  Eye,
  TextAa,
  WifiSlash,
  Warning,
  X,
} from "@phosphor-icons/react/dist/ssr";

import { CATEGORY_META, CATEGORY_ORDER, count, pct, usd } from "../lib/display";
import { runClassify } from "../lib/stream";
import type {
  Brief,
  Category,
  Cluster,
  EventProfile,
  FloodRecord,
  FunnelCounts,
  SpendState,
} from "../lib/types";
import { FunnelStrip } from "./FunnelStrip";
import { Intake, type IngestResult } from "./Intake";
import { CategoryLegend, RecordsTable, type SortKey } from "./RecordsTable";

// The map pulls in MapLibre and touches window on construction, so it must never render on
// the server. Loading it lazily also keeps it out of the initial bundle for low-bandwidth mode.
const FloodMap = dynamic(() => import("./FloodMap").then((m) => m.FloodMap), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-xs" style={{ color: "var(--text-faint)" }}>
      Loading map…
    </div>
  ),
});

interface Filters {
  categories: Set<Category>;
  minConfidence: number;
  query: string;
  onlyMapped: boolean;
  onlyRequests: boolean;
  community: string | null;
}

const DEFAULT_FILTERS: Filters = {
  categories: new Set(CATEGORY_ORDER),
  minConfidence: 0,
  query: "",
  onlyMapped: false,
  onlyRequests: false,
  community: null,
};

type Pref = "theme" | "font" | "touch" | "bandwidth";

export function Deucalion() {
  const [records, setRecords] = useState<FloodRecord[]>([]);
  const [profile, setProfile] = useState<EventProfile | null>(null);
  const [funnel, setFunnel] = useState<FunnelCounts | null>(null);
  const [spend, setSpend] = useState<SpendState | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [modelVersion, setModelVersion] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [ingestInfo, setIngestInfo] = useState<IngestResult | null>(null);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "severity", desc: true });

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);

  const [dark, setDark] = useState(false);
  const [legible, setLegible] = useState(false);
  const [largeTouch, setLargeTouch] = useState(false);
  const [lowBandwidth, setLowBandwidth] = useState(false);

  // Preferences live on <html> as data attributes so globals.css can act on them without any
  // JS in the render path. Reads are wrapped because storage throws in private windows.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("deucalion.prefs") ?? "{}") as Record<Pref, boolean>;
      if (saved.font) setLegible(true);
      if (saved.touch) setLargeTouch(true);
      if (saved.bandwidth) setLowBandwidth(true);
      setDark(saved.theme ?? window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {
      setDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = dark ? "dark" : "light";
    if (legible) root.dataset.font = "legible";
    else delete root.dataset.font;
    if (largeTouch) root.dataset.touch = "large";
    else delete root.dataset.touch;
    if (lowBandwidth) root.dataset.bandwidth = "low";
    else delete root.dataset.bandwidth;
    try {
      localStorage.setItem(
        "deucalion.prefs",
        JSON.stringify({ theme: dark, font: legible, touch: largeTouch, bandwidth: lowBandwidth }),
      );
    } catch {
      // A blocked storage API must not break the toggle itself.
    }
  }, [dark, legible, largeTouch, lowBandwidth]);

  const notify = useCallback((message: string) => {
    setNotices((prev) => (prev.includes(message) ? prev : [...prev, message]));
  }, []);

  /** Ingest replaces the working set. Classification then streams labels onto it. */
  const onIngest = useCallback(
    async (result: IngestResult) => {
      setIngestInfo(result);
      setRecords(result.records);
      setProfile(result.profile);
      setFunnel(result.funnel);
      setClusters([]);
      setBrief(null);
      setSelectedId(null);
      setBusy(true);
      setProgress({ done: 0, total: result.records.length, stage: "prefilter" });

      const byId = new Map(result.records.map((r) => [r.id, r]));

      await runClassify(
        { records: result.records, profile: result.profile },
        {
          onRecordBatch: (batch) => {
            for (const r of batch) byId.set(r.id, r);
            setRecords([...byId.values()]);
          },
          onProgress: (done, total, stage) => setProgress({ done, total, stage }),
          // Classify only ever sees the deduplicated set, so its `raw` is the post-dedupe
          // count and would quietly replace the real number of rows in the file. The client
          // is the only place that knows both, so it keeps ingest's figures for the first two
          // stages and takes the rest from the stream.
          onFunnel: (next) =>
            setFunnel((prev) =>
              prev
                ? {
                    ...next,
                    raw: prev.raw,
                    deduped: prev.deduped,
                    rejectedRows:
                      next.rejectedRows.length > prev.rejectedRows.length
                        ? next.rejectedRows
                        : prev.rejectedRows,
                  }
                : next,
            ),
          onSpend: setSpend,
          onDegraded: (_reason, message) => notify(message),
          onError: notify,
          onDone: (finalFunnel, finalSpend, version) => {
            setFunnel((prev) =>
              prev ? { ...finalFunnel, raw: prev.raw, deduped: prev.deduped } : finalFunnel,
            );
            setSpend(finalSpend);
            if (version) setModelVersion(version);
            setProgress(null);
            setBusy(false);
          },
        },
      );
      setBusy(false);
      setProgress(null);
    },
    [notify],
  );

  /** Summaries are requested explicitly. The narrative costs quota; the clusters do not. */
  const summarise = useCallback(
    async (withNarrative: boolean) => {
      if (!records.length) return;
      try {
        const res = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ records, scope: { kind: "all" }, narrative: withNarrative }),
        });
        const data = (await res.json()) as { clusters?: Cluster[]; brief?: Brief; error?: string };
        if (!res.ok) {
          notify(data.error ?? `Could not build a summary (${res.status}).`);
          return;
        }
        setClusters(data.clusters ?? []);
        setBrief(data.brief ?? null);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Could not build a summary.");
      }
    },
    [records, notify],
  );

  const download = useCallback(
    async (format: "geojson" | "csv" | "brief" | "sms") => {
      try {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ records, format, clusters, brief, profile, funnel }),
        });
        if (!res.ok) {
          notify(`Export failed (${res.status}).`);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download =
          res.headers.get("content-disposition")?.match(/filename="?([^"]+)"?/)?.[1] ??
          `deucalion.${format}`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Export failed.");
      }
    },
    [records, clusters, brief, profile, funnel, notify],
  );

  const communities = useMemo(() => {
    const names = new Map<string, number>();
    for (const r of records) {
      if (!r.labels.relevant?.value) continue;
      for (const name of new Set(r.places.map((p) => p.community?.name).filter(Boolean))) {
        names.set(name as string, (names.get(name as string) ?? 0) + 1);
      }
    }
    return [...names.entries()].sort((a, b) => b[1] - a[1]);
  }, [records]);

  const visible = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    return records.filter((r) => {
      if (!r.labels.relevant?.value) return false;
      const category = r.labels.category?.value;
      if (category && !filters.categories.has(category)) return false;
      if ((r.labels.relevant?.confidence ?? 0) < filters.minConfidence) return false;
      if (filters.onlyMapped && !r.places.length) return false;
      if (filters.onlyRequests && !r.labels.is_request?.value) return false;
      if (filters.community && !r.places.some((p) => p.community?.name === filters.community)) return false;
      if (q && !r.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, filters]);

  const relevantCount = records.filter((r) => r.labels.relevant?.value).length;

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--surface)" }}>
      <header
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold tracking-tight" style={{ color: "var(--text)" }}>
            Deucalion
          </h1>
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            the living flood map
          </span>
        </div>

        {profile && (
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Detected event:{" "}
            <strong style={{ color: "var(--text)" }}>{profile.hazard}</strong>
            {profile.places.length > 0 && <> near {profile.places.slice(0, 3).join(", ")}</>}
          </p>
        )}

        <div className="ml-auto flex items-center gap-1">
          {spend && !spend.unlimited && (
            <span
              className="font-mono text-[11px]"
              title={`Metered from the provider's own reported cost. Budget ${usd(spend.budget)} per session.`}
              style={{ color: "var(--text-muted)" }}
            >
              {usd(spend.used)}
            </span>
          )}
          <PrefToggle on={dark} onClick={() => setDark((v) => !v)} label="Dark theme" icon={<Eye size={14} />} />
          <PrefToggle
            on={legible}
            onClick={() => setLegible((v) => !v)}
            label="Atkinson Hyperlegible font, designed for low vision"
            icon={<TextAa size={14} />}
          />
          <PrefToggle
            on={lowBandwidth}
            onClick={() => setLowBandwidth((v) => !v)}
            label="Low bandwidth mode: drops map tiles and images, disables dictation"
            icon={<WifiSlash size={14} />}
          />
        </div>
      </header>

      {notices.length > 0 && (
        <div role="status" aria-live="polite" className="flex flex-col">
          {notices.map((notice) => (
            <div
              key={notice}
              className="flex items-start gap-2 px-3 py-1.5 text-[11px]"
              style={{ background: "var(--review-weak)", color: "var(--review)" }}
            >
              <Warning size={13} className="mt-0.5 shrink-0" aria-hidden />
              <span className="flex-1">{notice}</span>
              <button
                type="button"
                onClick={() => setNotices((prev) => prev.filter((n) => n !== notice))}
                aria-label="Dismiss"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <FunnelStrip funnel={funnel} progress={progress} />

      <main id="main" className="flex flex-1 flex-col lg:flex-row">
        <aside
          className="w-full shrink-0 border-b lg:w-72 lg:border-b-0 lg:border-r"
          style={{ borderColor: "var(--line)" }}
        >
          <Intake onIngest={onIngest} onError={notify} busy={busy} lowBandwidth={lowBandwidth} />

          {ingestInfo?.detectedColumns?.length ? (
            <div className="border-t px-3 py-2 text-[11px]" style={{ borderColor: "var(--line)", color: "var(--text-muted)" }}>
              Read column{" "}
              <code style={{ color: "var(--text)" }}>{ingestInfo.chosenColumn}</code> from{" "}
              {ingestInfo.detectedColumns.length} column
              {ingestInfo.detectedColumns.length === 1 ? "" : "s"}
              {ingestInfo.duplicatesRemoved ? <>, {count(ingestInfo.duplicatesRemoved)} duplicates collapsed</> : null}.
            </div>
          ) : null}

          {records.length > 0 && (
            <FilterPanel
              filters={filters}
              setFilters={setFilters}
              communities={communities}
              visibleCount={visible.length}
              relevantCount={relevantCount}
            />
          )}

          {records.length > 0 && (
            <BriefPanel
              clusters={clusters}
              brief={brief}
              onSummarise={summarise}
              onDownload={download}
              onPickCluster={(cluster) =>
                setFilters((f) => ({
                  ...f,
                  categories: new Set(
                    CATEGORY_ORDER.filter(
                      (c) => CATEGORY_META[c].label.toLowerCase() === cluster.label.toLowerCase() || true,
                    ),
                  ),
                  query: "",
                }))
              }
            />
          )}
        </aside>

        <div className="flex min-h-[60vh] flex-1 flex-col">
          <div className="h-[46vh] min-h-[280px] border-b lg:h-[52vh]" style={{ borderColor: "var(--line)" }}>
            {lowBandwidth && !records.length ? (
              <div className="grid h-full place-items-center px-6 text-center text-xs" style={{ color: "var(--text-faint)" }}>
                Low bandwidth mode is on. The map loads without tiles once reports are added.
              </div>
            ) : (
              <FloodMap
                records={visible}
                selectedId={selectedId}
                onSelect={setSelectedId}
                lowBandwidth={lowBandwidth}
                dark={dark}
              />
            )}
          </div>

          <div className="flex items-center justify-between border-b px-3 py-1" style={{ borderColor: "var(--line)" }}>
            <h2 className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              {count(visible.length)} report{visible.length === 1 ? "" : "s"}{" "}
              <span style={{ color: "var(--text-faint)" }}>
                (same data as the map, in text)
              </span>
            </h2>
            <CategoryLegend />
          </div>

          <RecordsTable
            records={visible}
            selectedId={selectedId}
            onSelect={setSelectedId}
            sort={sort}
            onSortChange={setSort}
            totalBeforeFilter={relevantCount}
          />
        </div>
      </main>

      <footer
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-2 text-[10px]"
        style={{ borderColor: "var(--line)", color: "var(--text-faint)" }}
      >
        <span>
          Every label is a proposal with a confidence, not a verified fact. Nothing is stored on
          the server.
        </span>
        {modelVersion && <span className="font-mono">{modelVersion}</span>}
        <a
          href="https://github.com/Asrar-ali/deucalion"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline"
          style={{ color: "var(--text-muted)" }}
        >
          Source <ArrowSquareOut size={10} aria-hidden />
        </a>
      </footer>
    </div>
  );
}

function PrefToggle({
  on,
  onClick,
  label,
  icon,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="rounded p-1.5"
      style={{
        background: on ? "var(--accent-weak)" : "transparent",
        color: on ? "var(--accent)" : "var(--text-faint)",
        borderRadius: "var(--radius)",
      }}
    >
      {icon}
    </button>
  );
}

function FilterPanel({
  filters,
  setFilters,
  communities,
  visibleCount,
  relevantCount,
}: {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  communities: Array<[string, number]>;
  visibleCount: number;
  relevantCount: number;
}) {
  const toggleCategory = (category: Category) =>
    setFilters((f) => {
      const next = new Set(f.categories);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return { ...f, categories: next };
    });

  return (
    <section aria-labelledby="filters-heading" className="flex flex-col gap-3 border-t p-3" style={{ borderColor: "var(--line)" }}>
      <div className="flex items-baseline justify-between">
        <h2 id="filters-heading" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
          Filter
        </h2>
        <span className="font-mono text-[10px]" style={{ color: "var(--text-faint)" }} aria-live="polite">
          {count(visibleCount)} of {count(relevantCount)}
        </span>
      </div>

      <div>
        <label htmlFor="q" className="sr-only">
          Search report text
        </label>
        <input
          id="q"
          type="search"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          placeholder="Search text"
          className="w-full rounded px-2 py-1 text-xs"
          style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--line-strong)",
            color: "var(--text)",
            borderRadius: "var(--radius)",
          }}
        />
      </div>

      <fieldset>
        <legend className="mb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Categories
        </legend>
        <div className="flex flex-col gap-1">
          {CATEGORY_ORDER.map((category) => (
            <label key={category} className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={filters.categories.has(category)}
                onChange={() => toggleCategory(category)}
              />
              <span style={{ color: "var(--text)" }}>{CATEGORY_META[category].label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="conf" className="mb-1 block text-[11px]" style={{ color: "var(--text-muted)" }}>
          Minimum relevance confidence:{" "}
          <span className="font-mono" style={{ color: "var(--text)" }}>
            {pct(filters.minConfidence)}
          </span>
        </label>
        {/* The governance control, made touchable. Dragging it reclassifies what the map shows,
            which turns a policy claim into something a judge can feel. */}
        <input
          id="conf"
          type="range"
          min={0}
          max={0.95}
          step={0.05}
          value={filters.minConfidence}
          onChange={(e) => setFilters((f) => ({ ...f, minConfidence: Number(e.target.value) }))}
          className="w-full"
        />
      </div>

      <div className="flex flex-col gap-1 text-[11px]">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.onlyMapped}
            onChange={(e) => setFilters((f) => ({ ...f, onlyMapped: e.target.checked }))}
          />
          <span style={{ color: "var(--text)" }}>Only reports with a place</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.onlyRequests}
            onChange={(e) => setFilters((f) => ({ ...f, onlyRequests: e.target.checked }))}
          />
          <span style={{ color: "var(--text)" }}>Only requests for help</span>
        </label>
      </div>

      {communities.length > 0 && (
        <div>
          <label htmlFor="community" className="mb-1 block text-[11px]" style={{ color: "var(--text-muted)" }}>
            First Nations community
          </label>
          <select
            id="community"
            value={filters.community ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, community: e.target.value || null }))}
            className="w-full rounded px-2 py-1 text-xs"
            style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--line-strong)",
              color: "var(--text)",
              borderRadius: "var(--radius)",
            }}
          >
            <option value="">All areas</option>
            {communities.map(([name, n]) => (
              <option key={name} value={name}>
                {name} ({n})
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}

function BriefPanel({
  clusters,
  brief,
  onSummarise,
  onDownload,
}: {
  clusters: Cluster[];
  brief: Brief | null;
  onSummarise: (withNarrative: boolean) => void;
  onDownload: (format: "geojson" | "csv" | "brief" | "sms") => void;
  onPickCluster: (cluster: Cluster) => void;
}) {
  const [plain, setPlain] = useState(false);

  const speak = () => {
    const text = plain && brief?.plainLanguage ? brief.plainLanguage : brief?.extractive;
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  return (
    <section aria-labelledby="brief-heading" className="flex flex-col gap-2 border-t p-3" style={{ borderColor: "var(--line)" }}>
      <h2 id="brief-heading" className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
        Situation
      </h2>

      {!brief ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onSummarise(false)}
            className="rounded px-2 py-1.5 text-xs"
            style={{ border: "1px solid var(--line-strong)", color: "var(--text)", borderRadius: "var(--radius)" }}
          >
            Summarise (local, instant)
          </button>
          <button
            type="button"
            onClick={() => onSummarise(true)}
            className="rounded px-2 py-1.5 text-xs"
            style={{ border: "1px solid var(--line-strong)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            title="Also asks a language model to write a narrative. Every sentence must cite the records it came from, or it is dropped."
          >
            Summarise with narrative
          </button>
        </div>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--text)" }}>
            {plain && brief.plainLanguage ? brief.plainLanguage : brief.extractive}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {brief.plainLanguage && (
              <button
                type="button"
                onClick={() => setPlain((v) => !v)}
                aria-pressed={plain}
                className="rounded px-2 py-1 text-[10px]"
                style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
              >
                {plain ? "Full wording" : "Plain language"}
              </button>
            )}
            <button
              type="button"
              onClick={speak}
              className="rounded px-2 py-1 text-[10px]"
              style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            >
              Read aloud
            </button>
          </div>

          {brief.narrative?.length ? (
            <ul className="flex flex-col gap-1.5">
              {brief.narrative.map((sentence, i) => (
                <li key={i} className="text-[11px] leading-relaxed" style={{ color: "var(--text)" }}>
                  {sentence.sentence}{" "}
                  <span
                    className="font-mono text-[9px]"
                    style={{ color: "var(--accent)" }}
                    title={`Cites records: ${sentence.citedRecordIds.join(", ")}`}
                  >
                    [{sentence.citedRecordIds.length} cited]
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {clusters.length > 0 && (
            <ul className="flex flex-col gap-1">
              {clusters.map((cluster) => (
                <li key={cluster.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span style={{ color: "var(--text)" }}>
                    {cluster.label}
                    {cluster.terms?.length ? (
                      <span style={{ color: "var(--text-faint)" }}> · {cluster.terms.join(", ")}</span>
                    ) : null}
                  </span>
                  <span className="font-mono" style={{ color: "var(--text-muted)" }}>
                    {count(cluster.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-1 flex flex-wrap gap-1.5">
        {(["geojson", "csv", "brief", "sms"] as const).map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => onDownload(format)}
            className="rounded px-2 py-1 text-[10px] uppercase"
            style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            title={
              format === "geojson"
                ? "A GeoJSON layer, ready to open in MapAki or any GIS."
                : format === "csv"
                  ? "Flat table with labels and confidences. Safe to open in Excel."
                  : format === "brief"
                    ? "Printable situation brief."
                    : "Short digest sized for a text message."
            }
          >
            {format}
          </button>
        ))}
      </div>
    </section>
  );
}
