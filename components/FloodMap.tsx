"use client";

/**
 * MapLibre map. No access token, no Mapbox account: basemap tiles come from CARTO's free
 * GL styles, and low-bandwidth mode drops tiles entirely.
 *
 * Points render as a clustered GeoJSON layer rather than DOM markers. Four thousand DOM
 * markers locks the tab; a vector layer does not care. The keyboard path to every point is
 * the records table, which carries the same data and the same filters (see RecordsTable and
 * docs/ACCESSIBILITY.md) -- that is the text equivalent, not a lesser fallback.
 */

import { useEffect, useMemo, useRef, useState } from "react";
// Namespace import: maplibre-gl ships no default export, so `import maplibregl from` fails.
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import type { Category, FloodRecord } from "../lib/types";
import { communityRollup } from "../lib/geoparse";
import { CATEGORY_META } from "../lib/display";
import gazetteerData from "../data/gazetteer.json";

// MapLibre 6 resolves its worker relative to import.meta.url, which the bundler rewrites into
// /_next/static/chunks/ without emitting the worker there. scripts/copy-maplibre-worker.mjs
// serves it from public/maplibre/ instead; without this line the map is blank.
if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.origin).href);
}

const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const CARTO_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/**
 * Tileless style for low-bandwidth mode. A fly-in community on a degraded satellite link
 * cannot wait on raster tiles, and the points are the information -- the basemap is context.
 */
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1b1f26" } }],
  glyphs: "https://basemaps.cartocdn.com/gl/positron-gl-style/{fontstack}/{range}.pbf",
};

/** Category colours as literal hex, because MapLibre paint expressions cannot read CSS vars. */
const CATEGORY_COLOR: Record<Category, string> = {
  rescue_request: "#d6453d",
  access_blocked: "#d6453d",
  evacuation: "#c98a2b",
  damage: "#c98a2b",
  advisory: "#3f6fd6",
  aid: "#1f8f8f",
  sentiment: "#8a8f98",
};

/** Only the fields FloodMap needs from a gazetteer entry. */
interface ReserveEntry {
  name: string;
  lat: number;
  lon: number;
  kind: string;
  community?: string;
}

/** Reserve points, for the "not a boundary" ring overlay. Same 25 km proximity radius the
 * geoparsing pipeline uses to attribute a coordinate to a First Nations community. */
const RESERVES: ReserveEntry[] = (
  gazetteerData as { places: ReserveEntry[] }
).places.filter((p) => p.kind === "reserve");

/** Resolve a CSS custom property to the colour the browser is actually using, since MapLibre
 * paint expressions cannot read `var(...)` themselves. Falls back to the literal when the
 * variable is unset (e.g. server-side render, or a stylesheet that has not loaded yet). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return fallback;
  // The design tokens are OKLCH, which MapLibre's colour parser rejects: an invalid paint
  // colour fails addLayer, fires the map "error" event and silently drops the cluster layer.
  // Paint one pixel with the token and read it back as plain sRGB instead.
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = fallback;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

/** A ~64-vertex polygon approximating a 25 km radius circle around a point. Degrees, not
 * metres, so longitude is corrected for latitude -- otherwise circles near the pole are ovals. */
function reserveRingCoords(lat: number, lon: number, radiusKm = 25): GeoJSON.Position[] {
  const steps = 64;
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const coords: GeoJSON.Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    coords.push([lon + dLon * Math.sin(angle), lat + dLat * Math.cos(angle)]);
  }
  return coords;
}

function reservesGeoJson(counts: Map<string, number> = new Map()): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: "FeatureCollection",
    features: RESERVES.map((r) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [reserveRingCoords(r.lat, r.lon)] },
      properties: {
        name: r.name,
        community: r.community ?? r.name,
        hasPosts: (counts.get(r.community ?? r.name) ?? 0) > 0,
      },
    })),
  };
}

interface Point {
  id: string;
  lon: number;
  lat: number;
  category: Category | "unknown";
  confidence: number;
  exact: boolean;
  label: string;
}

function toPoints(records: FloodRecord[]): Point[] {
  const points: Point[] = [];
  for (const r of records) {
    for (const p of r.places) {
      // A place without finite, in-range coordinates cannot be drawn, and handing one to
      // easeTo/fitBounds throws "Invalid LngLat (NaN, NaN)" and takes the page down.
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      points.push({
        id: r.id,
        lon,
        lat,
        category: r.labels.category?.value ?? "unknown",
        confidence: r.labels.relevant?.confidence ?? 0,
        exact: p.method !== "gazetteer",
        label: p.name,
      });
    }
  }
  return points;
}

function toGeoJson(points: Point[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      // RFC 7946 order. Reversing these silently relocates Calgary to Kazakhstan.
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id,
        category: p.category,
        confidence: p.confidence,
        exact: p.exact,
        label: p.label,
      },
    })),
  };
}

export function FloodMap({
  records,
  selectedId,
  onSelect,
  lowBandwidth,
  dark,
}: {
  records: FloodRecord[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  lowBandwidth: boolean;
  dark: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // The style URL currently applied, so the swap effect only calls setStyle on a real change.
  const appliedStyle = useRef<string | StyleSpecification | null>(null);

  // Memoised: a fresh array every render re-ran the data and camera effects on every render.
  const points = useMemo(() => toPoints(records), [records]);
  const latestPoints = useRef(points);
  /** Posts per community, so rings rebuilt on style.load keep their visibility. */
  const reserveCounts = useRef(new Map<string, number>());
  latestPoints.current = points;
  const latestRecords = useRef(records);
  latestRecords.current = records;

  // Whether the point set has ever been non-empty, so the initial-fit effect fires once per
  // empty-to-loaded transition rather than on every filter change.
  const hadPoints = useRef(false);
  /** Point count at the last automatic fit, and whether the user has taken the camera since. */
  const fitCount = useRef(0);
  const userMoved = useRef(false);

  // One DOM marker per reserve, created once and repositioned/relabelled as data changes.
  const reserveMarkers = useRef<maplibregl.Marker[]>([]);

  // Keyboard path to every point on the map, for a keyboard- or screen-reader-only user.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showKeyboardHint, setShowKeyboardHint] = useState(false);
  const focusMarker = useRef<maplibregl.Marker | null>(null);

  // Create the map once. Re-creating it on every style change would reset the viewport and
  // throw away the user's pan and zoom, which is infuriating mid-triage.
  useEffect(() => {
    if (!container.current || map.current) return;

    let instance: MapLibreMap;
    try {
      instance = new maplibregl.Map({
        container: container.current,
        style: lowBandwidth ? BLANK_STYLE : dark ? CARTO_DARK : CARTO_LIGHT,
        center: [-114.07, 51.04],
        zoom: 5,
        attributionControl: { compact: true },
        // Respect the OS setting rather than animating camera moves regardless.
        fadeDuration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300,
      });
    } catch {
      setFailed(true);
      return;
    }

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    instance.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    // MapLibre's own keyboard handler pans/zooms on these same arrow keys; our keyboard path
    // (below) moves between reports instead, so the built-in one would just fight it.
    instance.keyboard.disable();
    // A drag, scroll or pinch carries an originalEvent; programmatic fits do not.
    instance.on("movestart", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) userMoved.current = true;
    });

    // Reserve labels are plain DOM markers, not a map layer, so they do not need to be rebuilt
    // on "style.load" -- only the source/layer that draws the rings does.
    reserveMarkers.current = RESERVES.map((r) => {
      const el = document.createElement("div");
      Object.assign(el.style, {
        fontSize: "14px",
        background: "var(--surface-raised)",
        border: "1px solid var(--line)",
        padding: "1px 5px",
        borderRadius: "3px",
        color: "var(--text)",
        pointerEvents: "none",
        whiteSpace: "nowrap",
      });
      el.textContent = r.community ?? r.name;
      // Anchored at the south edge of the 25 km ring, not the centre: DOM markers always draw
      // above the canvas, and a centred label sat on top of the Calgary cluster next door.
      return new maplibregl.Marker({ element: el, anchor: "top" })
        .setLngLat([r.lon, r.lat - 25 / 111.32])
        .addTo(instance);
    });

    // Label only communities with posts until the user zooms in, so 19 labels do not bury
    // the report clusters at province scale.
    const syncReserveLabels = () => {
      const zoomedIn = instance.getZoom() >= 8;
      for (const m of reserveMarkers.current) {
        const el = m.getElement();
        el.style.display = zoomedIn || el.dataset.posts === "1" ? "" : "none";
      }
    };
    instance.on("zoomend", syncReserveLabels);
    instance.once("load", syncReserveLabels);

    appliedStyle.current = lowBandwidth ? BLANK_STYLE : dark ? CARTO_DARK : CARTO_LIGHT;

    // Every setStyle drops our sources and layers, and "load" fires only once, so rebuild on
    // "style.load", which fires for the initial style and after every swap.
    instance.on("style.load", () => {
      const accentColor = cssVar("--accent", "#3f6fd6");
      const surfaceRaisedColor = cssVar("--surface-raised", "#ffffff");
      const ringColor = cssVar("--text", "#333");

      // Added first so it paints beneath the report layers below.
      instance.addSource("reserves", { type: "geojson", data: reservesGeoJson(reserveCounts.current) });
      instance.addLayer({
        id: "reserve-rings",
        type: "line",
        source: "reserves",
        paint: {
          "line-color": ringColor,
          "line-width": 1.2,
          "line-dasharray": [4, 3],
          // At province scale, 19 unlabeled dashed circles read as noise: draw only the
          // communities that have posts until the user zooms in, matching the labels.
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, ["case", ["get", "hasPosts"], 1, 0], 8, 1],
        },
      });

      instance.addSource("reports", {
        type: "geojson",
        data: toGeoJson([]),
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
      });

      instance.addLayer({
        id: "clusters",
        type: "circle",
        source: "reports",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": accentColor,
          "circle-opacity": 0.75,
          "circle-radius": ["step", ["get", "point_count"], 14, 25, 20, 100, 28],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": surfaceRaisedColor,
        },
      });

      instance.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "reports",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
        },
        paint: { "text-color": surfaceRaisedColor },
      });

      instance.addLayer({
        id: "points",
        type: "circle",
        source: "reports",
        filter: ["!", ["has", "point_count"]],
        paint: {
          // Written out literally rather than spread from CATEGORY_ORDER: MapLibre types a
          // match expression as a fixed-arity tuple, so a spread cannot satisfy it.
          "circle-color": [
            "match",
            ["get", "category"],
            "rescue_request", CATEGORY_COLOR.rescue_request,
            "access_blocked", CATEGORY_COLOR.access_blocked,
            "evacuation", CATEGORY_COLOR.evacuation,
            "damage", CATEGORY_COLOR.damage,
            "advisory", CATEGORY_COLOR.advisory,
            "aid", CATEGORY_COLOR.aid,
            "sentiment", CATEGORY_COLOR.sentiment,
            "#8a8f98",
          ],
          // Radius encodes confidence, so a low-confidence placement is visibly smaller
          // rather than looking as certain as an exact one.
          "circle-radius": ["interpolate", ["linear"], ["get", "confidence"], 0, 4, 1, 8],
          "circle-opacity": 0.85,
          // A solid ring means exact coordinates; a thin ring means an inferred place name.
          "circle-stroke-width": ["case", ["get", "exact"], 2.5, 1],
          "circle-stroke-color": "#ffffff",
        },
      });

      instance.addLayer({
        id: "selected",
        type: "circle",
        source: "reports",
        filter: ["==", ["get", "id"], "__none__"],
        paint: {
          "circle-color": "transparent",
          "circle-radius": 14,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": accentColor,
        },
      });

      (instance.getSource("reports") as GeoJSONSource).setData(toGeoJson(latestPoints.current));
      setReady(true);
    });

    // Handlers are bound by layer id, so they survive style swaps. Bind them once.
    {
      instance.on("click", "points", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === "string") onSelect(id);
      });

      instance.on("click", "clusters", async (e) => {
        const feature = e.features?.[0];
        const clusterId = feature?.properties?.cluster_id;
        if (clusterId == null) return;
        const source = instance.getSource("reports") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(Number(clusterId));
        instance.easeTo({
          center: (feature!.geometry as GeoJSON.Point).coordinates as [number, number],
          zoom,
        });
      });

      // Tooltips must not be hover-only: this also fires on tap, and the table carries the
      // same information for keyboard and screen-reader users.
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      instance.on("mouseenter", "points", (e) => {
        instance.getCanvas().style.cursor = "pointer";
        const props = e.features?.[0]?.properties;
        if (!props) return;
        popup
          .setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number])
          .setText(`${String(props.label)}, ${Math.round(Number(props.confidence) * 100)}% confidence`)
          .addTo(instance);
      });
      instance.on("mouseleave", "points", () => {
        instance.getCanvas().style.cursor = "";
        popup.remove();
      });
    }

    instance.on("error", () => {
      // A failed tile fetch must not blank the app. The points layer still renders.
      setFailed(true);
    });

    map.current = instance;
    return () => {
      reserveMarkers.current.forEach((m) => m.remove());
      reserveMarkers.current = [];
      focusMarker.current?.remove();
      focusMarker.current = null;
      instance.remove();
      map.current = null;
    };
    // Style and theme are handled in their own effects below, deliberately excluded here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the basemap when the theme or bandwidth mode changes, keeping camera and data.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const next = lowBandwidth ? BLANK_STYLE : dark ? CARTO_DARK : CARTO_LIGHT;
    if (appliedStyle.current === next) return;
    appliedStyle.current = next;
    // diff:false drops our sources and layers; the style.load handler rebuilds them. Until it
    // does, ready is false so no effect touches a layer that does not exist.
    setReady(false);
    instance.setStyle(next, { diff: false });
  }, [dark, lowBandwidth]);

  // Push data whenever the filtered record set changes.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource("reports") as GeoJSONSource | undefined;
    source?.setData(toGeoJson(points));
  }, [points, ready]);

  // Fit the camera to the data once, the moment a dataset goes from empty to loaded. Filtering
  // afterwards must not keep yanking the viewport around, so this only fires on that transition.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    // Records stream in, so fitting only on the first point framed a single street. Refit as
    // the set grows by half again, until the user takes the camera; reset per dataset.
    if (!points.length) {
      fitCount.current = 0;
      userMoved.current = false;
    }
    const grew = fitCount.current === 0 || points.length >= fitCount.current * 1.5;
    if (points.length && grew && !userMoved.current) {
      fitCount.current = points.length;
      const lons = points.map((p) => p.lon);
      const lats = points.map((p) => p.lat);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      instance.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 48, maxZoom: 10, ...(reduce ? { duration: 0 } : {}) },
      );
    }
    hadPoints.current = points.length > 0;
  }, [points, ready]);

  // Relabel the reserve markers whenever the record set changes -- the count is how many of
  // the records currently passed to the map name a place within 25 km of that community.
  useEffect(() => {
    const counts = new Map(communityRollup(records).map((c) => [c.name, c.count]));
    reserveCounts.current = counts;
    (map.current?.getSource("reserves") as GeoJSONSource | undefined)?.setData(reservesGeoJson(counts));
    reserveMarkers.current.forEach((marker, i) => {
      const reserve = RESERVES[i];
      if (!reserve) return;
      const label = reserve.community ?? reserve.name;
      const n = counts.get(label) ?? 0;
      const el = marker.getElement();
      el.textContent = n > 0 ? `${label}, ${n} ${n === 1 ? "post" : "posts"}` : label;
      el.style.fontWeight = n > 0 ? "600" : "400";
      el.dataset.posts = n > 0 ? "1" : "0";
      const zoomedIn = (map.current?.getZoom() ?? 0) >= 8;
      el.style.display = zoomedIn || n > 0 ? "" : "none";
    });
  }, [records]);

  // Follow the selection, and highlight it.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    instance.setFilter("selected", ["==", ["get", "id"], selectedId ?? "__none__"]);
    if (!selectedId) return;
    userMoved.current = true;
    const hit = points.find((p) => p.id === selectedId);
    if (!hit) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = { center: [hit.lon, hit.lat] as [number, number], zoom: Math.max(instance.getZoom(), 9) };
    if (reduce) instance.jumpTo(target);
    else instance.easeTo({ ...target, duration: 500 });
  }, [selectedId, points, ready]);

  // Move the keyboard focus marker to `index`, pan the camera to it, and announce it. This is
  // the keyboard- and screen-reader-accessible path to a point that the mouse-only cluster
  // layer cannot offer on its own.
  function moveKeyboardFocus(index: number) {
    userMoved.current = true;
    const instance = map.current;
    const pts = latestPoints.current;
    const point = pts[index];
    if (!instance || !point) return;

    if (!focusMarker.current) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        width: "26px",
        height: "26px",
        borderRadius: "50%",
        border: "3px solid var(--accent)",
        background: "transparent",
        boxSizing: "border-box",
        pointerEvents: "none",
      });
      focusMarker.current = new maplibregl.Marker({ element: el }).setLngLat([point.lon, point.lat]).addTo(instance);
    } else {
      focusMarker.current.setLngLat([point.lon, point.lat]);
    }

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = { center: [point.lon, point.lat] as [number, number], zoom: Math.max(instance.getZoom(), 8) };
    // Never pass duration: undefined. MapLibre merges it over its default, divides by it and
    // produces NaN camera positions ("Invalid LngLat (NaN, NaN)") on every frame.
    instance.easeTo({ ...target, ...(reduce ? { duration: 0 } : {}) });

    const categoryLabel = point.category !== "unknown" ? CATEGORY_META[point.category].label : "Unclassified";
    const record = latestRecords.current.find((r) => r.id === point.id);
    const snippet = (record?.text ?? "").slice(0, 90);
    setAnnouncement(`${index + 1} of ${pts.length}: ${categoryLabel}, ${point.label}, ${Math.round(point.confidence * 100)}% sure it is about the event. ${snippet}`);
  }

  function handleMapKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const pts = latestPoints.current;
    if (e.key === "Enter") {
      if (focusIndex != null && pts[focusIndex]) onSelect(pts[focusIndex].id);
      return;
    }
    if (e.key === "Escape") {
      focusMarker.current?.remove();
      focusMarker.current = null;
      setFocusIndex(null);
      setAnnouncement("");
      return;
    }
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const backward = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !backward) return;
    e.preventDefault();
    if (!pts.length) return;
    setFocusIndex((prev) => {
      const next = prev == null ? 0 : Math.min(Math.max(prev + (forward ? 1 : -1), 0), pts.length - 1);
      moveKeyboardFocus(next);
      return next;
    });
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={container}
        className="h-full w-full"
        role="application"
        aria-label={`Map of ${points.length} mapped reports. Use the arrow keys to move between reports and Enter to open one.`}
        tabIndex={0}
        onKeyDown={handleMapKeyDown}
        onFocus={() => setShowKeyboardHint(true)}
        onBlur={() => setShowKeyboardHint(false)}
      />

      <div
        aria-live="polite"
        className="sr-only"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {announcement}
      </div>

      <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
        {showKeyboardHint && (
          <div
            className="rounded px-2 py-1 text-[11px]"
            style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", color: "var(--text)" }}
          >
            Arrow keys move between reports. Enter opens one.
          </div>
        )}

        {failed && (
          <div
            className="rounded px-2 py-1 text-[11px]"
            style={{ background: "var(--review-weak)", color: "var(--review)" }}
          >
            Basemap tiles unavailable. Report positions are unaffected.
          </div>
        )}
      </div>

      {!points.length && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p
            className="rounded px-3 py-2 text-xs"
            style={{ background: "var(--surface-raised)", color: "var(--text-muted)", border: "1px solid var(--line)" }}
          >
            No mapped reports yet. Records that name no place are listed in the table.
          </p>
        </div>
      )}

      {/* The honest key. Encodes what the ring width and dot size actually mean. */}
      <div
        className="absolute bottom-2 right-2 rounded px-2 py-1.5 text-[10px] leading-relaxed"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", color: "var(--text-muted)" }}
      >
        <div>
          <strong style={{ color: "var(--text)" }}>Thick ring</strong> exact coordinates
        </div>
        <div>
          <strong style={{ color: "var(--text)" }}>Thin ring</strong> place name inferred
        </div>
        <div>
          <strong style={{ color: "var(--text)" }}>Dot size</strong> confidence
        </div>
        <div className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={{ display: "inline-block", width: "14px", borderTop: "1.5px dashed var(--text-muted)" }}
          />
          First Nation, 25 km matching radius (proximity, not a boundary)
        </div>
      </div>
    </div>
  );
}
