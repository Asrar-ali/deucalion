/**
 * The 9 typed questions. Pure data — no HTTP, no flood-specific plumbing elsewhere.
 * This file IS the product. Changing behaviour means changing this.
 *
 * Wording rules, from this model family's documented failure modes:
 *  - choice criteria must NEVER use boolean-ish labels ("yes"/"no"/"true") — the model
 *    follows label text over descriptions.
 *  - keep choice sets under ~20 options.
 *  - never ask about dates or numbers. Documented weakness.
 *  - instructions and criteria repeat on EVERY call and dominate token spend.
 *    Terse wording is a direct 2-3x cost lever. Do not pad these strings.
 */

import type { EventProfile } from "./types";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export const SEVERITY_LEVELS = ["background", "notable", "urgent"] as const;

/** Reads naturally inside the question. "Is this post about flooding" beats "about flood". */
function hazardNoun(hazard: EventProfile["hazard"]): string {
  switch (hazard) {
    case "flood":
      return "flooding";
    case "fire":
      return "a wildfire";
    case "quake":
      return "an earthquake";
    case "storm":
      return "a severe storm";
    default:
      return "a disaster or emergency";
  }
}

/**
 * Relevance is the max of the two topic questions, not an average and not a single
 * overloaded question. A post qualifies if it is about the hazard OR about the response.
 * Measured separation on hand-labelled rows: 0.700, with nothing forced into review.
 */
export function deriveRelevance(hazardTopic: number, responseTopic: number) {
  const p = Math.max(hazardTopic, responseTopic);
  return {
    value: p >= 0.5,
    // Distance from the boundary, which for a calibrated noul is the usable confidence.
    confidence: Math.abs(p - 0.5) * 2,
    probability: p,
    // Which question carried it — shown in the UI as the reason.
    via: hazardTopic >= responseTopic ? ("hazard" as const) : ("response" as const),
  };
}

/**
 * Built per-corpus so relevance is judged against the detected event, not a hardcoded flood.
 * This is what makes an unseen earthquake dataset work with no code change.
 */
export function buildQuestions(profile: EventProfile): Record<string, Question> {
  return {
    // Relevance is split in two, then combined with max(). Measured on 18 hand-labelled
    // rows (scripts/tune-relevance2.mjs):
    //
    //   "about the ongoing flood in Calgary, High River"  separation 0.010, 4/15 uncertain
    //   hazard topic only                                 separation 0.360, 2/18 uncertain
    //   max(hazard, response)                             separation 0.700, 0/18 uncertain
    //
    // Naming the place in the question made it WORSE: a flood headline that does not
    // mention Calgary got hedged down to 0.57. Place belongs to the geoparser, not here.
    //
    // The split exists because posts like "mandatory evacuation order issued in Medicine
    // Hat" (hazard 0.49) and "Red Cross reception centre is open" (hazard 0.53) never say
    // the word flood, yet they are precisely what a responder needs. Both score >0.94 on
    // response. Asking one overloaded question loses them.
    hazard_topic: {
      type: "noul",
      instructions: `Is this post about ${hazardNoun(profile.hazard)}, or its effects and aftermath?`,
    },

    response_topic: {
      type: "noul",
      instructions:
        "Is this post about an emergency response: evacuation, rescue, shelter, road closure or relief effort?",
    },

    hazard: {
      type: "choice",
      instructions: "Which hazard does this post describe?",
      criteria: {
        flood: "flooding, high water, river overflow",
        fire: "wildfire, smoke, burning",
        quake: "earthquake, tremor, collapse",
        storm: "wind, tornado, hail, blizzard",
        other: "any other hazard, or none",
      },
    },

    category: {
      type: "choice",
      instructions: "What does this post report?",
      criteria: {
        access_blocked: "road, bridge, highway or route impassable or closed",
        evacuation: "people evacuating, displaced, sheltering, told to leave",
        rescue_request: "someone needs help or rescue now",
        damage: "property, home or infrastructure damaged",
        aid: "donations, volunteering, relief supplies, fundraising",
        advisory: "official warning, advice, instruction",
        sentiment: "opinion, thanks, solidarity, no operational detail",
      },
    },

    severity: {
      type: "score",
      instructions: "How urgent is this for a responder?",
      criteria: [...SEVERITY_LEVELS],
    },

    has_place: {
      type: "noul",
      instructions: "Does this post name a specific place, road, bridge or neighbourhood?",
    },

    is_request: {
      type: "noul",
      instructions: "Is this post asking for help, supplies or information?",
    },

    has_pii: {
      type: "noul",
      instructions:
        "Does this post reveal a private individual's identity, home address, phone number or medical detail?",
    },

    is_spam: {
      type: "noul",
      instructions:
        "Is this post commercial, a job ad, automated promotion, or unrelated fiction?",
    },

    firsthand: {
      type: "noul",
      instructions:
        "Is the author reporting what they personally saw, rather than resharing news?",
    },
  };
}

/** Confidence floors. Below these a record goes to the human review queue. */
export const CONFIDENCE_GATE = {
  relevant: 0.6,
  category: 0.5,
  hazard: 0.5,
  has_pii: 0.3, // deliberately low: err toward redaction
  is_spam: 0.7, // deliberately high: err toward keeping content
} as const;
