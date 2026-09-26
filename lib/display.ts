/**
 * Presentation metadata. Lives apart from the pipeline so the vocabulary shown to a user is
 * decided in one place and cannot drift between the map, the table and the exports.
 *
 * Two rules encoded here:
 *  - Every status carries an icon name AND a text label, never a colour alone. Roughly 8% of
 *    men cannot separate red from green, and a responder may be reading this outdoors in rain.
 *  - Confidence is rendered as a shape plus a number. A bare float means nothing to a reader,
 *    and this model family ships over-confident, so we never call it "accuracy".
 */

import type { Category, GeoMethod } from "./types";

export interface CategoryMeta {
  label: string;
  /** Phosphor icon name. Resolved by the component, kept as data here. */
  icon: string;
  /** CSS custom property supplying the colour half of the signal. */
  tone: "urgent" | "review" | "settled" | "inert" | "accent";
  /** One line explaining what belongs in this bucket, for tooltips and the legend. */
  hint: string;
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  rescue_request: {
    label: "Needs help",
    icon: "Lifebuoy",
    tone: "urgent",
    hint: "Someone is asking for help or rescue now.",
  },
  access_blocked: {
    label: "Route blocked",
    icon: "Barricade",
    tone: "urgent",
    hint: "A road, bridge or route is impassable or closed.",
  },
  evacuation: {
    label: "Evacuation",
    icon: "PersonSimpleWalk",
    tone: "review",
    hint: "People evacuating, displaced, sheltering, or told to leave.",
  },
  damage: {
    label: "Damage",
    icon: "HouseLine",
    tone: "review",
    hint: "Property, home or infrastructure damage reported.",
  },
  advisory: {
    label: "Advisory",
    icon: "Megaphone",
    tone: "accent",
    hint: "Official warning, advice or instruction.",
  },
  aid: {
    label: "Aid and relief",
    icon: "HandHeart",
    tone: "settled",
    hint: "Donations, volunteering, relief supplies, fundraising.",
  },
  sentiment: {
    label: "Comment",
    icon: "ChatCircle",
    tone: "inert",
    hint: "Opinion, thanks or solidarity, with no operational detail.",
  },
};

/** Ordered for triage: what a responder should read first, not alphabetical. */
export const CATEGORY_ORDER: Category[] = [
  "rescue_request",
  "access_blocked",
  "evacuation",
  "damage",
  "advisory",
  "aid",
  "sentiment",
];

export const SEVERITY_LABELS = ["Background", "Notable", "Urgent"] as const;

/** Severity arrives as a continuous 0..2 score, so it is banded for display only. */
export function severityBand(score: number | undefined): 0 | 1 | 2 {
  if (score == null) return 0;
  if (score >= 1.5) return 2;
  if (score >= 0.75) return 1;
  return 0;
}

export const GEO_METHOD_META: Record<GeoMethod, { label: string; hint: string }> = {
  exif: {
    label: "Exact",
    hint: "Coordinates read from the photo itself. The only exact source in this system.",
  },
  provided: {
    label: "Given",
    hint: "Coordinates supplied in the uploaded file. Trusted as provided, not verified.",
  },
  gazetteer: {
    label: "Inferred",
    hint: "A place name in the text was matched to a gazetteer entry. This is a guess with a confidence.",
  },
};

/**
 * Confidence is bucketed for the UI so the same number always reads the same way.
 * Wording is deliberately about what we will DO, not about how right we are.
 */
export function confidenceBand(c: number | undefined): {
  key: "firm" | "probable" | "uncertain";
  label: string;
  tone: "settled" | "review" | "inert";
} {
  if (c == null) return { key: "uncertain", label: "Not assessed", tone: "inert" };
  if (c >= 0.6) return { key: "firm", label: "Firm", tone: "settled" };
  if (c >= 0.3) return { key: "probable", label: "Probable", tone: "review" };
  return { key: "uncertain", label: "Needs a human", tone: "review" };
}

/** Percent with no decimals, and no percent sign in the aria label. */
export function pct(n: number | undefined): string {
  if (n == null) return "n/a";
  return `${Math.round(n * 100)}%`;
}

/** Thousands separators so 8024 does not read as 8 thousand at a glance. */
export function count(n: number): string {
  return n.toLocaleString("en-CA");
}

/**
 * Money at the precision that is actually meaningful. A whole corpus costs cents, so two
 * decimal places would render every real figure as $0.00 and look like a bug.
 */
export function usd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export const CLASSIFIER_META = {
  jev: { label: "Model", hint: "Classified by the decision model with a calibrated confidence." },
  laya: { label: "Model (self-hosted)", hint: "Classified by a self-hosted decision model." },
  heuristic: {
    label: "Local rules",
    hint: "Classified by local keyword rules, not the model. Either it was filtered out before the model ran, or the model was unavailable.",
  },
} as const;

/** Progress shape shared by the classify run and the funnel strip. `rate` is smoothed posts/s. */
export interface RunProgress {
  done: number;
  total: number;
  stage: string;
  rate?: number;
}

/**
 * Exponential moving average of throughput. Called on each progress callback with the posts
 * finished since the previous one; cheap and allocation-free apart from the returned state.
 */
export function nextRate(
  prev: { t: number; done: number; ema: number },
  now: number,
  done: number,
): { t: number; done: number; ema: number } {
  const dt = (now - prev.t) / 1000;
  // Ignore bursts closer than 50 ms: instantaneous rates from tiny windows are pure noise.
  if (dt < 0.05) return prev;
  const inst = Math.max(0, done - prev.done) / dt;
  const ema = prev.ema > 0 ? prev.ema * 0.7 + inst * 0.3 : inst;
  return { t: now, done, ema };
}

/** "1,240 posts/s", rounded so it does not flicker in the last digit. */
export function formatRate(perSecond: number): string {
  const r = perSecond >= 100 ? Math.round(perSecond / 10) * 10 : Math.round(perSecond);
  return `${count(r)} posts/s`;
}

/** "about 6 s left", "about 1 min 5 s left". Empty when there is nothing sensible to say. */
export function formatEta(remaining: number, perSecond: number): string {
  if (!(perSecond > 0) || remaining <= 0) return "";
  const s = Math.max(1, Math.round(remaining / perSecond));
  if (s < 60) return `about ${s} s left`;
  return `about ${Math.floor(s / 60)} min ${s % 60} s left`;
}

/** "Classified 8,024 posts in 6.4 s". */
export function formatClassified(n: number, ms: number): string {
  return `Classified ${count(n)} posts in ${(ms / 1000).toFixed(1)} s`;
}
