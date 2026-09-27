/**
 * Toponym extraction against a bundled gazetteer. No network, no API key, no rate limit.
 *
 * Design rules that matter more than recall:
 *  - Every hit carries `method` and `confidence`. Nothing is plotted that cannot be justified.
 *  - Ambiguity is preserved, not silently resolved: alternatives ride along on the hit.
 *  - "No place mentioned" is a first-class answer that the UI displays as a number.
 */

import gazetteerData from "../data/gazetteer.json";
import type { GeoMethod, PlaceHit } from "./types";

interface GazEntry {
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
  kind: string;
  admin: string;
  country: string;
  population?: number;
  isFirstNation?: boolean;
  community?: string;
}

const PLACES: GazEntry[] = (gazetteerData as { places: GazEntry[] }).places;

/** All alias strings, longest first, so "high river" wins before "river". */
const ALIAS_INDEX: Array<{ alias: string; entries: GazEntry[] }> = (() => {
  const byAlias = new Map<string, GazEntry[]>();
  for (const entry of PLACES) {
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      if (!byAlias.has(key)) byAlias.set(key, []);
      byAlias.get(key)!.push(entry);
    }
  }
  return [...byAlias.entries()]
    .map(([alias, entries]) => ({ alias, entries }))
    .sort((a, b) => b.alias.length - a.alias.length);
})();

export function knownPlaceNames(): string[] {
  return PLACES.map((p) => p.name);
}

/**
 * Countries behind a set of place names/aliases (typically `EventProfile.places`, the corpus's
 * own dominant mentions). Lets a caller scope geoparsing to the countries the corpus is actually
 * about, so a bare country/city name that also happens to be an English word or a retail brand
 * ("India Pale Ale", "London Drugs", a sports team's home city) does not plant a pin on the other
 * side of the world for a single-region corpus. A mixed, genuinely worldwide corpus passes no
 * scope at all and keeps full recall.
 */
export function countriesOf(names: string[]): Set<string> {
  const countries = new Set<string>();
  const lower = new Set(names.map((n) => n.toLowerCase()));
  for (const entry of PLACES) {
    if (lower.has(entry.name.toLowerCase()) || entry.aliases.some((a) => lower.has(a))) {
      countries.add(entry.country);
    }
  }
  return countries;
}

/**
 * How useful a hit is as a map pin. Lower is more specific. A bridge or a road is the
 * report a responder can act on; "Alberta" is technically a place and operationally useless.
 */
function specificity(kind?: string): number {
  switch (kind) {
    case "road":
    case "landmark":
      return 0;
    case "neighbourhood":
    case "river":
      return 1;
    case "hamlet":
    case "town":
    case "township":
    case "reserve":
      return 2;
    case "city":
      return 3;
    case "region":
      return 5;
    default:
      return 4;
  }
}

/** Aliases too, for the event-profile detector which matches against raw text. */
export function knownPlaceAliases(): string[] {
  return ALIAS_INDEX.map((a) => a.alias);
}

/**
 * Hashtags glue the place onto other words (#yycflood, #abflood) and punctuation runs into
 * names. Padding with spaces lets us use plain boundary checks without a tokenizer, and
 * splitting hashtag compounds is what lets "#yycflood" resolve to Calgary at all.
 */
function searchable(text: string): string {
  return (
    " " +
    text
      .toLowerCase()
      // surface alias fragments inside hashtag compounds: #yycflood -> " yyc flood "
      .replace(/#(\w+)/g, (_, word: string) => ` ${word} ${splitCompound(word)} `)
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ") +
    " "
  );
}

/** Splits a known alias off the front of a compound token: "yycflood" -> "yyc flood". */
function splitCompound(word: string): string {
  for (const { alias } of ALIAS_INDEX) {
    if (alias.length >= 3 && !alias.includes(" ") && word.startsWith(alias) && word !== alias) {
      return `${alias} ${word.slice(alias.length)}`;
    }
  }
  return "";
}

/**
 * Picks between candidates sharing an alias (London ON vs London UK, Millennium Park in
 * Calgary vs Chicago) using other places mentioned in the same text, then population.
 */
function disambiguate(
  candidates: GazEntry[],
  contextAdmins: Set<string>,
  contextCountries: Set<string>,
): { chosen: GazEntry; confidence: number; alternatives: GazEntry[] } {
  if (candidates.length === 1) {
    return { chosen: candidates[0], confidence: 0.85, alternatives: [] };
  }

  const scored = candidates.map((entry) => {
    let score = 0;
    if (contextAdmins.has(entry.admin)) score += 3; // same province as another mention
    if (contextCountries.has(entry.country)) score += 1;
    if (entry.population) score += Math.min(1, entry.population / 2_000_000);
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const [best, runnerUp] = scored;
  // A tie means we genuinely do not know. Say so with a low confidence rather than guessing
  // confidently — a wrongly-placed flood report is worse than an unplaced one.
  const margin = best.score - (runnerUp?.score ?? 0);
  const confidence = margin >= 3 ? 0.8 : margin >= 1 ? 0.55 : 0.35;

  return {
    chosen: best.entry,
    confidence,
    alternatives: scored.slice(1).map((s) => s.entry),
  };
}

export interface GeoparseInput {
  text: string;
  /** Coordinates already supplied by the upload or by image EXIF. */
  lat?: number;
  lon?: number;
  method?: GeoMethod;
  /** A place column from the CSV, treated as extra text to match against. */
  place?: string;
  /**
   * Restrict gazetteer hits to these countries when set (see `countriesOf`). A candidate whose
   * only entries fall outside this set is dropped entirely rather than kept as a wrong-country
   * guess -- an unplaced post is honest; a post pinned in the wrong country is not. Leave unset
   * for a corpus that is genuinely worldwide (`EventProfile.mixed`).
   */
  localCountries?: Set<string>;
}

export function geoparse(input: GeoparseInput): PlaceHit[] {
  // Provided or EXIF coordinates outrank any text inference.
  if (input.lat != null && input.lon != null) {
    const method: GeoMethod = input.method ?? "provided";
    const containing = nearestFirstNation(input.lat, input.lon);
    return [
      {
        name: input.place || (method === "exif" ? "EXIF coordinates" : "Provided coordinates"),
        kind: "point",
        lat: input.lat,
        lon: input.lon,
        confidence: 1,
        method,
        ...(containing ? { community: containing } : {}),
      },
    ];
  }

  const haystack = searchable(`${input.text} ${input.place ?? ""}`);

  // First pass: which aliases appear at all. Longest-first, and we blank out each match so
  // "high river" does not also register as "river".
  let remaining = haystack;
  const matches: Array<{ entries: GazEntry[]; alias: string }> = [];
  for (const { alias, entries } of ALIAS_INDEX) {
    const needle = ` ${alias} `;
    if (remaining.includes(needle)) {
      matches.push({ entries, alias });
      remaining = remaining.split(needle).join(" ");
    }
  }
  if (!matches.length) return [];

  // Narrow each match to the corpus's own countries before anything else. A candidate with no
  // entry in scope is dropped rather than kept under a foreign entry -- see `localCountries` on
  // GeoparseInput for why (this is the fix for aliases like "boston" or "india" that are also
  // common English words, planting single-region corpora worldwide).
  const scoped = input.localCountries?.size
    ? matches
        .map((m) => ({ ...m, entries: m.entries.filter((e) => input.localCountries!.has(e.country)) }))
        .filter((m) => m.entries.length > 0)
    : matches;
  if (!scoped.length) return [];

  // Context for disambiguation: unambiguous matches vote on province and country.
  const contextAdmins = new Set<string>();
  const contextCountries = new Set<string>();
  for (const m of scoped) {
    if (m.entries.length === 1) {
      contextAdmins.add(m.entries[0].admin);
      contextCountries.add(m.entries[0].country);
    }
  }

  const hits: PlaceHit[] = [];
  const seen = new Set<string>();

  for (const m of scoped) {
    const { chosen, confidence, alternatives } = disambiguate(
      m.entries,
      contextAdmins,
      contextCountries,
    );
    if (seen.has(chosen.name)) continue;
    seen.add(chosen.name);

    // A whole province or region is real but nearly useless as a map pin; mark it down so
    // it sorts below an actual town and reads as low confidence in the UI.
    const isBroad = chosen.kind === "region";

    hits.push({
      name: chosen.name,
      kind: chosen.kind,
      lat: chosen.lat,
      lon: chosen.lon,
      confidence: isBroad ? Math.min(confidence, 0.4) : confidence,
      method: "gazetteer",
      ...(alternatives.length
        ? {
            alternatives: alternatives.map((a) => ({ name: a.name, lat: a.lat, lon: a.lon })),
          }
        : {}),
      ...(chosen.community ? { community: { name: chosen.community, id: chosen.name } } : {}),
    });
  }

  // Most specific first, THEN confidence. Sorting by confidence alone lets "Calgary" (a
  // whole city, high confidence because unambiguous) outrank "Millennium Park, Calgary" —
  // which is the more useful pin and the thing the post actually named.
  hits.sort((a, b) => specificity(a.kind) - specificity(b.kind) || b.confidence - a.confidence);
  return hits;
}

const EARTH_KM = 6371;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Attributes a coordinate to a First Nations community when it is close enough to matter.
 * Proper polygon containment needs the NRCan reserve boundaries; this is a documented
 * approximation using a 25km radius around the community centroid, and the UI must not
 * present it as a legal boundary determination.
 */
export function nearestFirstNation(
  lat: number,
  lon: number,
  radiusKm = 25,
): { name: string; id: string } | undefined {
  let best: { entry: GazEntry; km: number } | undefined;
  for (const entry of PLACES) {
    if (!entry.isFirstNation) continue;
    const km = haversineKm(lat, lon, entry.lat, entry.lon);
    if (km <= radiusKm && (!best || km < best.km)) best = { entry, km };
  }
  return best ? { name: best.entry.community ?? best.entry.name, id: best.entry.name } : undefined;
}

/** Communities represented across a set of records — powers the per-community rollup. */
export function communityRollup(
  records: Array<{ places: PlaceHit[] }>,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const names = new Set(
      r.places.map((p) => p.community?.name).filter((n): n is string => Boolean(n)),
    );
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
