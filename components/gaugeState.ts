import type { FloodRecord } from "../lib/types";

export type GaugeState = "measured" | "below" | "no-reading" | "pending" | "checked" | "rejected";

export interface GaugeInput {
  decision?: { value: unknown; confidence: number };
  gate: number;
  classifier?: FloodRecord["classifier"];
  review?: FloodRecord["review"];
  /** Full answer sentence, e.g. "Sure it's about the flood" or "Sure of category: Route blocked". */
  answer: string;
}

export interface GaugeView {
  state: GaugeState;
  /** 0..1 fill height. */
  level: number;
  /** "0.88", or "" when there is no reading. */
  number: string;
  label: string;
  ariaText: string;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function resolveGauge(i: GaugeInput): GaugeView {
  if (i.review === "rejected") {
    return { state: "rejected", level: 0, number: "", label: "Rejected by a person", ariaText: "Rejected by a person" };
  }
  if (!i.decision) {
    return { state: "pending", level: 0, number: "", label: "Waiting for a result", ariaText: "Waiting for a result" };
  }
  if (i.classifier === "heuristic") {
    return {
      state: "no-reading", level: 0, number: "",
      label: "Keyword match, not measured",
      ariaText: "Keyword match by local rules, not measured by the model",
    };
  }
  const c = clamp(i.decision.confidence);
  const number = c.toFixed(2);
  if (i.review === "confirmed") {
    return { state: "checked", level: c, number, label: "Checked by a person", ariaText: `${i.answer}: ${number}. Checked by a person.` };
  }
  const below = c < i.gate;
  return {
    state: below ? "below" : "measured",
    level: c,
    number,
    label: below ? "Needs checking" : i.answer,
    ariaText: `${i.answer}: ${number}, ${below ? "below" : "above"} the review line.`,
  };
}

/** "Sure it's about the flood" / "Sure it's not about the flood", using the detected hazard. */
export function relevanceAnswer(r: FloodRecord, hazardNoun = "the flood"): string {
  return r.labels.relevant?.value === false ? `Sure it's not about ${hazardNoun}` : `Sure it's about ${hazardNoun}`;
}
