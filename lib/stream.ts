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
  // A dropped connection makes fetch or the stream reader throw. Without this catch the
  // rejection escaped to the caller, no notice appeared and the run failed silently.
  try {
    await classifyStream(payload, callbacks, signal);
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return;
    callbacks.onError?.(
      "Lost the connection while classifying. Posts already classified are kept; load the file again to finish the rest.",
    );
  }
}

async function classifyStream(
  payload: { records: FloodRecord[]; profile: unknown; byoKey?: string; accessCode?: string },
  callbacks: ClassifyCallbacks & { onRecordBatch?: (records: FloodRecord[]) => void },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

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
