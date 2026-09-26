/**
 * Local, free, no network. Two jobs:
 *
 *  1. Detect the event profile from the corpus, so nothing about flooding is hardcoded
 *     and an unseen earthquake CSV works without a code change.
 *  2. Drop obvious noise before we spend money, and rank what is left, so Jev only sees
 *     plausible candidates. Roughly halves the paid calls on the provided dataset.
 *
 * This layer is also the degraded mode: when the circuit breaker opens, its scores become
 * the labels and records are marked `heuristic` in the UI.
 */

import type { EventProfile, HazardType } from "./types";

// ---------------------------------------------------------------------------
// text utilities
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "at", "by", "for", "with", "about",
  "to", "from", "in", "on", "is", "are", "was", "were", "be", "been", "being", "am",
  "it", "its", "this", "that", "these", "those", "as", "so", "than", "too", "very",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them", "his",
  "her", "their", "what", "which", "who", "whom", "how", "when", "where", "why",
  "all", "any", "both", "each", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "just", "now", "will", "can", "do", "does", "did",
  "have", "has", "had", "up", "out", "down", "over", "then", "there", "here", "get",
  "got", "rt", "via", "amp", "http", "https", "co", "like", "one", "would", "us",
]);

/** Strips urls, mentions and punctuation. Keeps hashtag words — they carry the event. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/#(\w+)/g, " $1 ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// deduplication
// ---------------------------------------------------------------------------

/**
 * Exact duplicates after normalization, plus retweet-of-the-same-body. Deliberately NOT
 * fuzzy: pairwise near-duplicate detection is O(n^2) and 8k rows would mean 64M string
 * comparisons for little gain. Documented as a limit rather than half-solved.
 */
export function dedupe<T extends { id: string; text: string }>(
  items: T[],
): { kept: Array<T & { duplicateCount: number }>; removed: number } {
  const byKey = new Map<string, T & { duplicateCount: number }>();
  let removed = 0;

  for (const item of items) {
    // Drop a leading "RT @someone:" so a retweet collapses into its original.
    const body = item.text.replace(/^RT\s+@?\w+:?\s*/i, "");
    const key = normalize(body);
    if (!key) continue;

    const existing = byKey.get(key);
    if (existing) {
      existing.duplicateCount++;
      removed++;
    } else {
      byKey.set(key, { ...item, duplicateCount: 1 });
    }
  }

  return { kept: [...byKey.values()], removed };
}

// ---------------------------------------------------------------------------
// event profile detection
// ---------------------------------------------------------------------------

/**
 * Stems use \w*, never a trailing \b. A boundary after a stem like "evacuat" can never
 * match "evacuated" or "evacuations" because the word continues. That bug silently
 * emptied a whole category once already — do not reintroduce it.
 */
export const HAZARD_LEXICON: Record<HazardType, RegExp> = {
  // No leading \b on the stems. Hashtags compound the hazard word into a longer token —
  // #yycflood, #abflood, #yycfloods — and \bflood cannot match inside "yycflood" because
  // there is no boundary between "yyc" and "flood". That one detail loses the 3,192 most
  // obviously relevant rows in the provided dataset.
  flood:
    /(?:flood|inundat|submerg|overflow|sandbag|levee|dike|dyke|washout|highwater)\w*|under\s?water|washed\s?out|water\s+(?:level|rise|rising|everywhere)|river\s+(?:rise|rising|crest)/i,
  // "ember" needs a leading boundary. Without one it matched inside remember, December,
  // September and member: 51 of the 89 fire matches in the Alberta file were ember-only, which
  // overstated the fire share and, with the off-hazard credit, kept posts like "a day to
  // remember" as candidates. Hashtag compounds are not a concern for this word.
  fire: /(?:wildfire|firefight|smoke|blaze|scorch)\w*|\bember\w*|fire\s+(?:ban|season|crew|evacuation)/i,
  quake: /(?:earthquake|quake|tremor|aftershock|seismic)\w*/i,
  storm:
    /(?:tornado|hurricane|blizzard|hailstorm|windstorm|thunderstorm|cyclone|typhoon)\w*|storm\s+surge/i,
  other: /(?!)/, // never matches; "other" is the fallback, not a detection
};

/**
 * Generic emergency vocabulary — supports relevance regardless of hazard type.
 * Keeps \b because false positives matter more here: "closed" must not fire on "enclosed".
 * Infrastructure words are included because "is the bridge open?" is exactly the report
 * the sponsor says sensors miss, and it may contain no hazard word at all.
 */
const EMERGENCY_TERMS =
  /\b(?:evacuat|displac|rescue|emergenc|shelter|damag|destro|stranded|trapped|closure|closed|impassable|detour|advisory|warning|relief|donat|volunteer|sandbag)\w*|\b(?:bridge|road|roads|highway|overpass|underpass|causeway)\b|state of emergency|red cross|do not (?:cross|drive|try)|is\s+\w+\s+open/i;

export interface ProfileOptions {
  /**
   * Place names to look for, supplied by the gazetteer. Passing none still works —
   * profile.places is simply empty and relevance leans on hazard and emergency terms.
   */
  knownPlaces?: string[];
  sampleSize?: number;
}

/**
 * Ranks gazetteer names by how many posts mention them, on whole-token boundaries.
 *
 * This used to be a bare `includes()`. That is wrong for a gazetteer that carries short aliases
 * such as airport codes and road numbers: "yxe" (Saskatoon) and "hwy 2" fired inside unrelated
 * text, so the header of a flood view read "near victoria, winnipeg, houston, morley, hwy 2,
 * yxe". A boundary-checked match is what makes the "detected event" line trustworthy.
 */
function rankPlaces(sample: string[], names: string[], limit = 8): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits: Array<[string, number]> = [];

  for (const name of names) {
    // Skip anything under 3 characters outright: even boundary-checked, "sg" or "nj" are more
    // likely to be a hashtag fragment than a place in a world feed.
    if (name.length < 3) continue;
    // No lookbehind: `(?<!...)` throws a SyntaxError on Safari before 16.4, and this runs in the
    // browser (via chunkedIngest), so it would have broken every large upload there. Consuming
    // one leading character instead is equivalent for a boolean test().
    const re = new RegExp(`(?:^|[^a-z0-9])${escape(name.toLowerCase())}(?![a-z0-9])`);
    let n = 0;
    for (const t of sample) if (re.test(t.toLowerCase())) n++;
    if (n > 0) hits.push([name, n]);
  }

  return hits
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

export function detectEventProfile(
  texts: string[],
  opts: ProfileOptions = {},
): EventProfile {
  // Sampling keeps detection instant on large uploads; the signal is highly redundant.
  const sample =
    texts.length > (opts.sampleSize ?? 2000)
      ? texts.filter((_, i) => i % Math.ceil(texts.length / (opts.sampleSize ?? 2000)) === 0)
      : texts;

  // --- hazard: highest match count, but only if it clears a margin over the runner-up
  const hazardCounts = new Map<HazardType, number>();
  for (const [hazard, re] of Object.entries(HAZARD_LEXICON) as Array<[HazardType, RegExp]>) {
    if (hazard === "other") continue;
    let n = 0;
    for (const t of sample) if (re.test(t)) n++;
    hazardCounts.set(hazard, n);
  }
  const ranked = [...hazardCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const enoughSignal = top && top[1] >= Math.max(5, sample.length * 0.02);
  const clearWinner = !second || top[1] >= second[1] * 1.5;
  const hazard: HazardType = enoughSignal && clearWinner ? top[0] : "other";

  // --- is this ONE event, or a feed of several? Measured on the two corpora we have:
  //   Alberta 2013 floods   flood 97%, fire 2%, storm 0%, quake 0%   -> one hazard
  //   CE Strategies bonus   storm 50%, flood 32%, quake 9%, fire 8%  -> mixed
  // "Two or more hazards each holding at least 15% of the hazard mentions" separates them
  // with a wide margin either side (nothing in Alberta reaches 15% besides flood, and the
  // bonus file has three above it). Naming a single dominant hazard for the second case is
  // meaningless: storm "wins" on raw volume while flood is the thing the task asks about.
  const mentionTotal = [...hazardCounts.values()].reduce((a, b) => a + b, 0);
  const hazardShares: Partial<Record<HazardType, number>> = {};
  if (mentionTotal > 0) {
    for (const [h, n] of hazardCounts) hazardShares[h] = n / mentionTotal;
  }
  const substantial = Object.values(hazardShares).filter((s) => (s ?? 0) >= 0.15).length;
  const mixed = enoughSignal && substantial >= 2;

  // --- distinctive terms: frequent, non-stopword, and not present in nearly everything
  const freq = new Map<string, number>();
  for (const t of sample) {
    for (const tok of new Set(tokenize(t))) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  }
  const terms = [...freq.entries()]
    .filter(([, n]) => n >= 3 && n < sample.length * 0.6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([term]) => term);

  // --- places: only names the gazetteer actually knows, ranked by how often they appear
  const places: string[] = opts.knownPlaces?.length ? rankPlaces(sample, opts.knownPlaces) : [];

  return {
    hazard,
    places,
    terms,
    userEdited: false,
    mixed,
    detectedHazard: hazard,
    hazardShares,
  };
}

/**
 * The policy layer on top of detection. When a corpus is mixed, "the dominant hazard" is not a
 * meaningful thing to detect, so we stop guessing and focus on the hazard this tool exists for.
 * That is a decision, made openly and shown to the user, not a silent heuristic.
 *
 * Also recomputes the place list from posts that actually mention the focus hazard. Otherwise a
 * mixed file's header would read "near Boston, Texas" for a flood view, because those places
 * dominate the corpus overall.
 */
export function focusProfile(
  profile: EventProfile,
  texts: string[],
  opts: ProfileOptions = {},
  target: HazardType = "flood",
): EventProfile {
  if (!profile.mixed || profile.userEdited) return profile;

  const re = HAZARD_LEXICON[target];
  const relevantTexts = texts.filter((t) => re.test(t));

  const sample =
    relevantTexts.length > (opts.sampleSize ?? 2000)
      ? relevantTexts.filter((_, i) => i % Math.ceil(relevantTexts.length / (opts.sampleSize ?? 2000)) === 0)
      : relevantTexts;
  const places = opts.knownPlaces?.length && sample.length ? rankPlaces(sample, opts.knownPlaces) : [];

  return {
    ...profile,
    hazard: target,
    focused: true,
    places: places.length ? places : profile.places,
  };
}

// ---------------------------------------------------------------------------
// candidate scoring
// ---------------------------------------------------------------------------

/** Obvious noise. Cheap to catch here so we never pay a model to read a job ad. */
const SPAM_PATTERNS = [
  /#(?:job|jobs|hiring|careers|tweetmyjobs)\b/i,
  /\b(?:we are hiring|apply now|click here|promo code|discount code|follow back)\b/i,
  /\bi(?:'m| am) at\b.*\bhttp/i, // location check-in spam
];

export interface PrefilterScore {
  /** 0..1. Not a probability — a ranking signal for who is worth paying for. */
  score: number;
  /** Why, for the UI and for the degraded-mode explanation. */
  reasons: string[];
  likelySpam: boolean;
}

export function scoreRelevance(text: string, profile: EventProfile): PrefilterScore {
  const reasons: string[] = [];
  let score = 0;

  const likelySpam = SPAM_PATTERNS.some((re) => re.test(text));
  if (likelySpam) reasons.push("matches spam pattern");

  // The detected profile is a corpus-wide GUESS of the dominant hazard, and it is only ever
  // one label. A corpus that genuinely mixes disasters (the CE Strategies bonus round: a
  // world CSV spanning floods, fires, quakes, storms and explosions) can have its guess land
  // on the wrong one by raw term volume, e.g. "storm" winning on Boston/hurricane counts.
  // Scoring ONLY the guessed hazard's lexicon then silently drops every post about a
  // different hazard before it ever reaches the classifier -- including posts that say
  // "flood" outright. Measured on the bonus corpus: "Bangladesh flood death toll rises" and
  // "Flooding in Sardinia after storm" both scored under the 0.15 threshold and were dropped.
  //
  // Fix: check the guessed hazard for its full weight (rewards a real single-hazard corpus,
  // e.g. Alberta, exactly as before), but also check every OTHER hazard lexicon for a smaller
  // credit. A single-hazard corpus is unaffected because its off-hazard matches are rare. A
  // mixed corpus now keeps candidates regardless of which one hazard the profile guessed,
  // and the per-record `hazard` choice question (asked with fixed, hazard-neutral wording,
  // never keyed to the profile) is what actually separates flood from fire from quake.
  const hazardRe = HAZARD_LEXICON[profile.hazard];
  if (profile.hazard !== "other" && hazardRe.test(text)) {
    score += 0.5;
    reasons.push(`mentions ${profile.hazard}`);
  } else if (!profile.focused) {
    // Skipped when the hazard was chosen deliberately (see focusProfile). The off-hazard credit
    // exists to survive a wrong GUESS; once the target is known, a tornado post earning credit
    // is just a paid model call spent on something the flood view will discard anyway.
    for (const [hazard, re] of Object.entries(HAZARD_LEXICON) as Array<[typeof profile.hazard, RegExp]>) {
      if (hazard === "other" || hazard === profile.hazard) continue;
      if (re.test(text)) {
        score += 0.3;
        reasons.push(`mentions ${hazard} (not the corpus's dominant hazard)`);
        break; // one off-hazard match is enough signal; do not stack them
      }
    }
  }

  if (EMERGENCY_TERMS.test(text)) {
    score += 0.25;
    reasons.push("emergency vocabulary");
  }

  const lower = text.toLowerCase();
  if (profile.places.some((p) => lower.includes(p.toLowerCase().split(",")[0]))) {
    score += 0.15;
    reasons.push("names a place from the event area");
  }

  const tokens = new Set(tokenize(text));
  const overlap = profile.terms.filter((t) => tokens.has(t)).length;
  if (overlap > 0) {
    score += Math.min(0.2, overlap * 0.04);
    reasons.push(`${overlap} shared corpus terms`);
  }

  return { score: Math.min(1, score), reasons, likelySpam };
}

/**
 * Keep anything that could plausibly be relevant. The threshold is deliberately generous:
 * a false positive costs a fraction of a cent, a false negative silently loses a report
 * from someone standing in floodwater. Spam is the only hard drop.
 */
export function prefilter<T extends { id: string; text: string }>(
  items: T[],
  profile: EventProfile,
  threshold = 0.15,
): {
  candidates: Array<T & { prefilter: PrefilterScore }>;
  dropped: Array<T & { prefilter: PrefilterScore }>;
} {
  const candidates: Array<T & { prefilter: PrefilterScore }> = [];
  const dropped: Array<T & { prefilter: PrefilterScore }> = [];

  for (const item of items) {
    const prefilterScore = scoreRelevance(item.text, profile);
    const row = { ...item, prefilter: prefilterScore };
    if (prefilterScore.likelySpam || prefilterScore.score < threshold) dropped.push(row);
    else candidates.push(row);
  }

  // Highest-scoring first: if a budget runs out mid-run, the best candidates are already done.
  candidates.sort((a, b) => b.prefilter.score - a.prefilter.score);
  return { candidates, dropped };
}
