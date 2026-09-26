"use client";

/**
 * The application. Holds all state client-side on purpose: the server stores nothing, so a
 * recycled serverless instance cannot lose a judge's upload, and "your data never persists
 * on our side" is a fact about the architecture rather than a promise. See ARCHITECTURE 6.
 *
 * The UI is split into page-like views (data / map / reports / summary / ask) that all share
 * this one component's state. Nothing is stored server-side, so switching "pages" cannot be a
 * real Next.js route change without losing everything on navigation; instead a `view` state
 * variable picks which section renders, synced to the URL hash purely for shareable links and
 * the back button.
 */

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  Eye,
  TextAa,
  Trash,
  WifiSlash,
  Warning,
  X,
} from "@phosphor-icons/react/dist/ssr";

import gazetteer from "../data/gazetteer.json";
import { CATEGORY_META, CATEGORY_ORDER, count, pct, usd } from "../lib/display";
import { demoEventProfile, isDemoMode, replayDemo } from "../lib/demo";
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
import { RecordDetail, type ReviewAction } from "./RecordDetail";
import { AskPanel } from "./AskPanel";

const HAZARD_NOUN: Record<string, string> = {
  flood: "the flood",
  fire: "the wildfire",
  quake: "the earthquake",
  storm: "the storm",
  other: "the event",
};

/** The one key this app has ever written to localStorage. Kept in one place so the wipe
 * control and the preference loader cannot drift apart. */
const PREFS_KEY = "deucalion.prefs";

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
  /** Hide posts the classifier says are about another hazard (bonus: multi-disaster files). */
  floodOnly: boolean;
  /** Set when a summary theme is picked: show exactly that cluster's posts. */
  cluster: { label: string; ids: Set<string> } | null;
}

const DEFAULT_FILTERS: Filters = {
  categories: new Set(CATEGORY_ORDER),
  minConfidence: 0,
  query: "",
  onlyMapped: false,
  onlyRequests: false,
  community: null,
  floodOnly: false,
  cluster: null,
};

/** "What to map": infer the hazard from the corpus, or pin it to flooding before classifying. */
type Focus = "auto" | "flood";

// profile.places holds matched aliases ("yyc", "calgary"); show each place's real name once.
const ALIAS_TO_NAME = new Map<string, string>(
  (gazetteer as { places: Array<{ name: string; aliases?: string[] }> }).places.flatMap((p) =>
    [p.name.toLowerCase(), ...(p.aliases ?? [])].map((a) => [a.toLowerCase(), p.name] as [string, string]),
  ),
);
function placeNames(aliases: string[]): string[] {
  return [...new Set(aliases.map((a) => ALIAS_TO_NAME.get(a.toLowerCase())).filter((n): n is string => !!n))];
}

type Pref = "theme" | "font" | "touch" | "bandwidth";

/** The five page-like views. Order here is the order they appear in the nav bar. */
const VIEW_META = [
  { key: "data", label: "Load data" },
  { key: "map", label: "Map" },
  { key: "reports", label: "Reports" },
  { key: "summary", label: "Summary" },
  { key: "ask", label: "Ask" },
] as const;
type View = (typeof VIEW_META)[number]["key"];
const VIEW_KEYS: readonly string[] = VIEW_META.map((v) => v.key);
function isView(x: string): x is View {
  return VIEW_KEYS.includes(x);
}

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
  const [focus, setFocus] = useState<Focus>("auto");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Append-only record of human review decisions: the audit artifact. Never sent anywhere. */
  const [reviewLog, setReviewLog] = useState<Array<{ id: string; action: ReviewAction; at: string }>>([]);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "severity", desc: true });

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);

  const [dark, setDark] = useState(false);
  const [legible, setLegible] = useState(false);
  const [largeTouch, setLargeTouch] = useState(false);
  const [lowBandwidth, setLowBandwidth] = useState(false);

  const [demoMode, setDemoMode] = useState(false);
  const demoStarted = useRef(false);

  const [wipeConfirming, setWipeConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const wipeButtonRef = useRef<HTMLButtonElement>(null);
  // The in-flight classification, so wipe and unmount can stop it from writing data back.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Which page-like view is showing. Default is "data": nothing to map, filter or summarise
  // yet. Kept in sync with the URL hash below, purely so the current view survives a reload or
  // can be shared, since nothing else here is server-side.
  const [view, setView] = useState<View>("data");

  // Read the hash once on mount, in case the page was opened on a link to a specific view.
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (isView(h)) setView(h);
  }, []);

  // Keep the hash in sync with the current view. replaceState (not push) so switching views
  // does not spam the browser history stack.
  useEffect(() => {
    const target = `#${view}`;
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [view]);

  // A hash edited by hand, or changed by the back/forward buttons, should still move the app
  // to the matching view.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash.replace("#", "");
      if (isView(h)) setView(h);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Preferences live on <html> as data attributes so globals.css can act on them without any
  // JS in the render path. Reads are wrapped because storage throws in private windows.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<Pref, boolean>;
      if (saved.font) setLegible(true);
      if (saved.touch) setLargeTouch(true);
      if (saved.bandwidth) setLowBandwidth(true);
      setDark(saved.theme ?? window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch {
      setDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    // Read once on mount, same as every other preference above: the query string is only
    // known client-side, so reading it during render would desync server and client HTML.
    setDemoMode(isDemoMode(window.location.search));
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
        PREFS_KEY,
        JSON.stringify({ theme: dark, font: legible, touch: largeTouch, bandwidth: lowBandwidth }),
      );
    } catch {
      // A blocked storage API must not break the toggle itself.
    }
  }, [dark, legible, largeTouch, lowBandwidth]);

  const notify = useCallback((message: string) => {
    setNotices((prev) => (prev.includes(message) ? prev : [...prev, message]));
  }, []);

  // Demo mode replaces the network round trip with the bundled fixtures, replayed on a timer.
  // Guarded by a ref rather than just the effect dependency array, because React can invoke
  // effects twice in development and a paid classification run should never double, so the
  // same discipline is kept here even though this path is free.
  const startDemoReplay = useCallback(() => {
    setRecords([]);
    setProfile(demoEventProfile());
    setFunnel(null);
    setClusters([]);
    setBrief(null);
    setSelectedId(null);
    setIngestInfo(null);
    setBusy(true);
    setView("map");
    void replayDemo({
      onRecordBatch: (batch) => setRecords((prev) => [...prev, ...batch]),
      onProgress: (done, total, stage) => setProgress({ done, total, stage }),
      onFunnel: setFunnel,
      onDone: (finalFunnel, finalClusters, finalBrief) => {
        setFunnel(finalFunnel);
        setClusters(finalClusters);
        setBrief(finalBrief);
        setProgress(null);
        setBusy(false);
        notify("Demo data loaded and replayed. Nothing here was classified live.");
      },
    });
  }, [notify]);

  useEffect(() => {
    if (!demoMode || demoStarted.current) return;
    demoStarted.current = true;
    startDemoReplay();
  }, [demoMode, startDemoReplay]);

  /**
   * The destructive control the privacy claim demands: "nothing persists server-side and you
   * stay in control" is only true in practice if a person can act on it. Clears every piece of
   * working state plus the one key this app has ever written to localStorage.
   */
  const wipeEverything = useCallback(() => {
    // Abort first: a streaming run would otherwise repopulate what is cleared below.
    abortRef.current?.abort();
    abortRef.current = null;
    setRecords([]);
    setProfile(null);
    setFunnel(null);
    setClusters([]);
    setBrief(null);
    setSelectedId(null);
    setIngestInfo(null);
    setSpend(null);
    setModelVersion(null);
    setProgress(null);
    setBusy(false);
    setFilters(DEFAULT_FILTERS);
    setView("data");
    try {
      localStorage.removeItem(PREFS_KEY);
    } catch {
      // A blocked storage API leaves nothing behind to remove; either way there is nothing left.
    }
    setWipeConfirming(false);
    setNotices([]);
    notify("Everything has been wiped. No reports, summaries or saved preferences remain on this device.");
    // Focus goes to the page heading, the one element guaranteed to still be there once the
    // records, filters and brief panels have all disappeared from under the cursor.
    headingRef.current?.focus();
  }, [notify]);

  /** Ingest replaces the working set. Classification then streams labels onto it. */
  const onIngest = useCallback(
    async (result: IngestResult) => {
      // "Flooding only" pins the hazard before classification, so the relevance question asks
      // about floods. On a mixed-disaster file the corpus detector picks storm or "other",
      // and every disaster would then count as relevant.
      //
      // Two ways to end up focused, and they compose. The explicit choice above always wins. If
      // nobody chose, a file that detection flags as mixed has ALREADY been focused on flooding
      // by focusProfile (server side for one request, in chunkedIngest for a large upload), so
      // result.profile arrives with hazard "flood" and focused true. `focused` tells the prefilter
      // to stop paying for other hazards' vocabulary, so the explicit choice sets it too.
      // A new load supersedes any run still streaming.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      const eventProfile =
        focus === "flood"
          ? { ...result.profile, hazard: "flood" as const, userEdited: true, focused: true }
          : result.profile;
      // Mixed files default to the flood view, matching what the choice would have done.
      if (focus === "flood" || result.profile.mixed) setFilters((f) => ({ ...f, floodOnly: true }));
      setIngestInfo(result);
      setRecords(result.records);
      setProfile(eventProfile);
      setFunnel(result.funnel);
      setClusters([]);
      setBrief(null);
      setSelectedId(null);
      setBusy(true);
      setProgress({ done: 0, total: result.records.length, stage: "prefilter" });
      setView("map");

      const byId = new Map(result.records.map((r) => [r.id, r]));

      // Records accumulate in the Map immediately, but React state is refreshed on a timer.
      // Refreshing on every streamed batch is quadratic in the record count: on the 53,000-row
      // world feed each of ~1,300 batches would copy all the records and re-run the filter, the
      // community rollup, the map point rebuild and the table sort. That is an inference from the
      // code, not a measured freeze: it was never timed in a visible tab (see the note in
      // docs/SUBMISSION.md), but it is plainly wasted work either way. A few refreshes a second
      // still looks live, and the flush in `finally` guarantees the final state is complete even
      // if the run errors.
      let dirty = false;
      const flushRecords = () => {
        if (!dirty || signal.aborted) return;
        dirty = false;
        setRecords([...byId.values()]);
      };
      const timer = setInterval(flushRecords, 500);

      try {
      await runClassify(
        { records: result.records, profile: eventProfile },
        {
          onRecordBatch: (batch) => {
            for (const r of batch) byId.set(r.id, r);
            dirty = true;
          },
          // Each state-setting callback checks the signal: after a wipe the stream can still
          // deliver an event or two before the abort lands, and none may resurrect state.
          onProgress: (done, total, stage) => {
            if (!signal.aborted) setProgress({ done, total, stage });
          },
          // Classify only ever sees the deduplicated set, so its `raw` is the post-dedupe
          // count and would quietly replace the real number of rows in the file. The client
          // is the only place that knows both, so it keeps ingest's figures for the first two
          // stages and takes the rest from the stream.
          onFunnel: (next) =>
            !signal.aborted &&
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
          onSpend: (next) => {
            if (!signal.aborted) setSpend(next);
          },
          onDegraded: (_reason, message) => {
            if (!signal.aborted) notify(message);
          },
          onError: (message) => {
            if (!signal.aborted) notify(message);
          },
          onDone: (finalFunnel, finalSpend, version) => {
            if (signal.aborted) return;
            flushRecords();
            setFunnel((prev) =>
              prev ? { ...finalFunnel, raw: prev.raw, deduped: prev.deduped } : finalFunnel,
            );
            setSpend(finalSpend);
            if (version) setModelVersion(version);
            setProgress(null);
            setBusy(false);
          },
        },
        signal,
      );
      } finally {
        // Success, error and abort all land here. Stopping the timer without one last flush would
        // drop the final records of an interrupted run, so partial results stay visible.
        clearInterval(timer);
        flushRecords();
      }
      // A newer load owns the busy state now; only clear it if this run is still the current one
      // (or was wiped, which nulls the ref).
      if (abortRef.current === null || abortRef.current === controller) {
        setBusy(false);
        setProgress(null);
      }
    },
    [notify, focus],
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
      if (filters.floodOnly && r.labels.hazard && r.labels.hazard.value !== "flood") return false;
      if (filters.cluster && !filters.cluster.ids.has(r.id)) return false;
      if (filters.community && !r.places.some((p) => p.community?.name === filters.community)) return false;
      if (q && !r.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, filters]);

  const relevantCount = records.filter((r) => r.labels.relevant?.value).length;
  const selected = useMemo(
    () => (selectedId ? records.find((r) => r.id === selectedId) ?? null : null),
    [records, selectedId],
  );
  const hazardNoun = HAZARD_NOUN[profile?.hazard ?? "other"] ?? "the event";

  // "N reports on the map, M name no place": the map only plots records with at least one
  // resolved place, so the caption under it accounts for the rest of what "reports" reported.
  const mappedVisibleCount = useMemo(() => visible.filter((r) => r.places.length > 0).length, [visible]);
  const unmappedVisibleCount = visible.length - mappedVisibleCount;

  const onReview = (id: string, action: ReviewAction) => {
    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, review: action } : r)));
    setReviewLog((prev) => [...prev, { id, action, at: new Date().toISOString() }]);
  };

  const downloadReviewLog = () => {
    const blob = new Blob([JSON.stringify(reviewLog, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "deucalion-review-log.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--surface)" }}>
      <header
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="flex items-baseline gap-2">
          {/* tabIndex -1 makes this a legitimate focus target for the wipe control below,
              without adding it to the normal tab order. */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold tracking-tight"
            style={{ color: "var(--text)" }}
          >
            Deucalion
          </h1>
          <span className="text-sm" style={{ color: "var(--text-faint)" }}>
            the living flood map
          </span>
          {demoMode && (
            <span
              className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-sm font-medium"
              style={{ color: "var(--review)", background: "var(--review-weak)", borderRadius: "var(--radius)" }}
            >
              <Warning size={12} weight="bold" aria-hidden />
              Demo data, no live classification
            </span>
          )}
        </div>

        {profile && (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            {profile.userEdited ? "Mapping:" : "Detected event:"}{" "}
            <strong style={{ color: "var(--text)" }}>{profile.hazard}</strong>
            {placeNames(profile.places).length > 0 && <> near {placeNames(profile.places).slice(0, 3).join(", ")}</>}
          </p>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView("data")}
            className="rounded px-2 py-1 text-sm font-medium"
            style={{ color: "var(--text-muted)", borderRadius: "var(--radius)" }}
          >
            Load data
          </button>
          {spend && !spend.unlimited && (
            <span
              className="font-mono text-sm"
              title={`Metered from the provider's own reported cost. Budget ${usd(spend.budget)} per session.`}
              style={{ color: "var(--text-muted)" }}
            >
              {usd(spend.used)}
            </span>
          )}
          <PrefToggle on={dark} onClick={() => setDark((v) => !v)} label="Dark theme" short="Dark" icon={<Eye size={14} />} />
          <PrefToggle
            on={legible}
            onClick={() => setLegible((v) => !v)}
            label="Atkinson Hyperlegible font, designed for low vision"
            short="Legible font"
            icon={<TextAa size={14} />}
          />
          <PrefToggle
            on={lowBandwidth}
            onClick={() => setLowBandwidth((v) => !v)}
            label="Low bandwidth mode: drops map tiles and images, disables dictation"
            short="Low data"
            icon={<WifiSlash size={14} />}
          />
        </div>
      </header>

      {notices.length > 0 && (
        <div role="status" aria-live="polite" className="flex flex-col">
          {notices.map((notice) => (
            <div
              key={notice}
              className="flex items-start gap-2 px-4 py-1.5 text-sm"
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

      <nav aria-label="Views" className="flex items-center gap-4 overflow-x-auto border-b px-4" style={{ borderColor: "var(--line)" }}>
        {VIEW_META.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            aria-current={view === v.key ? "page" : undefined}
            className="shrink-0 py-2 text-sm font-medium"
            style={{
              color: view === v.key ? "var(--text)" : "var(--text-muted)",
              borderBottom: view === v.key ? "1.5px solid var(--text)" : "1.5px solid transparent",
            }}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <main id="main" className="flex min-w-0 flex-1 flex-col">
        {view === "data" && (
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
            <p className="text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
              Load the provided sample or your own CSV of posts. Deucalion classifies each post,
              maps the ones that name a place, and summarises them. Nothing is stored on the
              server.
            </p>

            <div>
              <label htmlFor="focus" className="block text-sm font-medium" style={{ color: "var(--text-muted)" }}>
                What to map
              </label>
              <select
                id="focus"
                value={focus}
                onChange={(e) => setFocus(e.target.value as Focus)}
                disabled={busy}
                className="mt-1 w-full rounded px-2 py-1.5 text-sm"
                style={{ border: "1px solid var(--line-strong)", background: "var(--surface-raised)", color: "var(--text)" }}
              >
                <option value="auto">Detect the disaster from the posts</option>
                <option value="flood">Flooding only (for files with many disaster types)</option>
              </select>
              <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
                Choose before loading. Flooding only asks the classifier about floods and hides
                posts about other hazards.
              </p>
            </div>

            <Intake
              onIngest={onIngest}
              onError={notify}
              busy={busy}
              lowBandwidth={lowBandwidth}
              // In demo mode nothing may touch the network: on stage the fallback exists because it
              // might be down. Load replays the fixtures; uploads explain why they are not classified.
              onDemoLoad={demoMode ? startDemoReplay : undefined}
            />

            {ingestInfo?.detectedColumns?.length ? (
              <div className="text-sm" style={{ color: "var(--text-muted)" }}>
                Read column{" "}
                <code style={{ color: "var(--text)" }}>{ingestInfo.chosenColumn}</code> from{" "}
                {ingestInfo.detectedColumns.length} column
                {ingestInfo.detectedColumns.length === 1 ? "" : "s"}
                {ingestInfo.duplicatesRemoved ? <>, {count(ingestInfo.duplicatesRemoved)} duplicates collapsed</> : null}.
              </div>
            ) : null}

            {/* A mixed file is focused on flooding automatically. Say so, with the numbers behind it,
                or the view silently hides the other disasters, which is the kind of unexplained
                omission this tool exists to avoid. */}
            {ingestInfo?.profile.mixed && ingestInfo.profile.hazardShares ? (
              <div
                className="rounded px-3 py-2 text-sm"
                style={{ color: "var(--text-muted)", background: "var(--accent-weak)", borderRadius: "var(--radius)" }}
              >
                <strong style={{ color: "var(--text)" }}>This file mixes several disasters.</strong> Share of hazard
                keywords:{" "}
                {(Object.entries(ingestInfo.profile.hazardShares) as Array<[string, number]>)
                  .filter(([, share]) => share >= 0.01)
                  .sort((a, b) => b[1] - a[1])
                  .map(([hazard, share]) => `${hazard} ${Math.round(share * 100)}%`)
                  .join(", ")}
                . Showing flood posts only. Untick &quot;Only posts about flooding&quot; in the filters to see the rest.
              </div>
            ) : null}
          </div>
        )}

        {view === "map" && (
          <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
            {records.length > 0 && (
              <FiltersSidebar
                filters={filters}
                setFilters={setFilters}
                communities={communities}
                visibleCount={visible.length}
                relevantCount={relevantCount}
              />
            )}

            <div className="relative flex min-w-0 flex-1 flex-col">
              {records.length === 0 ? (
                <EmptyState
                  message={
                    lowBandwidth
                      ? "Low bandwidth mode is on. The map loads without tiles once reports are added."
                      : "No reports loaded yet."
                  }
                  ctaLabel="Load data"
                  onCta={() => setView("data")}
                />
              ) : (
                <>
                  {/* One post and how it got here: demo beat "every point tells you how it got here".
                      Overlays the right of the map on desktop, sits under the map on a phone. */}
                  {selected && (
                    <div
                      className="z-10 border-b lg:absolute lg:right-0 lg:top-0 lg:h-[52vh] lg:w-[400px] lg:overflow-y-auto lg:border-b-0 lg:border-l"
                      style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
                    >
                      <RecordDetail record={selected} hazardNoun={hazardNoun} onClose={() => setSelectedId(null)} onReview={onReview} />
                    </div>
                  )}
                  <div
                    className="min-h-[420px] border-b"
                    style={{ borderColor: "var(--line)", height: "max(420px, calc(100dvh - 260px))" }}
                  >
                    <FloodMap records={visible} selectedId={selectedId} onSelect={setSelectedId} lowBandwidth={lowBandwidth} dark={dark} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm" style={{ color: "var(--text-muted)" }}>
                    <span>
                      {count(mappedVisibleCount)} report{mappedVisibleCount === 1 ? "" : "s"} on the map,{" "}
                      {count(unmappedVisibleCount)} name no place
                    </span>
                    <button
                      type="button"
                      onClick={() => setView("reports")}
                      className="underline"
                      style={{ color: "var(--text)" }}
                    >
                      See them as a list
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {view === "reports" && (
          <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
            {records.length > 0 && (
              <FiltersSidebar
                filters={filters}
                setFilters={setFilters}
                communities={communities}
                visibleCount={visible.length}
                relevantCount={relevantCount}
              />
            )}

            <div className="flex min-w-0 flex-1 flex-col">
              {selected && (
                <div className="border-b lg:hidden" style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}>
                  <RecordDetail record={selected} hazardNoun={hazardNoun} onClose={() => setSelectedId(null)} onReview={onReview} />
                </div>
              )}

              <div className="flex items-center justify-between border-b px-4 py-1" style={{ borderColor: "var(--line)" }}>
                <h2 className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
                  {count(visible.length)} report{visible.length === 1 ? "" : "s"}{" "}
                  <span style={{ color: "var(--text-faint)" }}>(same data as the map, in text)</span>
                </h2>
                {filters.cluster && (
                  <p className="flex items-center gap-2 text-sm" style={{ color: "var(--text)" }}>
                    Theme: {filters.cluster.label}
                    <button type="button" className="underline" onClick={() => setFilters((f) => ({ ...f, cluster: null }))}>
                      Clear
                    </button>
                  </p>
                )}
                <CategoryLegend />
              </div>

              <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
                <div className="min-w-0 flex-1">
                  <RecordsTable
                    records={visible}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    sort={sort}
                    onSortChange={setSort}
                    totalBeforeFilter={relevantCount}
                  />
                </div>
                {selected && (
                  <div
                    className="hidden shrink-0 lg:block lg:w-[400px] lg:overflow-y-auto lg:border-l"
                    style={{ borderColor: "var(--line)", background: "var(--surface-raised)" }}
                  >
                    <RecordDetail record={selected} hazardNoun={hazardNoun} onClose={() => setSelectedId(null)} onReview={onReview} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {view === "summary" && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
            {records.length === 0 ? (
              <EmptyState message="Load data first to build a summary." ctaLabel="Load data" onCta={() => setView("data")} />
            ) : (
              <BriefPanel
                clusters={clusters}
                brief={brief}
                onSummarise={summarise}
                onDownload={download}
                onSelectRecord={(id) => {
                  setSelectedId(id);
                  setView("reports");
                }}
                onPickCluster={(cluster) => {
                  // Was a no-op (`|| true` kept every category). Show exactly the theme's posts.
                  setFilters((f) => ({ ...f, cluster: { label: cluster.label, ids: new Set(cluster.recordIds) } }));
                  setView("reports");
                }}
              />
            )}
          </div>
        )}

        {view === "ask" && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
            {/* ASK_PANEL_SLOT */}
            <AskPanel
              records={visible}
              onSelectRecord={(id) => {
                setSelectedId(id);
                setView("reports");
              }}
              demo={demoMode}
            />
          </div>
        )}
      </main>

      <footer
        className="flex flex-col gap-2 border-t px-4 py-2 text-sm"
        style={{ borderColor: "var(--line)", color: "var(--text-faint)" }}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Every label is a proposal with a confidence, not a verified fact. Nothing is stored on
            the server.
          </span>
          {modelVersion && <span className="font-mono">{modelVersion}</span>}
          {reviewLog.length > 0 && (
            <button type="button" onClick={downloadReviewLog} className="underline" style={{ color: "var(--text-muted)" }}>
              Download review log ({reviewLog.length})
            </button>
          )}
          <Link href="/accessibility" className="underline" style={{ color: "var(--text-muted)" }}>
            Accessibility statement
          </Link>
          <a
            href="https://github.com/Asrar-ali/deucalion"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
            style={{ color: "var(--text-muted)" }}
          >
            Source <ArrowSquareOut size={10} aria-hidden />
          </a>
        </div>

        {/* Its own row, separated by a rule, so this destructive control is never one
            accidental tab-and-enter away from Source or the theme toggles above. */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-2" style={{ borderColor: "var(--line)" }}>
          {!wipeConfirming ? (
            <button
              ref={wipeButtonRef}
              type="button"
              onClick={() => setWipeConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium"
              style={{ color: "var(--urgent)", background: "var(--urgent-weak)", borderRadius: "var(--radius)" }}
            >
              <Trash size={12} weight="bold" aria-hidden />
              Wipe everything
            </button>
          ) : (
            <WipeConfirmPanel
              onConfirm={wipeEverything}
              onCancel={() => {
                setWipeConfirming(false);
                wipeButtonRef.current?.focus();
              }}
            />
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * An inline panel, not window.confirm: a native modal blocks the rest of the page and is
 * poorly supported by assistive tech. Cancel takes focus on open, so a keyboard user who
 * reaches this by accident lands on the safe choice rather than the destructive one.
 */
function WipeConfirmPanel({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-labelledby="wipe-confirm-text"
      className="flex flex-wrap items-center gap-2 rounded px-2 py-1.5"
      style={{ background: "var(--urgent-weak)", borderRadius: "var(--radius)" }}
    >
      <Warning size={13} weight="bold" aria-hidden style={{ color: "var(--urgent)" }} />
      <span id="wipe-confirm-text" style={{ color: "var(--urgent)" }}>
        Clear every loaded report, summary and saved preference on this device. This cannot be
        undone.
      </span>
      <button
        type="button"
        onClick={onConfirm}
        className="rounded px-2 py-1 text-sm font-semibold"
        style={{
          color: "var(--urgent)",
          background: "var(--surface-raised)",
          border: "1px solid var(--urgent)",
          borderRadius: "var(--radius)",
        }}
      >
        Yes, wipe everything
      </button>
      <button
        ref={cancelRef}
        type="button"
        onClick={onCancel}
        className="rounded px-2 py-1 text-sm"
        style={{ border: "1px solid var(--line-strong)", color: "var(--text)", borderRadius: "var(--radius)" }}
      >
        Cancel
      </button>
    </div>
  );
}

function PrefToggle({
  on,
  onClick,
  label,
  icon,
  short,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  /** Visible text: an icon plus a title is invisible to a sighted keyboard user. */
  short?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1 rounded p-1.5"
      style={{
        background: on ? "var(--accent-weak)" : "transparent",
        color: on ? "var(--accent)" : "var(--text-faint)",
        borderRadius: "var(--radius)",
      }}
    >
      {icon}
      {short && <span className="hidden text-sm sm:inline">{short}</span>}
    </button>
  );
}

/** A helpful stand-in for a view that has nothing to show yet, so nav items never need to be
 * disabled or greyed out: clicking "Map" or "Summary" before data is loaded still lands
 * somewhere useful. */
function EmptyState({
  message,
  ctaLabel,
  onCta,
}: {
  message: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {message}
      </p>
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="rounded px-3 py-1.5 text-sm"
          style={{ border: "1px solid var(--line-strong)", color: "var(--text)", borderRadius: "var(--radius)" }}
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

/** The filters, shared by the map and reports views: a fixed ~280px sidebar on desktop, and a
 * collapsed <details> above the content on a phone so a long filter list never pushes the map
 * or table off screen. */
function FiltersSidebar(props: {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  communities: Array<[string, number]>;
  visibleCount: number;
  relevantCount: number;
}) {
  return (
    <>
      <details className="border-b lg:hidden" style={{ borderColor: "var(--line)" }}>
        <summary className="cursor-pointer px-4 py-2 text-sm font-medium" style={{ color: "var(--text)" }}>
          Filters
        </summary>
        <FilterPanel {...props} />
      </details>
      <div
        className="hidden shrink-0 lg:block lg:w-[280px] lg:overflow-y-auto lg:border-r"
        style={{ borderColor: "var(--line)" }}
      >
        <FilterPanel {...props} />
      </div>
    </>
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
    <section aria-labelledby="filters-heading" className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between">
        <h2 id="filters-heading" className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
          Filter
        </h2>
        <span className="font-mono text-sm" style={{ color: "var(--text-faint)" }} aria-live="polite">
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
          className="w-full rounded px-2 py-1 text-sm"
          style={{
            background: "var(--surface-raised)",
            border: "1px solid var(--line-strong)",
            color: "var(--text)",
            borderRadius: "var(--radius)",
          }}
        />
      </div>

      <fieldset>
        <legend className="mb-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Categories
        </legend>
        <div className="flex flex-col gap-1">
          {CATEGORY_ORDER.map((category) => (
            <label key={category} className="flex items-center gap-2 text-sm">
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
        <label htmlFor="conf" className="mb-1 block text-sm" style={{ color: "var(--text-muted)" }}>
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

      <div className="flex flex-col gap-1 text-sm">
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
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.floodOnly}
            onChange={(e) => setFilters((f) => ({ ...f, floodOnly: e.target.checked }))}
          />
          <span style={{ color: "var(--text)" }}>Only posts about flooding</span>
        </label>
      </div>

      {communities.length > 0 && (
        <div>
          <label htmlFor="community" className="mb-1 block text-sm" style={{ color: "var(--text-muted)" }}>
            First Nations community
          </label>
          <select
            id="community"
            value={filters.community ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, community: e.target.value || null }))}
            className="w-full rounded px-2 py-1 text-sm"
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
  onSelectRecord,
  onPickCluster,
}: {
  clusters: Cluster[];
  brief: Brief | null;
  onSummarise: (withNarrative: boolean) => void;
  onDownload: (format: "geojson" | "csv" | "brief" | "sms") => void;
  onPickCluster: (cluster: Cluster) => void;
  onSelectRecord: (id: string) => void;
}) {
  const [plain, setPlain] = useState(false);

  const speak = () => {
    const text = plain && brief?.plainLanguage ? brief.plainLanguage : brief?.extractive;
    if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  return (
    <section aria-labelledby="brief-heading" className="flex flex-col gap-2">
      <h2 id="brief-heading" className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
        Situation
      </h2>

      {!brief ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onSummarise(false)}
            className="rounded px-2 py-1.5 text-sm"
            style={{ border: "1px solid var(--line-strong)", color: "var(--text)", borderRadius: "var(--radius)" }}
          >
            Summarise (local, instant)
          </button>
          <button
            type="button"
            onClick={() => onSummarise(true)}
            className="rounded px-2 py-1.5 text-sm"
            style={{ border: "1px solid var(--line-strong)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            title="Also asks a language model to write a narrative. Every sentence must cite the records it came from, or it is dropped."
          >
            Summarise with narrative
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
            {plain && brief.plainLanguage ? brief.plainLanguage : brief.extractive}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {brief.plainLanguage && (
              <button
                type="button"
                onClick={() => setPlain((v) => !v)}
                aria-pressed={plain}
                className="rounded px-2 py-1 text-sm"
                style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
              >
                {plain ? "Full wording" : "Plain language"}
              </button>
            )}
            <button
              type="button"
              onClick={speak}
              className="rounded px-2 py-1 text-sm"
              style={{ border: "1px solid var(--line)", color: "var(--text-muted)", borderRadius: "var(--radius)" }}
            >
              Read aloud
            </button>
          </div>

          {brief.narrative?.length ? (
            <ul className="flex flex-col gap-1.5">
              {brief.narrative.map((sentence, i) => (
                <li key={i} className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>
                  {sentence.sentence}{" "}
                  {/* The citations are the audit claim, so they are visible, focusable chips that
                      open the post, not a hover-only title. */}
                  <span className="inline-flex flex-wrap gap-1 align-middle">
                    {sentence.citedRecordIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onSelectRecord(id)}
                        aria-label={`Open cited post ${id}`}
                        className="rounded px-1 font-mono text-sm"
                        style={{ border: "1px solid var(--line-strong)", color: "var(--accent)" }}
                      >
                        {id}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {clusters.length > 0 && (
            <ul className="flex flex-col gap-1">
              {clusters.map((cluster) => (
                <li key={cluster.id}>
                  {/* A theme opens its posts in Reports; it was static text before. */}
                  <button
                    type="button"
                    onClick={() => onPickCluster(cluster)}
                    aria-label={`Show the ${count(cluster.size)} posts about ${cluster.label}`}
                    className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left text-sm hover:underline"
                  >
                    <span style={{ color: "var(--text)" }}>
                      {cluster.label}
                      {cluster.terms?.length ? (
                        <span style={{ color: "var(--text-faint)" }}>: {cluster.terms.join(", ")}</span>
                      ) : null}
                    </span>
                    <span className="font-mono" style={{ color: "var(--text-muted)" }}>
                      {count(cluster.size)}
                    </span>
                  </button>
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
            className="rounded px-2 py-1 text-sm uppercase"
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
