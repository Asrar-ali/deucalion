/**
 * Merges world flood-relevant places into data/gazetteer.json. Idempotent: re-running skips
 * names already present, so it is safe to run twice.
 *   node scripts/add-world-places.mjs
 *
 * Why these places: the CE Strategies bonus corpus is a world feed drawn from 2012-2013 disaster
 * events. The flood events in it are Alberta (already covered), Colorado (Sept 2013), Queensland
 * (#bigwet, Jan 2013), Sardinia (Nov 2013, #sardegna), Manila and the wider Philippines
 * (habagat, Typhoon Pablo/Bopha, Typhoon Haiyan storm surge), and the flooding that came with
 * Hurricane Sandy around New York and New Jersey. Everything else in the feed (Boston, West TX,
 * Amuay, Lac-Megantic) is not a flood, but is included so a flood post that MENTIONS one of those
 * places still resolves rather than vanishing from the map.
 *
 * Coordinates are city or region centroids, good to about 3 decimals. They are pins for a
 * situational map, not survey points, and the UI already labels gazetteer matches "inferred".
 *
 * Aliases are lowercase ASCII only: lib/geoparse.ts strips every non a-z0-9 character before
 * matching, so an accented alias like "megantic" written with an accent can never match.
 * Bare common words ("west", "moore", "sg") are deliberately NOT used as aliases.
 */

import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../data/gazetteer.json", import.meta.url);
const data = JSON.parse(readFileSync(path, "utf8"));
const have = new Set(data.places.map((p) => p.name.toLowerCase()));

const P = (name, aliases, lat, lon, kind, admin, country, extra = {}) => ({
  name, aliases, lat, lon, kind, admin, country, ...extra,
});

const NEW = [
  // --- Sardinia floods, Nov 2013 ------------------------------------------------------------
  P("Sardinia, Italy", ["sardinia", "sardegna"], 40.1209, 9.0129, "region", "SAR", "IT"),
  P("Olbia, Sardinia", ["olbia"], 40.9237, 9.4963, "city", "SAR", "IT"),
  P("Cagliari, Sardinia", ["cagliari"], 39.2238, 9.1217, "city", "SAR", "IT"),
  P("Sassari, Sardinia", ["sassari"], 40.7259, 8.5556, "city", "SAR", "IT"),
  P("Italy", ["italy", "italia"], 41.8719, 12.5674, "region", "", "IT"),
  P("Rome, Italy", ["rome", "roma"], 41.9028, 12.4964, "city", "LAZ", "IT"),

  // --- Colorado floods, Sept 2013 -----------------------------------------------------------
  P("Colorado", ["colorado", "coflood", "coloradoflood"], 39.5501, -105.7821, "region", "CO", "US"),
  P("Boulder, CO", ["boulder", "boulderflood"], 40.015, -105.2705, "city", "CO", "US"),
  P("Denver, CO", ["denver"], 39.7392, -104.9903, "city", "CO", "US"),
  P("Longmont, CO", ["longmont"], 40.1672, -105.1019, "city", "CO", "US"),
  P("Estes Park, CO", ["estes park"], 40.3772, -105.5217, "town", "CO", "US"),
  P("Lyons, CO", ["lyons colorado", "lyons co"], 40.2247, -105.2714, "town", "CO", "US"),
  P("Loveland, CO", ["loveland"], 40.3978, -105.075, "city", "CO", "US"),
  P("Greeley, CO", ["greeley"], 40.4233, -104.7091, "city", "CO", "US"),

  // --- Queensland floods, Jan 2013 (#bigwet, #qldfloods) -----------------------------------
  P("Queensland, Australia", ["queensland", "qldfloods", "qld"], -20.9176, 142.7028, "region", "QLD", "AU"),
  P("Brisbane, QLD", ["brisbane", "brisbaneflood"], -27.4698, 153.0251, "city", "QLD", "AU"),
  P("Bundaberg, QLD", ["bundaberg"], -24.8661, 152.3489, "city", "QLD", "AU"),
  P("Rockhampton, QLD", ["rockhampton"], -23.3791, 150.51, "city", "QLD", "AU"),
  P("Gold Coast, QLD", ["gold coast"], -28.0167, 153.4, "city", "QLD", "AU"),
  P("Sydney, NSW", ["sydney"], -33.8688, 151.2093, "city", "NSW", "AU"),
  P("Blue Mountains, NSW", ["blue mountains"], -33.7, 150.3, "region", "NSW", "AU"),
  P("New South Wales", ["new south wales", "nsw", "nswfires"], -32.0, 147.0, "region", "NSW", "AU"),
  P("Australia", ["australia"], -25.2744, 133.7751, "region", "", "AU"),

  // --- Philippines: Manila floods, Typhoon Pablo (Bopha), Typhoon Haiyan --------------------
  P("Philippines", ["philippines", "pilipinas"], 12.8797, 121.774, "region", "", "PH"),
  P("Manila, Philippines", ["manila", "metro manila", "mmflood"], 14.5995, 120.9842, "city", "NCR", "PH"),
  P("Quezon City, Philippines", ["quezon city"], 14.676, 121.0437, "city", "NCR", "PH"),
  P("Marikina, Philippines", ["marikina"], 14.6507, 121.1029, "city", "NCR", "PH"),
  P("Tacloban, Philippines", ["tacloban"], 11.2543, 125.0, "city", "LEY", "PH"),
  P("Cebu City, Philippines", ["cebu"], 10.3157, 123.8854, "city", "CEB", "PH"),
  P("Davao City, Philippines", ["davao"], 7.1907, 125.4553, "city", "DAV", "PH"),
  P("Cagayan de Oro, Philippines", ["cagayan de oro"], 8.4542, 124.6319, "city", "MSR", "PH"),
  P("Compostela Valley, Philippines", ["compostela valley"], 7.6, 126.1, "region", "COM", "PH"),

  // --- Hurricane Sandy flooding, Oct 2012 ---------------------------------------------------
  P("New York City, NY", ["new york city", "nyc", "new york"], 40.7128, -74.006, "city", "NY", "US"),
  P("New Jersey", ["new jersey"], 40.0583, -74.4057, "region", "NJ", "US"),
  P("Hoboken, NJ", ["hoboken"], 40.744, -74.0324, "city", "NJ", "US"),
  P("Atlantic City, NJ", ["atlantic city"], 39.3643, -74.4229, "city", "NJ", "US"),
  P("Staten Island, NY", ["staten island"], 40.5795, -74.1502, "region", "NY", "US"),
  P("Long Island, NY", ["long island"], 40.7891, -73.135, "region", "NY", "US"),

  // --- Small tails: 10 to 11 flood posts each in this feed, but a world gazetteer should know them
  P("Jakarta, Indonesia", ["jakarta"], -6.2088, 106.8456, "city", "JK", "ID"),
  P("Indonesia", ["indonesia"], -0.7893, 113.9213, "region", "", "ID"),
  P("Bangkok, Thailand", ["bangkok"], 13.7563, 100.5018, "city", "", "TH"),
  P("Thailand", ["thailand"], 15.87, 100.9925, "region", "", "TH"),
  P("India", ["india"], 20.5937, 78.9629, "region", "", "IN"),
  P("Pakistan", ["pakistan"], 30.3753, 69.3451, "region", "", "PK"),

  // --- Bangladesh: measured on this feed, 924 posts name it, 617 are about the building collapse
  // and none mention flooding. Kept for completeness only, NOT because the feed floods there ----
  P("Bangladesh", ["bangladesh"], 23.685, 90.3563, "region", "", "BD"),
  P("Dhaka, Bangladesh", ["dhaka"], 23.8103, 90.4125, "city", "", "BD"),
  P("Chittagong, Bangladesh", ["chittagong", "chattogram"], 22.3569, 91.7832, "city", "", "BD"),

  // --- Not floods, but named in the same feed; kept so flood posts that mention them resolve --
  P("Boston, MA", ["boston", "bostonmarathon", "prayforboston"], 42.3601, -71.0589, "city", "MA", "US"),
  P("West, TX", ["west tx", "west texas", "westtx"], 31.8032, -97.0917, "town", "TX", "US"),
  P("Waco, TX", ["waco"], 31.5493, -97.1467, "city", "TX", "US"),
  P("Texas", ["texas", "prayfortexas"], 31.0, -100.0, "region", "TX", "US"),
  P("Oklahoma City, OK", ["oklahoma city", "okc"], 35.4676, -97.5164, "city", "OK", "US"),
  P("Moore, OK", ["moore oklahoma", "moore ok"], 35.3395, -97.4867, "city", "OK", "US"),
  P("Oklahoma", ["oklahoma", "prayforoklahoma"], 35.5, -97.5, "region", "OK", "US"),
  P("Lac-Megantic, QC", ["megantic", "lac megantic"], 45.5833, -70.8833, "town", "QC", "CA"),
  P("Venezuela", ["venezuela"], 6.4238, -66.5897, "region", "", "VE"),
  P("Amuay, Venezuela", ["amuay"], 11.7472, -70.2131, "town", "FAL", "VE"),
  P("Punto Fijo, Venezuela", ["punto fijo"], 11.6914, -70.1996, "city", "FAL", "VE"),
  P("Singapore", ["singapore", "sghaze"], 1.3521, 103.8198, "city", "", "SG"),
  P("Spain", ["spain", "espana"], 40.4637, -3.7492, "region", "", "ES"),
  P("Santiago de Compostela, Spain", ["santiago de compostela"], 42.8782, -8.5448, "city", "GA", "ES"),
];

let added = 0;
const skipped = [];
for (const entry of NEW) {
  if (have.has(entry.name.toLowerCase())) { skipped.push(entry.name); continue; }
  if (!(Math.abs(entry.lat) <= 90 && Math.abs(entry.lon) <= 180)) {
    throw new Error(`bad coordinates for ${entry.name}`);
  }
  data.places.push(entry);
  have.add(entry.name.toLowerCase());
  added++;
}

// Replaces a note left by an interrupted earlier edit that CLAIMED this coverage before any of it
// was actually added. A note describing places that are not in the file is worse than no note.
data.note =
  "Curated gazetteer. Bundled so geoparsing needs no network, no API key and no rate limit, and " +
  "works offline in low-bandwidth mode. Deep on the 2013 Alberta flood area (the provided dataset) " +
  "and on Northwestern Ontario / fly-in First Nations (the sponsor's working region). Extended for " +
  "the world bonus feed with the flood events it contains: Sardinia, Colorado, Queensland, the " +
  "Philippines (Manila, Typhoons Pablo and Haiyan) and the Sandy flooding around New York and New " +
  "Jersey, plus a handful of non-flood places that feed also names. City and region centroids, not " +
  "survey points. Adding a place: append an entry with lowercase ASCII aliases, since " +
  "lib/geoparse.ts strips every non a-z0-9 character before matching.";

// One place per line, matching how the file was hand-authored. Pretty-printing with
// JSON.stringify(data, null, 2) would turn every entry into ten lines and bury a real change in
// a diff that touches the whole file.
const body = data.places.map((p) => "    " + JSON.stringify(p)).join(",\n");
writeFileSync(path, `{\n  "note": ${JSON.stringify(data.note)},\n  "places": [\n${body}\n  ]\n}\n`);
console.log(`added ${added}, skipped ${skipped.length} already present${skipped.length ? `: ${skipped.join(", ")}` : ""}`);
console.log(`gazetteer now holds ${data.places.length} places`);
