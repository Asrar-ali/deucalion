/**
 * Offline demo replay.
 *
 * If the venue network or the model provider goes down mid-judging, this is the fallback: real
 * fixture data (produced once by scripts/make-fixtures.mjs from the actual provided dataset),
 * bundled at build time so nothing here ever calls fetch. Deucalion only has to add a branch
 * that calls replayDemo instead of runClassify, not learn a second pipeline.
 *
 * The replay is paced on purpose. Snapping straight to the final funnel would look like a
 * static screenshot, and the whole point of a demo mode is that a judge can tell it is a
 * deliberate fallback, not a hidden shortcut.
 */

import demoRecordsJson from "../fixtures/records.json";
import demoFunnelJson from "../fixtures/funnel.json";
import demoClustersJson from "../fixtures/clusters.json";
import demoBriefJson from "../fixtures/brief.json";
import demoProfileJson from "../fixtures/profile.json";
import type { Brief, Cluster, EventProfile, FloodRecord, FunnelCounts } from "./types";

// JSON modules type their string fields as `string`, not as the literal unions FloodRecord
// expects, so the cast goes through `unknown` rather than pretending TS can check the shape.
const DEMO_RECORDS = demoRecordsJson as unknown as FloodRecord[];
const DEMO_FUNNEL = demoFunnelJson as unknown as FunnelCounts;
const DEMO_CLUSTERS = demoClustersJson as unknown as Cluster[];
const DEMO_BRIEF = demoBriefJson as unknown as Brief;
const DEMO_PROFILE = demoProfileJson as unknown as EventProfile;

/** Total wall-clock time of the replay. Long enough to read as real, short enough to not stall a demo. */
const REPLAY_MS = 3000;
/** Number of batches the records are split into. Also how many funnel updates the strip gets. */
const STEPS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True only when the caller passes a `?demo=1` query string. Takes the string rather than
 * reading `window` itself so this file has no browser dependency and the caller decides when
 * it is safe to read `location.search` (after mount, to avoid a server/client render mismatch).
 */
export function isDemoMode(search: string): boolean {
  return new URLSearchParams(search).get("demo") === "1";
}

export function demoEventProfile(): EventProfile {
  return DEMO_PROFILE;
}

export interface DemoCallbacks {
  onRecordBatch: (records: FloodRecord[]) => void;
  onProgress: (done: number, total: number, stage: string) => void;
  onFunnel: (funnel: FunnelCounts) => void;
  onDone: (funnel: FunnelCounts, clusters: Cluster[], brief: Brief) => void;
}

/**
 * The three stages that stream in real classification (prefilter, relevant, mappable) are
 * scaled by how much of the fixture set has "arrived" so far. Raw and deduped are shown at
 * full value throughout, matching the real flow where ingest reports those two immediately
 * and only the later stages trickle in.
 */
function scaledFunnel(final: FunnelCounts, fraction: number): FunnelCounts {
  const scale = (n: number) => Math.round(n * fraction);
  return {
    ...final,
    prefiltered: scale(final.prefiltered),
    relevant: scale(final.relevant),
    mappable: scale(final.mappable),
    noPlaceMentioned: scale(final.noPlaceMentioned),
    rejectedRows: fraction >= 1 ? final.rejectedRows : [],
  };
}

/**
 * Replays the bundled fixtures as if they were streaming off the wire: records arrive in
 * batches, the funnel counts up, then settles on the exact recorded numbers. Never touches
 * the network, so it keeps working with the wifi off.
 */
export async function replayDemo(callbacks: DemoCallbacks): Promise<void> {
  const total = DEMO_RECORDS.length;
  const perBatch = Math.max(1, Math.ceil(total / STEPS));
  const stepMs = REPLAY_MS / STEPS;

  callbacks.onFunnel(scaledFunnel(DEMO_FUNNEL, 0));
  callbacks.onProgress(0, total, "prefilter");

  for (let i = 0; i < total; i += perBatch) {
    await sleep(stepMs);
    const batch = DEMO_RECORDS.slice(i, i + perBatch);
    const done = Math.min(i + perBatch, total);
    callbacks.onRecordBatch(batch);
    callbacks.onProgress(done, total, "classify");
    callbacks.onFunnel(scaledFunnel(DEMO_FUNNEL, done / total));
  }

  callbacks.onFunnel(DEMO_FUNNEL);
  callbacks.onDone(DEMO_FUNNEL, DEMO_CLUSTERS, DEMO_BRIEF);
}
