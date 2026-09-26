/**
 * Mixed-corpus behaviour, measured on both real files. No network, no cost.
 *   npx tsx scripts/test-mixed.mts
 *
 * The CE Strategies bonus round is a 61k-row WORLD feed mixing floods, fires, quakes, storms
 * and explosions, and asks for the flood posts only. Auto-detecting "the" hazard of a file like
 * that is meaningless (storm won on raw volume while flood is the actual target), and scoring
 * only the guessed hazard silently dropped literal flood posts. These assertions pin the fix.
 */

import { readFileSync } from "node:fs";
import { dedupe, detectEventProfile, focusProfile, prefilter, scoreRelevance } from "../lib/prefilter";
import { knownPlaceAliases } from "../lib/geoparse";

function load(path: string): string[] {
  const raw = readFileSync(new URL(path, import.meta.url), "utf8");
  const rows: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (c === '"' && raw[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === "\n") { rows.push(f.replace(/\r$/, "")); f = ""; }
    else f += c;
  }
  if (f) rows.push(f);
  return rows.slice(1).filter((t) => t.trim());
}

const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

const opts = { knownPlaces: knownPlaceAliases() };

// --- Alberta: one event. Must pass through untouched. -----------------------------------
console.log("alberta 2013 (single hazard)");
{
  const texts = dedupe(load("../public/sample/alberta-2013.csv").map((text, i) => ({ id: `a${i}`, text }))).kept.map((r) => r.text);
  const detected = detectEventProfile(texts, opts);
  const focused = focusProfile(detected, texts, opts);
  const pct = (h: string) => Math.round((detected.hazardShares?.[h as "flood"] ?? 0) * 100);
  console.log(`      shares: flood ${pct("flood")}% fire ${pct("fire")}% storm ${pct("storm")}% quake ${pct("quake")}%`);
  check(detected.hazard === "flood", "detects flood");
  check(detected.mixed === false, "is NOT mixed");
  check(focused === detected, "focusProfile returns the profile unchanged (same object)");
  check(!focused.focused, "not marked focused, so off-hazard credit stays on as a safety net");
}

// --- Bonus: a world feed. Must be flagged mixed and focused on flood. -------------------
console.log("\nbonus world feed (mixed hazards)");
{
  const texts = dedupe(load("../public/sample/bonus-global.csv").map((text, i) => ({ id: `b${i}`, text }))).kept.map((r) => r.text);
  const detected = detectEventProfile(texts, opts);
  const focused = focusProfile(detected, texts, opts);
  const pct = (h: string) => Math.round((detected.hazardShares?.[h as "flood"] ?? 0) * 100);
  console.log(`      shares: flood ${pct("flood")}% fire ${pct("fire")}% storm ${pct("storm")}% quake ${pct("quake")}%`);
  console.log(`      detected: ${detected.detectedHazard}  focused on: ${focused.hazard}`);
  console.log(`      places for the flood view: ${focused.places.slice(0, 6).join(", ") || "(none)"}`);

  check(detected.mixed === true, "is flagged mixed");
  check(focused.hazard === "flood", "focused on flood, deliberately");
  check(focused.focused === true, "marked focused");
  check(focused.detectedHazard === detected.detectedHazard, "keeps what detection found, so the UI can be honest about it");

  // The bug that motivated all of this: real flood posts scoring under the threshold.
  const FLOOD_POSTS = [
    "RT @newscientist: Climate change blamed as #Australia lurches from fire to flood http://t.co/szxtcw7m #extremeweather",
    "Flooding in Sardinia after storm #sardegna",
    "Flood waters rising fast in Boulder, Colorado, roads closed #coflood",
    "Queensland floods: Bundaberg residents evacuated as the river peaks #bigwet",
  ];
  for (const t of FLOOD_POSTS) {
    const s = scoreRelevance(t, focused);
    check(s.score >= 0.15 && !s.likelySpam, `flood post survives the prefilter (score ${s.score.toFixed(2)}): ${t.slice(0, 48)}`);
  }

  // Focus mode must stop paying for other hazards, or the whole point is lost.
  const TORNADO = "Oklahoma tornado destroyed hundreds of homes in Moore, thoughts with everyone";
  const tornadoFocused = scoreRelevance(TORNADO, focused).score;
  const tornadoUnfocused = scoreRelevance(TORNADO, { ...focused, focused: false }).score;
  // Only the relative drop is asserted. The prefilter is a deliberately generous recall net:
  // "destroyed hundreds of homes" still earns emergency-vocabulary credit and stays a candidate,
  // because a generic disaster-response post may well be flood-related. The model's per-post
  // hazard question, asked with fixed wording, is what actually separates flood from tornado.
  check(tornadoFocused < tornadoUnfocused, `a tornado post scores lower once focused (${tornadoFocused.toFixed(2)} vs ${tornadoUnfocused.toFixed(2)})`);

  // The payoff: fewer paid calls for the same recall on the target hazard.
  const asRecords = texts.map((text, i) => ({ id: `b${i}`, text }));
  const unfocused = prefilter(asRecords, { ...detected, focused: false }).candidates.length;
  const focusedCount = prefilter(asRecords, focused).candidates.length;
  console.log(`      candidates: ${unfocused} unfocused vs ${focusedCount} focused (${texts.length} unique posts)`);
  check(focusedCount < unfocused, "focusing sends fewer posts to the paid model");
}

if (failures.length) {
  console.error(`\nFAILED: ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
