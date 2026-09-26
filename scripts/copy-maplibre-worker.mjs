/**
 * MapLibre 6 ships its web worker as separate ES modules and locates them relative to
 * import.meta.url. Next's bundler moves the main module into /_next/static/chunks/ but does
 * not emit the worker next to it, so the worker 404s and the map renders blank.
 *
 * Copy the worker (and the shared chunk it imports) into public/maplibre/ so FloodMap can
 * point setWorkerUrl() at a stable path. Runs before dev and build, including on Vercel.
 */

import { copyFileSync, mkdirSync } from "node:fs";

const src = new URL("../node_modules/maplibre-gl/dist/", import.meta.url);
const out = new URL("../public/maplibre/", import.meta.url);
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(new URL(f, src), new URL(f, out));
}
console.log("maplibre worker copied to public/maplibre/");
