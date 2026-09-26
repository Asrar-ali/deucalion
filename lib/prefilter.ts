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
const HAZARD_LEXICON: Record<HazardType, RegExp> = {
  // No leading \b on the stems. Hashtags compound the hazard word into a longer token —
  // #yycflood, #abflood, #yycfloods — and \bflood cannot match inside "yycflood" because
  // there is no boundary between "yyc" and "flood". That one detail loses the 3,192 most
  // obviously relevant rows in the provided dataset.
  flood:
    /(?:flood|inundat|submerg|overflow|sandbag|levee|dike|dyke|washout|highwater)\w*|under\s?water|washed\s?out|water\s+(?:level|rise|rising|everywhere)|river\s+(?:rise|rising|crest)/i,
  fire: /(?:wildfire|firefight|smoke|blaze|ember|scorch)\w*|fire\s+(?:ban|season|crew|evacuation)/i,
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
  const places: string[] = [];
  if (opts.knownPlaces?.length) {
    const hits = new Map<string, number>();
    for (const name of opts.knownPlaces) {
      const needle = name.toLowerCase();
      let n = 0;
      for (const t of sample) if (t.toLowerCase().includes(needle)) n++;
      if (n > 0) hits.set(name, n);
    }
    places.push(
      ...[...hits.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name]) => name),
    );
  }

  return { hazard, places, terms, userEdited: false };
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

  const hazardRe = HAZARD_LEXICON[profile.hazard];
  if (profile.hazard !== "other" && hazardRe.test(text)) {
    score += 0.5;
    reasons.push(`mentions ${profile.hazard}`);
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
