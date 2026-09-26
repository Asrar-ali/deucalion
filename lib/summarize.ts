/**
 * Extractive clustering (always available, no network) plus an optional Gemini
 * narrative layered on top (cited, or dropped).
 *
 * The extractive layer is the product's spine: deterministic, instant, and structurally
 * incapable of fabricating because every number it prints is a real count over real
 * records. The narrative layer is a convenience that may vanish at any time -- no key,
 * quota, network, safety block, malformed output -- and the caller must still be able to
 * render the extractive brief when it does. See docs/ARCHITECTURE.md 4.8.
 */

import { generateJson, generateText } from "./llm";
import { tokenize } from "./prefilter";
import type { Brief, Category, Cluster, FloodRecord } from "./types";

// ---------------------------------------------------------------------------
// Part 1 -- extractive clustering
// ---------------------------------------------------------------------------

/** Human labels for each category. Enriched below with distinctive terms per cluster. */
const CATEGORY_LABELS: Record<Category, string> = {
  access_blocked: "roads and bridges blocked",
  evacuation: "evacuation and shelter",
  rescue_request: "requests for help",
  damage: "property and infrastructure damage",
  aid: "donations and volunteers",
  advisory: "official advisories",
  sentiment: "solidarity and commentary",
};

function countTokens(records: FloodRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    // Display text only -- never rawText. Local computation never leaves the server
    // anyway, but this keeps one rule ("never touch rawText") rather than two.
    for (const tok of tokenize(r.text)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return counts;
}

function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/**
 * Terms that separate this cluster from the rest of the relevant set, not terms that are
 * merely frequent. "flood", "calgary" and "yycflood" appear in nearly every relevant
 * record in this corpus, so raw frequency ranks them top of every cluster and tells the
 * reader nothing. This is a smoothed log-odds ratio: log(in-cluster rate / rest-of-corpus
 * rate), add-0.5 smoothing so a term absent from one side never divides by zero. A term
 * must also occur at least twice in the cluster -- a single mention is not "distinctive",
 * it is noise that happened to be rare.
 */
/**
 * Filters terms that are technically distinctive but useless or actively misleading.
 *
 * Three real cases seen in the fixture output:
 *  - "000" scored highly, a fragment of "30,000" left behind by tokenization. A number
 *    stripped of its magnitude is noise.
 *  - "redacted" scored highly in the rescue-request cluster, because OUR OWN redaction
 *    inserts "[name redacted]". Labelling a cluster after our privacy machinery is a
 *    self-inflicted artifact, and it would read on screen as though the posts said it.
 *  - Single letters survive tokenization from hashtag splitting.
 */
function isUsefulTerm(term: string): boolean {
  if (term.length < 3) return false;
  if (/^\d+$/.test(term)) return false;
  return !REDACTION_ARTIFACTS.has(term);
}

const REDACTION_ARTIFACTS = new Set(["redacted", "redact", "phone", "email", "address"]);

function distinctiveTerms(cluster: FloodRecord[], allRelevant: FloodRecord[], topN: number): string[] {
  const inCounts = countTokens(cluster);
  const allCounts = countTokens(allRelevant);
  const inTotal = sumCounts(inCounts);
  const allTotal = sumCounts(allCounts);

  const scored: Array<[string, number]> = [];
  for (const [term, inCount] of inCounts) {
    if (inCount < 2) continue;
    if (!isUsefulTerm(term)) continue;
    const allCount = allCounts.get(term) ?? inCount;
    const outCount = Math.max(0, allCount - inCount);
    const outTotal = Math.max(1, allTotal - inTotal);
    const inRate = (inCount + 0.5) / (inTotal + 0.5);
    const outRate = (outCount + 0.5) / (outTotal + 0.5);
    scored.push([term, Math.log(inRate / outRate)]);
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topN).map(([term]) => term);
}

/**
 * Ranks candidates for "representativeIds". No single signal is trustworthy alone
 * (confidence ships over-confident per docs/ARCHITECTURE.md 4.4; severity is the weakest
 * primitive; a resolved place does not imply the post is typical). The rule combines four
 * independent, cheap-to-defend signals so no one of them can dominate:
 *   - category confidence          (0..1, the classifier's own certainty about this cluster)
 *   - severity, scaled down        (0..2 -> 0..0.3, coarse by design, so capped low)
 *   - a place resolved             (+0.2 flat -- mappable posts are more useful to show)
 *   - firsthand                    (+0.15 flat -- the sponsor's core thesis is firsthand reports)
 * Never hardcoded: the ranking runs over whatever records land in the cluster.
 */
function representativeScore(record: FloodRecord): number {
  const categoryConfidence = record.labels.category?.confidence ?? 0;
  const severity = record.labels.severity?.value ?? 0;
  const hasPlace = record.places.length > 0;
  const firsthand = record.labels.firsthand?.value === true;
  return categoryConfidence + severity * 0.15 + (hasPlace ? 0.2 : 0) + (firsthand ? 0.15 : 0);
}

function pickRepresentatives(cluster: FloodRecord[]): string[] {
  const wanted = cluster.length >= 3 ? 3 : Math.min(2, cluster.length);
  return [...cluster]
    .sort((a, b) => representativeScore(b) - representativeScore(a))
    .slice(0, wanted)
    .map((r) => r.id);
}

function topPlaces(cluster: FloodRecord[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of cluster) for (const p of r.places) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Groups relevant records by category. Empty groups are dropped entirely -- a cluster
 * with no members is worse than no cluster, and this bug already shipped once in this
 * repo (see the comment trail in prefilter.ts and make-fixtures.mjs about the same class
 * of "silently empties a category" failure).
 */
export function clusterRecords(records: FloodRecord[]): Cluster[] {
  const relevant = records.filter((r) => r.labels.relevant?.value === true);

  const byCategory = new Map<Category, FloodRecord[]>();
  for (const r of relevant) {
    const cat = r.labels.category?.value;
    if (!cat) continue; // no category means no cluster to place it in, not a cluster of its own
    const group = byCategory.get(cat);
    if (group) group.push(r);
    else byCategory.set(cat, [r]);
  }

  // Largest first, then alphabetical by category, so cluster ids are stable across calls
  // for the SAME input -- the route recomputes clusters fresh on every request (stateless),
  // so a client referencing an id from a previous response must get the same id back.
  const ordered = [...byCategory.entries()]
    .filter(([, members]) => members.length > 0)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  return ordered.map(([category, members], i) => {
    // Label stays clean prose; the distinctive terms travel alongside it as data. Folding
    // them into the label produced sentences like "solidarity and commentary (canmore, love,
    // sending) (10)" in the brief, which is unreadable. The UI can show terms as chips.
    const terms = distinctiveTerms(members, relevant, 5).slice(0, 3);
    return {
      id: `c_${i + 1}`,
      label: CATEGORY_LABELS[category] ?? category,
      terms,
      recordIds: members.map((r) => r.id),
      size: members.length,
      representativeIds: pickRepresentatives(members),
      topPlaces: topPlaces(members),
    };
  });
}

function communityCounts(records: FloodRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const p of r.places) {
      if (p.community) counts.set(p.community.name, (counts.get(p.community.name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Deterministic prose from real counts only. Every number here is computed from the
 * `records` argument at call time -- nothing is cached, rounded for effect, or invented.
 * `scopeLabel` only changes the opening clause (e.g. "In Siksika Nation, ..."); it never
 * changes which records are counted.
 */
export function buildExtractiveBrief(
  records: FloodRecord[],
  clusters: Cluster[],
  scopeLabel?: string,
): string {
  const total = records.length;
  const relevant = records.filter((r) => r.labels.relevant?.value === true);
  const relevantCount = relevant.length;

  if (total === 0) {
    return scopeLabel ? `No records were found for ${scopeLabel}.` : "No records were provided.";
  }

  const mappable = relevant.filter((r) => r.places.length > 0).length;
  const noPlace = relevantCount - mappable;

  const prefix = scopeLabel ? `In ${scopeLabel}: ` : "";
  const parts: string[] = [
    `${prefix}${relevantCount} of ${total} records were classified relevant.`,
  ];

  if (clusters.length) {
    const themes = clusters
      .slice() // clusters already arrive sorted largest-first from clusterRecords
      .map((c) => `${c.label} (${c.size})`)
      .join(", ");
    parts.push(`The largest themes are ${themes}.`);
  }

  parts.push(
    relevantCount > 0
      ? `${mappable} of ${relevantCount} relevant records resolved to a mappable place; ${noPlace} mention no place at all.`
      : `0 records resolved to a mappable place.`,
  );

  const communities = [...communityCounts(relevant).entries()].sort((a, b) => b[1] - a[1]);
  if (communities.length) {
    const named = communities.map(([name, count]) => `${name} (${count})`).join(", ");
    parts.push(`First Nations communities named: ${named}.`);
  }

  return parts.join(" ");
}

function isInCommunity(record: FloodRecord, communityName: string): boolean {
  const needle = communityName.trim().toLowerCase();
  return record.places.some(
    (p) => p.community?.name.toLowerCase() === needle || p.community?.id === communityName,
  );
}

/**
 * Same treatment as buildExtractiveBrief, scoped to one named community. This is the
 * direct answer to "what is happening in Siksika Nation" -- the highest-value question
 * this tool answers for the sponsor (CE Strategies, 90+ First Nation partnerships).
 */
export function communityBrief(records: FloodRecord[], communityName: string): string {
  const scoped = records.filter((r) => isInCommunity(r, communityName));
  const clusters = clusterRecords(scoped);
  return buildExtractiveBrief(scoped, clusters, communityName);
}

// ---------------------------------------------------------------------------
// Part 2 -- Gemini narrative, with citation enforcement done in code
// ---------------------------------------------------------------------------

/** The element type of Brief["narrative"], named for readability below. */
type NarrativeSentence = NonNullable<Brief["narrative"]>[number];

/** Model-facing view of a record. No rawText, ever. No PII records, ever. */
interface NarrativeInputRecord {
  id: string;
  text: string;
  category?: string;
  places: string[];
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      sentence: { type: "string" },
      citedRecordIds: { type: "array", items: { type: "string" } },
    },
    required: ["sentence", "citedRecordIds"],
  },
};

/** Kill phrases from docs/ARCHITECTURE.md section 8 -- enforced here, not just prompted. */
const KILL_TERMS = /\b(verified|confirmed)\b/i;
// "We have posts, not people." Catches both "200,000 people affected" and the bare
// "X people were affected" phrasing named explicitly in section 8.
const PEOPLE_CLAIM = /\b\d[\d,]*\s*(?:people|residents|persons|individuals|families)\b|\bpeople\b[^.]{0,40}\b(?:affected|impacted|displaced)\b|\b(?:affected|impacted|displaced)\b[^.]{0,40}\bpeople\b/i;

function killPhraseReason(sentence: string): string | undefined {
  if (KILL_TERMS.test(sentence)) return "kill phrase (verified/confirmed)";
  if (PEOPLE_CLAIM.test(sentence)) return "claims a number of people affected";
  return undefined;
}

function buildNarrativeInputs(clusters: Cluster[], records: FloodRecord[]): NarrativeInputRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const repIds = new Set(clusters.flatMap((c) => c.representativeIds));
  const inputs: NarrativeInputRecord[] = [];
  for (const id of repIds) {
    const r = byId.get(id);
    if (!r) continue;
    // Mandatory filter: PII records never reach the model, in any field.
    if (r.labels.has_pii?.value === true) continue;
    inputs.push({
      id: r.id,
      text: r.text,
      category: r.labels.category?.value,
      places: r.places.map((p) => p.name),
    });
  }
  return inputs;
}

function isRawSentenceArray(value: unknown): value is Array<{ sentence: unknown; citedRecordIds: unknown }> {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        "sentence" in v &&
        "citedRecordIds" in v,
    )
  );
}

/**
 * Parses and enforces the model output. This is the anti-fabrication guarantee: a prompt
 * instruction is not a guarantee, so every sentence is re-checked against the actual set
 * of ids we sent, independent of what the model claims. Returns the kept sentences and a
 * breakdown of why anything was dropped, for logging.
 */
// Exported so the test suite can prove enforcement drops a fabricated citation without
// needing a live Gemini call to manufacture one -- the anti-fabrication guarantee has to
// hold for input we did not generate ourselves, so it must be testable directly.
export function enforceCitations(
  raw: unknown,
  allowedIds: Set<string>,
): { kept: NarrativeSentence[]; dropped: Array<{ sentence: string; reason: string }> } {
  const kept: NarrativeSentence[] = [];
  const dropped: Array<{ sentence: string; reason: string }> = [];

  if (!isRawSentenceArray(raw)) return { kept, dropped };

  for (const item of raw) {
    const sentence = typeof item.sentence === "string" ? item.sentence.trim() : "";
    const citedRaw = Array.isArray(item.citedRecordIds) ? item.citedRecordIds : [];
    const cited = citedRaw.filter((id): id is string => typeof id === "string");

    if (!sentence) {
      dropped.push({ sentence: "", reason: "empty sentence" });
      continue;
    }
    if (cited.length === 0) {
      dropped.push({ sentence, reason: "no citations" });
      continue;
    }
    const unknownId = cited.find((id) => !allowedIds.has(id));
    if (unknownId) {
      dropped.push({ sentence, reason: `cites unknown id ${unknownId}` });
      continue;
    }
    const reason = killPhraseReason(sentence);
    if (reason) {
      dropped.push({ sentence, reason });
      continue;
    }
    kept.push({ sentence, citedRecordIds: cited });
  }

  return { kept, dropped };
}

/**
 * Gemini narrative layered on the extractive clusters. Every sentence must cite the
 * record ids it came from; sentences that don't are dropped, not softened, per
 * docs/CONTRACT.md. Returns undefined on ANY failure -- no key, quota, network, safety
 * block, malformed JSON -- so the caller always has the extractive brief to fall back to.
 */
export async function narrate(
  clusters: Cluster[],
  records: FloodRecord[],
): Promise<Brief["narrative"]> {
  if (clusters.length === 0) return [];

  const inputRecords = buildNarrativeInputs(clusters, records);
  const allowedIds = new Set(inputRecords.map((r) => r.id));

  const clusterSummary = clusters.map((c) => ({
    id: c.id,
    label: c.label,
    size: c.size,
    topPlaces: c.topPlaces,
    representativeIds: c.representativeIds.filter((id) => allowedIds.has(id)),
  }));

  const prompt = JSON.stringify({ clusters: clusterSummary, records: inputRecords });

  const systemInstruction =
    "You summarize flood-report clusters for emergency responders. Write short, factual " +
    "sentences. Every sentence MUST include citedRecordIds drawn ONLY from the record ids " +
    "given in the input -- never invent an id. Drop nothing to enforcement yourself, just " +
    "cite honestly. Never use the words 'verified' or 'confirmed' -- these are unverified " +
    "public posts, not official records. Never state a number of people affected, injured, " +
    "or displaced -- we have posts, not a census. Never claim real-time accuracy. Output " +
    "only sentences you can support with the given record ids.";

  try {
    // Build the full prompt with system instruction
    const fullPrompt =
      systemInstruction + "\n\n" + prompt;

    const parsed = await generateJson<unknown>(
      fullPrompt,
      RESPONSE_SCHEMA,
    );

    if (!parsed) return undefined; // safety block, network error, or empty candidate

    const { kept, dropped } = enforceCitations(parsed, allowedIds);
    if (dropped.length) {
      // Visibility into enforcement is required by design -- a silent drop is exactly the
      // failure mode the anti-fabrication rule exists to prevent us from hiding.
      console.warn(
        `narrate: dropped ${dropped.length} sentence(s): ${dropped.map((d) => d.reason).join("; ")}`,
      );
    }
    return kept;
  } catch (err) {
    console.warn("narrate: Gemini call failed, falling back to extractive only:", err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Part 2b -- plain-language rewrite for the accessibility toggle
// ---------------------------------------------------------------------------

/** Every distinct number substring in the text, so a rewrite cannot silently alter one. */
function extractNumbers(text: string): string[] {
  return text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
}

/**
 * Rewrites the extractive brief at roughly grade 6 for the accessibility toggle. Same
 * graceful-failure contract as narrate: undefined on any failure. Numbers are checked
 * post-hoc -- if the rewrite drops or changes a figure, we refuse it rather than show a
 * plain-language summary that quietly disagrees with the real numbers.
 */
export async function plainLanguage(brief: string): Promise<string | undefined> {
  if (!brief.trim()) return undefined;

  const systemInstruction =
    "Rewrite the given text at approximately a grade 6 reading level. Keep every number " +
    "exactly as written -- do not round, estimate, or drop any figure. Do not add claims " +
    "that are not already in the text. Plain text only, no markdown, no headers.";

  try {
    // Build the full prompt with system instruction
    const fullPrompt =
      systemInstruction + "\n\n" + brief;

    const text = await generateText(fullPrompt);
    if (!text) return undefined;

    const required = extractNumbers(brief);
    const missing = required.some((n) => !text.includes(n));
    if (missing) {
      console.warn("plainLanguage: rewrite dropped or altered a number, discarding rewrite");
      return undefined;
    }
    return text;
  } catch (err) {
    console.warn("plainLanguage: Gemini call failed:", err);
    return undefined;
  }
}
