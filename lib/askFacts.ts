/**
 * Deterministic ground-truth facts for the Ask feature. The model is only ever given a
 * sample of posts, so any total, count or ranking it stated from that sample would be
 * wrong. These figures are computed in code over EVERY loaded post and handed to the model
 * as the only numbers it may quote.
 */

import gazetteerData from "../data/gazetteer.json";
import { tokenize } from "./prefilter";
import type { FloodRecord } from "./types";

interface GazEntry {
  name: string;
  aliases: string[];
}

const PLACES: GazEntry[] = (gazetteerData as { places: GazEntry[] }).places;

export interface TermCount {
  /** Display label, e.g. "Calgary, AB" or "Bragg Creek". */
  term: string;
  /** Posts (all loaded) whose text matches, case-insensitive, on word boundaries. */
  countAll: number;
  /** Same, restricted to posts classified relevant. */
  countRelevant: number;
}

export interface AskFacts {
  totalLoaded: number;
  totalRelevant: number;
  terms: TermCount[];
  /** Most mentioned gazetteer places over all loaded posts, from each record's places[]. */
  topPlaces: Array<{ name: string; count: number }>;
}

const MAX_TERMS = 4;
const TOP_PLACES = 8;

const NOT_TERMS = new Set([
  "how", "what", "which", "where", "when", "why", "who", "are", "is", "do", "does", "did",
  "the", "there", "many", "much", "most", "please", "tell", "show", "list", "give", "can",
  "i", "we", "flood", "floods", "flooding", "twitter", "rt",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, word-boundary matcher over any of the given phrases. */
function matcher(phrases: string[]): RegExp {
  const alt = phrases.map((p) => escapeRe(p.toLowerCase()).replace(/\s+/g, "\\s+")).join("|");
  return new RegExp(`(?:^|[^a-z0-9])(?:${alt})(?:[^a-z0-9]|$)`, "i");
}

/** Terms worth counting: gazetteer places named in the question, then capitalised or quoted words. */
export function extractTerms(question: string): Array<{ label: string; phrases: string[] }> {
  const out: Array<{ label: string; phrases: string[] }> = [];
  const seen = new Set<string>();
  const q = question.toLowerCase();

  for (const p of PLACES) {
    const hit = p.aliases.some((a) => a.length > 2 && matcher([a]).test(q));
    if (hit && !seen.has(p.name)) {
      seen.add(p.name);
      out.push({ label: p.name, phrases: p.aliases });
    }
  }
  const coveredWords = new Set(out.flatMap((o) => o.phrases.flatMap((a) => a.split(/\s+/))));

  const extra: string[] = [];
  for (const m of question.matchAll(/["“]([^"”]{2,40})["”]/g)) extra.push(m[1].trim());
  const words = question.replace(/[^A-Za-z0-9'\s-]/g, " ").split(/\s+/).filter(Boolean);
  words.forEach((w, i) => {
    if (i > 0 && /^[A-Z][a-z]{2,}/.test(w)) extra.push(w);
  });
  for (const e of extra) {
    const key = e.toLowerCase();
    if (seen.has(key) || NOT_TERMS.has(key) || coveredWords.has(key)) continue;
    seen.add(key);
    out.push({ label: e, phrases: [e] });
  }
  return out.slice(0, MAX_TERMS);
}

export function computeAskFacts(question: string, records: FloodRecord[]): AskFacts {
  const relevantFlag = (r: FloodRecord) => r.labels.relevant?.value === true;
  const terms: TermCount[] = extractTerms(question).map(({ label, phrases }) => {
    const re = matcher(phrases);
    let countAll = 0;
    let countRelevant = 0;
    for (const r of records) {
      if (re.test(r.text)) {
        countAll++;
        if (relevantFlag(r)) countRelevant++;
      }
    }
    return { term: label, countAll, countRelevant };
  });

  const byPlace = new Map<string, number>();
  for (const r of records) {
    for (const name of new Set(r.places.map((p) => p.name))) {
      byPlace.set(name, (byPlace.get(name) ?? 0) + 1);
    }
  }
  const topPlaces = [...byPlace.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_PLACES)
    .map(([name, count]) => ({ name, count }));

  return {
    totalLoaded: records.length,
    totalRelevant: records.filter(relevantFlag).length,
    terms,
    topPlaces,
  };
}

/** Relevant posts ranked by keyword and named-term overlap, then severity, then confidence. */
export function selectRecordsForQuestion(
  question: string,
  records: FloodRecord[],
  limit: number,
): FloodRecord[] {
  const keywords = new Set(tokenize(question).filter((w) => w.length > 3));
  const termRes = extractTerms(question).map((t) => matcher(t.phrases));
  const scored = records
    .filter((r) => r.labels.relevant?.value === true)
    .map((r) => {
      let overlap = 0;
      for (const t of tokenize(r.text)) if (keywords.has(t)) overlap++;
      for (const re of termRes) if (re.test(r.text)) overlap += 2;
      return {
        r,
        s: [overlap, r.labels.severity?.value ?? 0, r.labels.relevant?.confidence ?? 0],
      };
    });
  scored.sort((a, b) => b.s[0] - a.s[0] || b.s[1] - a.s[1] || b.s[2] - a.s[2]);
  return scored.slice(0, limit).map((x) => x.r);
}

/** Short, single-line excerpt used for chips and prompts. */
export function snippet(text: string, max: number): string {
  const t = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "...";
}

/** Facts as prompt text: the only figures the model may quote. */
export function factsToPrompt(f: AskFacts, sampleSize: number): string {
  const lines = [
    `Total posts loaded: ${f.totalLoaded}`,
    `Total classified relevant: ${f.totalRelevant}`,
    `Posts read below (a sample chosen for relevance to the question): ${sampleSize}`,
  ];
  for (const t of f.terms) {
    lines.push(
      `Posts mentioning "${t.term}" (exact count over all ${f.totalLoaded} posts): ${t.countAll}, of which ${t.countRelevant} relevant`,
    );
  }
  if (f.topPlaces.length) {
    lines.push(
      "Most mentioned places over all loaded posts: " +
        f.topPlaces.map((p, i) => `${i + 1}. ${p.name} (${p.count})`).join(", "),
    );
  }
  return lines.join("\n");
}

/** True for plain "how many posts mention X" questions that code can answer exactly, no model. */
export function isCountQuestion(question: string): boolean {
  return /^\s*how many\b.*\b(mention|mentions|mentioning|about|contain|contains|reference|references|talk|talking)\b/i.test(
    question,
  );
}

/** Up to n of the given records that match the question's first named term. */
export function firstMatching(question: string, records: FloodRecord[], n: number): FloodRecord[] {
  const t = extractTerms(question)[0];
  if (!t) return [];
  const re = matcher(t.phrases);
  return records.filter((r) => re.test(r.text)).slice(0, n);
}
