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

/**
 * Built per-corpus so relevance is judged against the detected event, not a hardcoded flood.
 * This is what makes an unseen earthquake dataset work with no code change.
 */
export function buildQuestions(profile: EventProfile): Record<string, Question> {
  const where = profile.places.slice(0, 4).join(", ") || "the affected area";
  const event = `${profile.hazard} emergency in ${where}`;

  return {
    relevant: {
      type: "noul",
      instructions: `Is this post about the ongoing ${event}?`,
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
