"use client";

/**
 * MapLibre map. No access token, no account: streets come from OpenFreeMap, satellite imagery
 * from Esri's public World Imagery tiles, and low-bandwidth mode drops tiles entirely.
 *
 * Every gazetteer placement carries a precision halo: a circle drawn in metres, as wide as the
 * uncertainty in where the post is. A post that only says "Calgary" sits on the city centre;
 * the halo says "somewhere in here", so the dot never reads as a pin on one street.
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
import { GlobeHemisphereWest, MapTrifold } from "@phosphor-icons/react/dist/ssr";

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

export type Basemap = "streets" | "satellite";

const STREETS_LIGHT = "https://tiles.openfreemap.org/styles/liberty";
const STREETS_DARK = "https://tiles.openfreemap.org/styles/dark";

// Every style shares one glyph server, so our own label layers can name fonts it actually has.
// A font stack the server lacks 404s and the labels silently vanish.
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const FONT_REGULAR = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Bold"];

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    imagery: {
      type: "raster",
      tileSize: 256,
      maxzoom: 19,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
    places: {
      type: "raster",
      tileSize: 256,
      maxzoom: 19,
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
    },
  },
  layers: [
    { id: "imagery", type: "raster", source: "imagery" },
    { id: "places", type: "raster", source: "places" },
  ],
};

/**
 * Tileless style for low-bandwidth mode. A fly-in community on a degraded satellite link
 * cannot wait on raster tiles, and the points are the information -- the basemap is context.
 */
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1b1f26" } }],
  glyphs: GLYPHS,
};

function styleFor(basemap: Basemap, dark: boolean, lowBandwidth: boolean): string | StyleSpecification {
  if (lowBandwidth) return BLANK_STYLE;
  if (basemap === "satellite") return SATELLITE_STYLE;
  return dark ? STREETS_DARK : STREETS_LIGHT;
}

/**
 * How far from the drawn point a gazetteer placement may really be, in metres, by place kind.
 * Roughly the radius of a typical place of that kind in Alberta. Provided and EXIF coordinates
 * are exact and get no halo.
 */
const UNCERTAINTY_M: Record<string, number> = {
  landmark: 250,
  road: 600,
  neighbourhood: 1500,
  hamlet: 1500,
  river: 2000,
  town: 3000,
  reserve: 4000,
  township: 5000,
  city: 8000,
  // Drawn as a wide circle to show "somewhere around here"; the copy never quotes this figure.
  region: 25000,
};

function uncertaintyMeters(method: string, kind?: string): number {
  if (method !== "gazetteer") return 0;
  return UNCERTAINTY_M[kind ?? ""] ?? 3000;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
}

/** "the city centre", "the road", for copy that says where a stacked post was drawn. */
function placeCentre(kind: string): string {
  if (kind === "road" || kind === "river") return `a point on the ${kind}`;
  if (kind === "landmark") return "the landmark";
  return kind ? `the centre of the ${kind}` : "the place's centre";
}

// A circle radius in metres, as pixels: at zoom 20 one pixel is 0.1493 m at the equator,
// scaled by cos(latitude), and each zoom level down halves it.
const METRE_RADIUS = [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  0,
  ["/", ["get", "r20"], 1048576],
  20,
  ["get", "r20"],
] as unknown as maplibregl.ExpressionSpecification;

/** "1.2k" above a thousand, so a stack count fits inside its dot. */
const ABBREVIATED = (field: maplibregl.ExpressionSpecification) =>
  [
    "case",
    [">=", field, 1000],
    ["concat", ["to-string", ["/", ["round", ["/", field, 100]], 10]], "k"],
    ["to-string", field],
  ] as unknown as maplibregl.ExpressionSpecification;

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

/** One point per reserve carrying its post count, for the label layer (collision-managed by
 * MapLibre, unlike DOM markers which always overlap and draw over the sidebar). */
function reservePointsGeoJson(counts: Map<string, number>): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: RESERVES.map((r) => {
      const name = r.community ?? r.name;
      const n = counts.get(name) ?? 0;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lon, r.lat - 25 / 111.32] },
        properties: { text: n > 0 ? `${name}, ${n} ${n === 1 ? "post" : "posts"}` : name, posts: n },
      };
    }),
  };
}

/** Bounds of the points for the first fit: the central 90 percent per axis when there are more
 * than 50, so a few stray geocodes (India, Australia) do not zoom the whole map out to the world.
 * Trimmed points stay on the map and reachable by pan and zoom. */
function fitBoundsOf(points: Point[]): [[number, number], [number, number]] {
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const n = points.length;
  const lo = n > 50 ? Math.floor(n * 0.05) : 0;
  const hi = n > 50 ? Math.ceil(n * 0.95) - 1 : n - 1;
  return [
    [lons[lo], lats[lo]],
    [lons[hi], lats[hi]],
  ];
}

interface Point {
  id: string;
  lon: number;
  lat: number;
  category: Category | "unknown";
  confidence: number;
  exact: boolean;
  label: string;
  kind: string;
  /** Uncertainty radius in metres; 0 for exact coordinates. */
  meters: number;
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
        kind: p.kind ?? "",
        meters: uncertaintyMeters(p.method, p.kind),
      });
    }
  }
  return points;
}

/**
 * One feature per distinct spot. Posts that name only a city all share its centroid; drawn one
 * by one they are a single dot at every zoom (past the cluster zoom, 192 Manila posts looked
 * like one). Merged, the dot carries the count and a click lists them.
 */
function toGeoJson(points: Point[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const stacks = new Map<string, Point[]>();
  for (const p of points) {
    const key = `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
    const stack = stacks.get(key);
    if (stack) stack.push(p);
    else stacks.set(key, [p]);
  }
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const stack of stacks.values()) {
    const first = stack[0];
    const ids = [...new Set(stack.map((p) => p.id))];
    // The stack takes the colour most of its posts have.
    const tally = new Map<string, number>();
    for (const p of stack) tally.set(p.category, (tally.get(p.category) ?? 0) + 1);
    const category = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const meters = Math.min(...stack.map((p) => p.meters));
    features.push({
      type: "Feature",
      // RFC 7946 order. Reversing these silently relocates Calgary to Kazakhstan.
      geometry: { type: "Point", coordinates: [first.lon, first.lat] },
      properties: {
        id: first.id,
        // Pipe-delimited so a filter can test membership with a plain substring match.
        ids: `|${ids.join("|")}|`,
        n: ids.length,
        category,
        confidence: Math.max(...stack.map((p) => p.confidence)),
        exact: stack.every((p) => p.exact),
        label: first.label,
        kind: first.kind,
        meters,
        r20: meters / (0.1493 * Math.cos((first.lat * Math.PI) / 180)),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Where a post was drawn and how precise that is, in plain words. */
function precisionText(exact: boolean, kind: string, meters: number): string {
  if (exact || meters === 0) return "Exact location, from coordinates in the post";
  // A region can be a whole province; no single distance describes that honestly.
  if (kind === "region") return "Names only a region, so it could be anywhere in it";
  return `Placed at ${placeCentre(kind)}, accurate to about ${formatDistance(meters)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Popup bodies are built with textContent, never HTML strings: post text is untrusted.
function hoverContent(props: Record<string, unknown>): HTMLElement {
  const n = Number(props.n);
  const box = el("div", "map-tip");
  box.append(el("strong", "", n > 1 ? `${String(props.label)}, ${n} posts` : String(props.label)));
  box.append(el("div", "", precisionText(props.exact === true, String(props.kind ?? ""), Number(props.meters))));
  box.append(
    el(
      "div",
      "map-tip-faint",
      n > 1 ? "Click to list them" : `${Math.round(Number(props.confidence) * 100)}% sure it is about the event`,
    ),
  );
  return box;
}

const STACK_LIST_MAX = 100;

function stackListContent(opts: {
  ids: string[];
  label: string;
  kind: string;
  meters: number;
  exact: boolean;
  records: FloodRecord[];
  onPick: (id: string) => void;
  onClose: () => void;
}): HTMLElement {
  const byId = new Map(opts.records.map((r) => [r.id, r]));
  const box = el("div", "map-stack");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", `${opts.ids.length} posts at ${opts.label}`);
  box.append(el("h3", "map-stack-title", `${opts.ids.length} posts name ${opts.label}`));
  box.append(el("p", "map-stack-note", `${precisionText(opts.exact, opts.kind, opts.meters)}, so they share one point.`));
  const list = el("ul", "map-stack-list");
  // Most urgent first, so a rescue request is not buried under a thousand comments.
  const ranked = [...opts.ids].sort(
    (a, b) =>
      (byId.get(b)?.labels.severity?.value ?? 0) - (byId.get(a)?.labels.severity?.value ?? 0) ||
      (byId.get(b)?.labels.relevant?.confidence ?? 0) - (byId.get(a)?.labels.relevant?.confidence ?? 0),
  );
  for (const id of ranked.slice(0, STACK_LIST_MAX)) {
    const record = byId.get(id);
    if (!record) continue;
    const category = record.labels.category?.value;
    const button = el("button", "map-stack-item");
    button.type = "button";
    const dot = el("span", "map-stack-dot");
    dot.style.background = category ? CATEGORY_COLOR[category] : "#8a8f98";
    dot.setAttribute("aria-hidden", "true");
    const text = record.text.trim();
    button.append(dot, el("span", "", text ? (text.length > 90 ? `${text.slice(0, 90)}…` : text) : "Photo report, no text"));
    button.addEventListener("click", () => opts.onPick(id));
    const item = el("li", "");
    item.append(button);
    list.append(item);
  }
  box.append(list);
  if (opts.ids.length > STACK_LIST_MAX) {
    box.append(el("p", "map-stack-note", `And ${opts.ids.length - STACK_LIST_MAX} more in the table below the map.`));
  }
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      opts.onClose();
    }
  });
  return box;
}

/** Matches the merged feature holding `id`, whether it is alone or part of a stack. */
function selectedFilter(id: string | null): maplibregl.FilterSpecification {
  return ["in", `|${id ?? "__none__"}|`, ["to-string", ["get", "ids"]]];
}

/** Same colours as CATEGORY_COLOR, as a paint expression. */
const CATEGORY_MATCH = [
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
] as unknown as maplibregl.ExpressionSpecification;

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
  // Session only: the app writes a single localStorage key (the prefs the wipe control clears),
  // and a basemap choice is not worth a second one.
  const [basemap, setBasemap] = useState<Basemap>("streets");
  // The style URL currently applied, so the swap effect only calls setStyle on a real change.
  const appliedStyle = useRef<string | StyleSpecification | null>(null);
  // Whether the applied style is imagery or the blank dark ground, where our labels and rings
  // must be light whatever the app theme is.
  const darkGround = useRef(false);

  // Memoised: a fresh array every render re-ran the data and camera effects on every render.
  const points = useMemo(() => toPoints(records), [records]);
  const latestPoints = useRef(points);
  latestPoints.current = points;
  const latestRecords = useRef(records);
  latestRecords.current = records;
  const pannedTo = useRef<string | null>(null);

  // Whether the point set has ever been non-empty, so the initial-fit effect fires once per
  // empty-to-loaded transition rather than on every filter change.
  /** Point count at the last automatic fit, and whether the user has taken the camera since. */
  const fitCount = useRef(0);
  const userMoved = useRef(false);

  // Latest per-community post counts, so the reserve label layer can be rebuilt after a style swap.
  const reserveCounts = useRef<Map<string, number>>(new Map());
  const [legendOpen, setLegendOpen] = useState(false);

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
        style: styleFor(basemap, dark, lowBandwidth),
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
    // Fullscreen the wrapper, not the canvas, so the basemap switcher and key come along.
    instance.addControl(
      new maplibregl.FullscreenControl({ container: container.current.parentElement ?? undefined }),
      "top-right",
    );
    instance.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    // MapLibre's own keyboard handler pans/zooms on these same arrow keys; our keyboard path
    // (below) moves between reports instead, so the built-in one would just fight it.
    instance.keyboard.disable();
    // A drag, scroll or pinch carries an originalEvent; programmatic fits do not.
    instance.on("movestart", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) userMoved.current = true;
    });

    appliedStyle.current = styleFor(basemap, dark, lowBandwidth);
    darkGround.current = lowBandwidth || basemap === "satellite";

    // Every setStyle drops our sources and layers, and "load" fires only once, so rebuild on
    // "style.load", which fires for the initial style and after every swap.
    instance.on("style.load", () => {
      const accentColor = cssVar("--accent", "#3f6fd6");
      const surfaceRaisedColor = cssVar("--surface-raised", "#ffffff");
      const labelHaloColor = darkGround.current ? "rgba(12, 16, 22, 0.85)" : surfaceRaisedColor;
      const ringColor = darkGround.current ? "#f4f6f8" : cssVar("--text", "#333");
      const labelColor = darkGround.current ? "#f4f6f8" : cssVar("--text", "#222");

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
          // Unlabelled rings read as noise at province scale: only communities with posts until zoom 8.
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, ["case", ["get", "hasPosts"], 1, 0], 8, 1],
        },
      });

      // Reserve names are a symbol layer so MapLibre resolves collisions: busiest communities win,
      // the rest drop out rather than stacking. Communities with no posts only label when zoomed in.
      instance.addSource("reserve-points", { type: "geojson", data: reservePointsGeoJson(reserveCounts.current) });
      instance.addLayer({
        id: "reserve-labels",
        type: "symbol",
        source: "reserve-points",
        filter: ["any", [">", ["get", "posts"], 0], [">=", ["zoom"], 8]],
        layout: {
          "text-field": ["get", "text"],
          "text-font": FONT_REGULAR,
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 9, 12],
          "text-anchor": "top",
          "text-max-width": 8,
          "text-allow-overlap": false,
          "text-optional": true,
          "symbol-sort-key": ["-", 0, ["get", "posts"]],
        },
        paint: {
          "text-color": labelColor,
          "text-halo-color": labelHaloColor,
          "text-halo-width": 1.5,
        },
      });

      instance.addSource("reports", {
        type: "geojson",
        data: toGeoJson([]),
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 11,
        // Features are already merged per spot, so a cluster's size is the sum of their posts,
        // not the number of features.
        clusterProperties: { total: ["+", ["get", "n"]] },
      });

      // Beneath everything else of ours: the halo is context, the dot is the post.
      instance.addLayer({
        id: "halos",
        type: "circle",
        source: "reports",
        filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "r20"], 0]],
        paint: {
          "circle-radius": METRE_RADIUS,
          "circle-color": CATEGORY_MATCH,
          "circle-opacity": darkGround.current ? 0.2 : 0.13,
          "circle-stroke-color": CATEGORY_MATCH,
          "circle-stroke-opacity": darkGround.current ? 0.8 : 0.55,
          "circle-stroke-width": 1,
          "circle-pitch-alignment": "map",
        },
      });

      instance.addLayer({
        id: "clusters",
        type: "circle",
        source: "reports",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": accentColor,
          "circle-opacity": 0.8,
          "circle-radius": ["step", ["get", "total"], 14, 25, 20, 100, 26, 1000, 32],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": darkGround.current ? "#ffffff" : surfaceRaisedColor,
        },
      });

      instance.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "reports",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ABBREVIATED(["get", "total"] as maplibregl.ExpressionSpecification),
          "text-font": FONT_BOLD,
          "text-size": 11,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });

      instance.addLayer({
        id: "points",
        type: "circle",
        source: "reports",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": CATEGORY_MATCH,
          // A stack grows with its count. A single post's radius encodes confidence, so a
          // low-confidence placement is visibly smaller rather than looking as certain.
          "circle-radius": [
            "case",
            [">", ["get", "n"], 1],
            ["interpolate", ["linear"], ["get", "n"], 2, 10, 20, 13, 200, 18],
            ["interpolate", ["linear"], ["get", "confidence"], 0, 4, 1, 8],
          ],
          "circle-opacity": 0.9,
          // A solid ring means exact coordinates; a thin ring means an inferred place name.
          "circle-stroke-width": ["case", ["get", "exact"], 2.5, 1.2],
          "circle-stroke-color": "#ffffff",
        },
      });

      instance.addLayer({
        id: "stack-count",
        type: "symbol",
        source: "reports",
        filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "n"], 1]],
        layout: {
          "text-field": ABBREVIATED(["get", "n"] as maplibregl.ExpressionSpecification),
          "text-font": FONT_BOLD,
          "text-size": 11,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0, 0, 0, 0.35)", "text-halo-width": 1 },
      });

      instance.addLayer({
        id: "selected",
        type: "circle",
        source: "reports",
        filter: selectedFilter(null),
        paint: {
          "circle-color": "transparent",
          "circle-radius": ["case", [">", ["get", "n"], 1], 22, 14],
          "circle-stroke-width": 2.5,
          "circle-stroke-color": darkGround.current ? "#ffffff" : accentColor,
        },
      });

      (instance.getSource("reports") as GeoJSONSource).setData(toGeoJson(latestPoints.current));
      setReady(true);
    });

    // Handlers are bound by layer id, so they survive style swaps. Bind them once.
    {
      // Tooltips must not be hover-only: this also fires on tap, and the table carries the
      // same information for keyboard and screen-reader users.
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px" });

      // A stack opens a list of its posts; one post opens directly.
      const stackPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "320px" });
      instance.on("click", "points", (e) => {
        const feature = e.features?.[0];
        const props = feature?.properties;
        if (!props) return;
        const ids = String(props.ids ?? "").split("|").filter(Boolean);
        if (ids.length <= 1) {
          if (typeof props.id === "string") onSelect(props.id);
          return;
        }
        popup.remove();
        const close = () => {
          stackPopup.remove();
          container.current?.focus();
        };
        stackPopup
          .setLngLat((feature!.geometry as GeoJSON.Point).coordinates as [number, number])
          .setDOMContent(
            stackListContent({
              ids,
              label: String(props.label),
              kind: String(props.kind ?? ""),
              meters: Number(props.meters),
              exact: props.exact === true,
              records: latestRecords.current,
              onPick: (id) => {
                stackPopup.remove();
                onSelect(id);
              },
              onClose: close,
            }),
          )
          .addTo(instance);
        // Keyboard and screen-reader users land in the list, not back on the canvas.
        stackPopup.getElement()?.querySelector<HTMLButtonElement>(".map-stack-item")?.focus({ preventScroll: true });
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

      instance.on("mouseenter", "points", (e) => {
        instance.getCanvas().style.cursor = "pointer";
        const props = e.features?.[0]?.properties;
        if (!props || stackPopup.isOpen()) return;
        popup
          .setLngLat((e.features![0].geometry as GeoJSON.Point).coordinates as [number, number])
          .setDOMContent(hoverContent(props))
          .addTo(instance);
      });
      instance.on("mouseenter", "clusters", () => {
        instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", "clusters", () => {
        instance.getCanvas().style.cursor = "";
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
      focusMarker.current?.remove();
      focusMarker.current = null;
      instance.remove();
      map.current = null;
    };
    // Style and theme are handled in their own effects below, deliberately excluded here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the basemap when the choice, theme or bandwidth mode changes, keeping camera and data.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const next = styleFor(basemap, dark, lowBandwidth);
    if (appliedStyle.current === next) return;
    appliedStyle.current = next;
    darkGround.current = lowBandwidth || basemap === "satellite";
    // diff:false drops our sources and layers; the style.load handler rebuilds them. Until it
    // does, ready is false so no effect touches a layer that does not exist.
    setReady(false);
    setFailed(false);
    instance.setStyle(next, { diff: false });
  }, [basemap, dark, lowBandwidth]);

  // Push data whenever the filtered record set changes.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const source = instance.getSource("reports") as GeoJSONSource | undefined;
    source?.setData(toGeoJson(points));
  }, [points, ready]);

  // Fit the camera to the data when a dataset first arrives, and again as it grows by half, until
  // the user takes the camera. Reset when the dataset empties (a new file). Padding leaves room
  // for the report detail panel on the right and the key/controls; maxZoom stops a tight cluster
  // zooming to street level. A hidden (zero-size) container is skipped and retried on resize.
  const fitToData = useRef<() => void>(() => {});
  fitToData.current = () => {
    const instance = map.current;
    if (!instance || !ready || !container.current) return;
    if (!points.length) {
      fitCount.current = 0;
      userMoved.current = false;
      return;
    }
    if (container.current.clientWidth < 50 || container.current.clientHeight < 50) return;
    const grew = fitCount.current === 0 || points.length >= fitCount.current * 1.5;
    if (!grew || userMoved.current) return;
    fitCount.current = points.length;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wide = container.current.clientWidth > 700;
    instance.fitBounds(fitBoundsOf(points), {
      padding: { top: 56, bottom: 56, left: 56, right: wide ? 64 : 56 },
      maxZoom: 11,
      ...(reduce ? { duration: 0 } : {}),
    });
  };
  useEffect(() => {
    fitToData.current();
  }, [points, ready]);
  useEffect(() => {
    const el = container.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // resize() must run on every container-size change, not only while fitToData is still
    // allowed to move the camera. A phone's browser chrome collapsing during a pinch gesture
    // resizes this container; once the user has touched the map (userMoved becomes true),
    // fitToData returns early and resize() was never reached, leaving MapLibre painting into a
    // canvas sized for the old viewport -- a blank strip or a misaligned map on mobile.
    const ro = new ResizeObserver(() => {
      map.current?.resize();
      fitToData.current();
    });
    ro.observe(el);
    // Belt and suspenders: some mobile browsers change the visible viewport (URL bar
    // collapsing, on-screen keyboard, rotation) without the map container's own box changing
    // size enough for ResizeObserver to fire promptly.
    const onViewportResize = () => map.current?.resize();
    window.visualViewport?.addEventListener("resize", onViewportResize);
    window.addEventListener("orientationchange", onViewportResize);
    return () => {
      ro.disconnect();
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      window.removeEventListener("orientationchange", onViewportResize);
    };
  }, []);

  // Relabel the reserve layer whenever the record set changes -- the count is how many of the
  // records currently passed to the map name a place within 25 km of that community.
  useEffect(() => {
    reserveCounts.current = new Map(communityRollup(records).map((c) => [c.name, c.count]));
    // Counts are kept in the ref either way; style.load rebuilds the sources from it. Touching
    // sources mid-style-load is what threw "Style is not done loading".
    if (!map.current || !ready) return;
    const source = map.current.getSource("reserve-points") as GeoJSONSource | undefined;
    source?.setData(reservePointsGeoJson(reserveCounts.current));
    (map.current?.getSource("reserves") as GeoJSONSource | undefined)?.setData(reservesGeoJson(reserveCounts.current));
  }, [records, ready]);

  // Follow the selection, and highlight it.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    instance.setFilter("selected", selectedFilter(selectedId));
    if (!selectedId) {
      pannedTo.current = null;
      return;
    }
    // Pan once per selection. A basemap swap or filter change re-runs this effect, and
    // snapping the camera back to the selection each time fights the user's own panning.
    if (pannedTo.current === selectedId) return;
    userMoved.current = true;
    const hit = points.find((p) => p.id === selectedId);
    if (!hit) return;
    pannedTo.current = selectedId;
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
        {!lowBandwidth && (
          <div
            role="group"
            aria-label="Basemap"
            className="map-basemaps flex overflow-hidden rounded text-xs font-medium"
            style={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", boxShadow: "var(--shadow)" }}
          >
            {(
              [
                ["streets", "Streets", MapTrifold],
                ["satellite", "Satellite", GlobeHemisphereWest],
              ] as const
            ).map(([value, label, Icon]) => {
              const active = basemap === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setBasemap(value)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5"
                  style={{
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "var(--accent-text)" : "var(--text)",
                  }}
                >
                  <Icon size={15} weight={active ? "fill" : "regular"} aria-hidden /> {label}
                </button>
              );
            })}
          </div>
        )}

        {showKeyboardHint && (
          <div
            className="rounded px-2 py-1 text-[11px]"
            style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", color: "var(--text)" }}
          >
            Arrow keys move between reports. Enter opens one.
          </div>
        )}

        {/* The honest key, collapsed to a compact control so it never crowds the attribution or
            the detail panel. Encodes what the ring width and dot size actually mean. */}
        <div
          className="max-w-[240px] rounded text-[11px] leading-snug"
          style={{ background: "var(--surface-raised)", border: "1px solid var(--line-strong)", color: "var(--text-muted)" }}
        >
          <button
            type="button"
            aria-expanded={legendOpen}
            aria-controls="map-key"
            onClick={() => setLegendOpen((v) => !v)}
            className="flex w-full items-center gap-1 px-2 py-1 font-semibold"
            style={{ color: "var(--text)" }}
          >
            <span aria-hidden="true">{legendOpen ? "\u25BE" : "\u25B8"}</span> Map key
          </button>
          {legendOpen && (
            <div id="map-key" className="space-y-1 px-2 pb-1.5">
              <div className="flex items-start gap-1.5">
                <span aria-hidden="true" className="map-key-halo" />
                <span>
                  <strong style={{ color: "var(--text)" }}>Soft circle</strong>: how precise the place is. A post
                  naming only a city spreads about 8 km, a road about 600 m.
                </span>
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Thick ring, no circle</strong>: exact coordinates
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Number on a dot</strong>: posts at the same spot. Click to
                list them.
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>Dot size</strong>: confidence
              </div>
              <div className="flex items-start gap-1.5">
                <span
                  aria-hidden="true"
                  className="mt-[7px] shrink-0"
                  style={{ display: "inline-block", width: "14px", borderTop: "1.5px dashed var(--text-muted)" }}
                />
                <span>First Nation, 25 km matching radius (proximity, not a boundary)</span>
              </div>
            </div>
          )}
        </div>

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

    </div>
  );
}
