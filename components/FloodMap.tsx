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

import { useEffect, useRef, useState } from "react";
// Namespace import: maplibre-gl ships no default export, so `import maplibregl from` fails.
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

import type { Category, FloodRecord } from "../lib/types";

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
      points.push({
        id: r.id,
        lon: p.lon,
        lat: p.lat,
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

  const points = toPoints(records);

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

    instance.on("load", () => {
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
          "circle-color": "#3f6fd6",
          "circle-opacity": 0.75,
          "circle-radius": ["step", ["get", "point_count"], 14, 25, 20, 100, 28],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
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
        paint: { "text-color": "#ffffff" },
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
          "circle-stroke-color": "#3f6fd6",
        },
      });

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
          .setText(`${String(props.label)} — ${Math.round(Number(props.confidence) * 100)}% confidence`)
          .addTo(instance);
      });
      instance.on("mouseleave", "points", () => {
        instance.getCanvas().style.cursor = "";
        popup.remove();
      });

      setReady(true);
    });

    instance.on("error", () => {
      // A failed tile fetch must not blank the app. The points layer still renders.
      setFailed(true);
    });

    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
    // Style and theme are handled in their own effects below, deliberately excluded here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the basemap when the theme or bandwidth mode changes, keeping camera and data.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    instance.setStyle(lowBandwidth ? BLANK_STYLE : dark ? CARTO_DARK : CARTO_LIGHT, {
      diff: false,
    });
    // setStyle with diff:false drops our sources and layers, so they are rebuilt on the next
    // styledata event. Cheaper and far less error-prone than diffing MapLibre style objects.
    instance.once("styledata", () => setReady(false));
  }, [dark, lowBandwidth, ready]);

  // Push data whenever the filtered record set changes.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource("reports") as GeoJSONSource | undefined;
    source?.setData(toGeoJson(points));
  }, [points, ready]);

  // Follow the selection, and highlight it.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    instance.setFilter("selected", ["==", ["get", "id"], selectedId ?? "__none__"]);
    if (!selectedId) return;
    const hit = points.find((p) => p.id === selectedId);
    if (!hit) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = { center: [hit.lon, hit.lat] as [number, number], zoom: Math.max(instance.getZoom(), 9) };
    if (reduce) instance.jumpTo(target);
    else instance.easeTo({ ...target, duration: 500 });
  }, [selectedId, points, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" role="application" aria-label="Map of flood reports" />

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

      {failed && (
        <div
          className="absolute bottom-2 left-2 rounded px-2 py-1 text-[11px]"
          style={{ background: "var(--review-weak)", color: "var(--review)" }}
        >
          Basemap tiles unavailable. Points are still accurate.
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
      </div>
    </div>
  );
}
