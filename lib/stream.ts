/**
 * Reads the classify route's Server-Sent Events.
 *
 * Deliberately framework-agnostic and dependency-free: the same reader is used by the browser
 * and by the Node test scripts, so a bug here shows up in tests rather than only on stage.
 *
 * Not using the browser EventSource API, for two reasons: EventSource cannot issue a POST
 * (we send the records in the body), and it reconnects automatically, which for a paid,
 * non-idempotent classification run would silently double the bill.
 */

import type { FloodRecord, FunnelCounts, SpendState } from "./types";

export type ClassifyEvent =
  | { type: "progress"; done: number; total: number; stage: "prefilter" | "classify" | "geoparse" }
  | { type: "record"; record: FloodRecord }
  | { type: "funnel"; funnel: FunnelCounts }
  | { type: "spend"; spend: SpendState }
  | { type: "degraded"; reason: string; message: string }
  | { type: "done"; funnel: FunnelCounts; spend: SpendState; modelVersion?: string }
  | { type: "error"; message: string };

/**
 * Yields events as they arrive. A partial frame left in the buffer between reads is normal:
 * TCP does not respect message boundaries, so a `data:` line can and will be split across
 * two chunks. Parsing per-chunk instead of per-frame is the classic bug here.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ClassifyEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      // The last element is either empty or an incomplete frame; keep it for the next read.
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.replace(/^data: ?/m, "").trim();
        if (!line) continue;
        try {
          yield JSON.parse(line) as ClassifyEvent;
        } catch {
          // A malformed frame is not worth killing a long run over. Skip it and continue;
          // the funnel and done events will still reconcile the totals.
        }
      }
    }
  } finally {
    // Releasing the lock matters when the caller aborts: without it the connection can be
    // held open and the server keeps classifying rows nobody will read.
    reader.releaseLock();
  }
}

export interface ClassifyCallbacks {
  onRecord?: (record: FloodRecord) => void;
  onProgress?: (done: number, total: number, stage: string) => void;
  onFunnel?: (funnel: FunnelCounts) => void;
  onSpend?: (spend: SpendState) => void;
  onDegraded?: (reason: string, message: string) => void;
  onError?: (message: string) => void;
  onDone?: (funnel: FunnelCounts, spend: SpendState, modelVersion?: string) => void;
}

/**
 * Batches `record` events before handing them up.
 *
 * Without this, 4,000 records means 4,000 React state updates and the tab locks up under its
 * own re-renders. Flushing on a size threshold or a short interval keeps the funnel visibly
 * moving while staying responsive.
 */
export async function runClassify(
  payload: { records: FloodRecord[]; profile: unknown; byoKey?: string; accessCode?: string },
  callbacks: ClassifyCallbacks & { onRecordBatch?: (records: FloodRecord[]) => void },
  signal?: AbortSignal,
): Promise<void> {
  // Vercel caps a request body at ~4.5 MB, so a large upload (the 61k-row bonus file is
  // ~15 MB as JSON) is classified in batches. Funnel counts are summed across batches and
  // onDone fires once, at the end, so callers see a single run.
  const all = payload.records;
  const batches: FloodRecord[][] = [];
  for (let i = 0; i < all.length; i += CLASSIFY_BATCH) batches.push(all.slice(i, i + CLASSIFY_BATCH));
  if (batches.length === 0) batches.push([]);

  // Batches run a few at a time. Each request classifies with its own server-side worker pool,
  // so the upstream model (measured ~370 calls/s at 100 in flight) is the limit, not this loop.
  // Each batch keeps its own latest funnel; the combined funnel is their sum, so batches that
  // finish out of order still reconcile.
  const perBatch = new Map<number, FunnelCounts>();
  const combine = (): FunnelCounts => {
    const t = { prefiltered: 0, relevant: 0, mappable: 0, noPlaceMentioned: 0 };
    const rejectedRows: FunnelCounts["rejectedRows"] = [];
    for (const f of perBatch.values()) {
      t.prefiltered += f.prefiltered;
      t.relevant += f.relevant;
      t.mappable += f.mappable;
      t.noPlaceMentioned += f.noPlaceMentioned;
      rejectedRows.push(...f.rejectedRows);
    }
    return { raw: all.length, deduped: all.length, ...t, rejectedRows: rejectedRows.slice(0, 200) };
  };

  // Each request reports the cookie's prior spend plus its own. Parallel requests all start from
  // the same prior figure, so the true total is that base plus every request's own spend.
  const spentBy = new Map<number, number>();
  let baseUsed: number | undefined;
  let anyDegraded = false;
  const mergeSpend = (index: number, s: SpendState): SpendState => {
    anyDegraded = anyDegraded || s.degraded;
    if (s.spent === undefined) return { ...s, degraded: anyDegraded };
    baseUsed ??= Math.max(0, s.used - s.spent);
    spentBy.set(index, s.spent);
    let total = baseUsed;
    for (const v of spentBy.values()) total += v;
    return { ...s, used: total, degraded: anyDegraded };
  };

  let received = 0;
  let lastSpend: SpendState | undefined;
  let modelVersion: string | undefined;
  let failed = false;
  let lost = false;
  let next = 0;

  const runOne = async (index: number, batch: FloodRecord[], onHeaders: () => void) => {
    const countRecords = (n: number) => {
      received += n;
      if (batches.length > 1) callbacks.onProgress?.(received, all.length, "classify");
    };
    try {
      await classifyStream({ ...payload, records: batch }, {
        ...callbacks,
        onRecordBatch: (records) => {
          countRecords(records.length);
          if (callbacks.onRecordBatch) callbacks.onRecordBatch(records);
          else for (const r of records) callbacks.onRecord?.(r);
        },
        onRecord: undefined,
        onProgress: batches.length > 1 ? undefined : callbacks.onProgress,
        onFunnel: (f) => {
          perBatch.set(index, f);
          callbacks.onFunnel?.(combine());
        },
        onSpend: (s) => {
          lastSpend = mergeSpend(index, s);
          callbacks.onSpend?.(lastSpend);
        },
        onError: (message) => {
          failed = true;
          callbacks.onError?.(message);
        },
        onDone: (f, s, v) => {
          perBatch.set(index, f);
          lastSpend = mergeSpend(index, s);
          modelVersion = v ?? modelVersion;
        },
        onHeaders,
      }, signal);
    } catch (err) {
      // A dropped connection makes fetch or the stream reader throw. Without this catch the
      // rejection escaped to the caller, no notice appeared and the run failed silently.
      if ((err as { name?: string })?.name === "AbortError") { failed = true; return; }
      if (!lost) {
        lost = true;
        callbacks.onError?.(
          "Lost the connection while classifying. Posts already classified are kept; load the file again to finish the rest.",
        );
      }
      failed = true;
    } finally {
      onHeaders();
    }
  };

  // The first request goes alone until its headers arrive: the spend cookie is set on those
  // headers, and later requests must read it or a parallel run could overshoot the budget.
  const lane = async (waitFor?: Promise<void>) => {
    if (waitFor) await waitFor;
    for (;;) {
      // A budget block or server error on one batch will repeat on the next; stop and report once.
      if (failed || signal?.aborted) return;
      const index = next++;
      if (index >= batches.length) return;
      await runOne(index, batches[index], index === 0 ? firstHeaders.resolve : () => {});
    }
  };
  const firstHeaders = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  })();

  const lanes = Math.min(PARALLEL_BATCHES, batches.length);
  await Promise.all([
    lane(),
    ...Array.from({ length: lanes - 1 }, () => lane(firstHeaders.promise)),
  ]);
  firstHeaders.resolve();

  if (failed) return;
  if (signal?.aborted) return;
  if (lastSpend) callbacks.onDone?.(combine(), lastSpend, modelVersion);
}

/** Records per classify request. ~2,500 records is ~1 MB of JSON, well under Vercel's cap. */
const CLASSIFY_BATCH = 2500;
/** Requests in flight at once. Each has its own worker pool server-side. */
const PARALLEL_BATCHES = 3;

async function classifyStream(
  payload: { records: FloodRecord[]; profile: unknown; byoKey?: string; accessCode?: string },
  callbacks: ClassifyCallbacks & { onRecordBatch?: (records: FloodRecord[]) => void; onHeaders?: () => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  callbacks.onHeaders?.();
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    callbacks.onError?.(
      `Classification failed (${res.status}). ${detail.slice(0, 200)}`,
    );
    return;
  }

  const BATCH_SIZE = 40;
  const BATCH_MS = 120;
  let batch: FloodRecord[] = [];
  let lastFlush = Date.now();

  const flush = () => {
    if (!batch.length) return;
    if (callbacks.onRecordBatch) callbacks.onRecordBatch(batch);
    else for (const r of batch) callbacks.onRecord?.(r);
    batch = [];
    lastFlush = Date.now();
  };

  for await (const event of readEventStream(res.body, signal)) {
    switch (event.type) {
      case "record":
        batch.push(event.record);
        if (batch.length >= BATCH_SIZE || Date.now() - lastFlush > BATCH_MS) flush();
        break;
      case "progress":
        callbacks.onProgress?.(event.done, event.total, event.stage);
        break;
      case "funnel":
        flush(); // funnel counts must not arrive before the rows they describe
        callbacks.onFunnel?.(event.funnel);
        break;
      case "spend":
        callbacks.onSpend?.(event.spend);
        break;
      case "degraded":
        callbacks.onDegraded?.(event.reason, event.message);
        break;
      case "error":
        flush();
        callbacks.onError?.(event.message);
        break;
      case "done":
        flush();
        callbacks.onDone?.(event.funnel, event.spend, event.modelVersion);
        break;
    }
  }
  flush();
}
