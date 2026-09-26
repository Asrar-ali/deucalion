/**
 * POST /api/classify — Server-Sent Events.
 *
 * Stateless by design: the client posts the records it holds and gets labelled records
 * streamed back. Nothing is stored server-side, so a recycled serverless instance cannot
 * lose a judge's upload mid-run.
 *
 * Pipeline per record: prefilter (free) -> Jev typed decisions (paid) -> geoparse (free).
 * Progress streams so the funnel fills visibly instead of hiding behind a spinner.
 */

import { blockedMessage, checkBudget, recordDailySpend, spendCookie } from "../../../lib/budget";
import { readImageMeta } from "../../../lib/exif";
import { describeImage, readImageText } from "../../../lib/vision";
import { geoparse } from "../../../lib/geoparse";
import { HAZARD_LEXICON, prefilter, scoreRelevance } from "../../../lib/prefilter";
import { buildQuestions, CONFIDENCE_GATE, deriveRelevance } from "../../../lib/questions";
import {
  decideWithRetry,
  readAnswer,
  SystemOneError,
  type SystemOneResponse,
} from "../../../lib/systemone";
import type {
  Category,
  EventProfile,
  FloodRecord,
  FunnelCounts,
  HazardType,
  RecordLabels,
} from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Classification of a large upload can take a while; Vercel allows up to 300s.
export const maxDuration = 300;

interface ClassifyBody {
  records: FloodRecord[];
  profile: EventProfile;
  byoKey?: string;
  accessCode?: string;
}

/**
 * Ingest hands images over as data URLs so the client can render them and re-post them
 * without us storing anything. Returns null on anything malformed rather than throwing,
 * because a corrupt upload must degrade to "no vision" and not kill the whole stream.
 */
function decodeDataUrl(ref: string | undefined): { bytes: Buffer; mimeType: string } | null {
  if (!ref) return null;
  // [\s\S] rather than the dotAll flag: this project targets an ES level where /s is not
  // available, and base64 of a real photo is long enough to contain newlines.
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(ref);
  if (!match) return null;
  try {
    return { mimeType: match[1], bytes: Buffer.from(match[2], "base64") };
  } catch {
    return null;
  }
}

/** Redacts the obvious identifiers. Applied whenever has_pii fires. */
function redact(text: string): string {
  return text
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[phone redacted]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email redacted]")
    .replace(/\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Cres|Way)\b/g,
      "[address redacted]");
}

/** Builds labels from a provider response. Gates on confidence, never on raw probability. */
function toLabels(res: SystemOneResponse): RecordLabels {
  const a = res.answers ?? {};
  const hazardTopic = a.hazard_topic?.noul ?? 0;
  const responseTopic = a.response_topic?.noul ?? 0;
  const rel = deriveRelevance(hazardTopic, responseTopic);

  const read = <T,>(key: string) => {
    const parsed = readAnswer(a[key]);
    return parsed ? { value: parsed.value as T, confidence: parsed.confidence, distribution: parsed.distribution } : undefined;
  };

  const labels: RecordLabels = {
    relevant: { value: rel.value, confidence: rel.confidence, via: rel.via },
    hazard_topic: { value: hazardTopic >= 0.5, confidence: Math.abs(hazardTopic - 0.5) * 2 },
    response_topic: { value: responseTopic >= 0.5, confidence: Math.abs(responseTopic - 0.5) * 2 },
  };

  const hazard = read<HazardType>("hazard");
  if (hazard) labels.hazard = hazard;
  const category = read<Category>("category");
  if (category) labels.category = category;
  const severity = read<number>("severity");
  if (severity) labels.severity = severity;
  for (const key of ["has_place", "is_request", "has_pii", "is_spam", "firsthand"] as const) {
    const parsed = read<boolean>(key);
    if (parsed) labels[key] = parsed;
  }
  return labels;
}

/** Degraded labels from the local prefilter, used when no paid call can be made. */
function heuristicLabels(text: string, profile: EventProfile): RecordLabels {
  const s = scoreRelevance(text, profile);
  const p = Math.min(0.95, s.score);
  // The hazard label must come from THIS post, not be copied from the profile. Once a mixed feed
  // is focused on flood, stamping every survivor "flood" made the degraded path (circuit breaker
  // open, budget spent) show every tornado and fire post in the flood-only view. A post earns the
  // profile's hazard only if its own text matches that hazard's vocabulary; otherwise "other".
  const ownHazard = HAZARD_LEXICON[profile.hazard].test(text) ? profile.hazard : "other";
  return {
    relevant: { value: p >= 0.3 && !s.likelySpam, confidence: 0.3, via: "hazard" },
    is_spam: { value: s.likelySpam, confidence: s.likelySpam ? 0.6 : 0.3 },
    hazard: { value: ownHazard, confidence: 0.3 },
  };
}

export async function POST(request: Request) {
  let body: ClassifyBody;
  try {
    body = (await request.json()) as ClassifyBody;
  } catch {
    return Response.json({ error: "Expected JSON { records, profile }." }, { status: 400 });
  }

  const records = Array.isArray(body.records) ? body.records : [];
  const profile = body.profile;
  if (!records.length || !profile) {
    return Response.json({ error: "records and profile are required." }, { status: 400 });
  }

  const budget = checkBudget({
    cookieHeader: request.headers.get("cookie"),
    byoKey: body.byoKey,
    accessCode: body.accessCode,
  });

  const questions = buildQuestions(profile);
  const concurrency = Math.max(1, Number(process.env.SYSTEMONE_CONCURRENCY ?? "20") || 20);

  const encoder = new TextEncoder();
  let spent = 0;
  let degraded = !budget.apiKey;
  let modelVersion: string | undefined;

  const funnel: FunnelCounts = {
    raw: records.length,
    deduped: records.length,
    prefiltered: 0,
    relevant: 0,
    mappable: 0,
    noPlaceMentioned: 0,
    rejectedRows: [],
  };

  // Prefilter runs BEFORE the stream so we know the candidate count up front. That matters
  // for the spend cookie: Set-Cookie is fixed when the Response is constructed, and the
  // stream body runs afterwards, so actual spend is not yet known. We therefore charge a
  // conservative up-front estimate to the cookie and report the true figure in the events.
  // It is measured at ~$0.00004/call for 10 questions (see docs/ARCHITECTURE.md).
  const COST_PER_CALL = 0.00004;
  // Split by front door. Image rows carry no text yet, so they take the vision path and must
  // not be handed to the text prefilter, which would drop them without emitting anything.
  const imageRecords = records.filter((r) => !r.text.trim() && r.imageRef);
  const unusable = records.filter((r) => !r.text.trim() && !r.imageRef);
  const textual = records.filter((r) => r.text.trim());
  const { candidates, dropped } = prefilter(
    textual.map((r) => ({ id: r.id, text: r.text })),
    profile,
  );
  funnel.prefiltered = candidates.length;
  const estimatedCost = degraded ? 0 : candidates.length * COST_PER_CALL;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        if (degraded) {
          send({
            type: "degraded",
            reason: budget.blockedReason ?? "no_key",
            message: blockedMessage(budget.blockedReason ?? "no_key"),
          });
        }

        send({ type: "progress", done: 0, total: records.length, stage: "prefilter" });
        send({ type: "funnel", funnel });

        const byId = new Map(records.map((r) => [r.id, r]));

        // Image records arrive with an empty text field, so they would never survive the
        // prefilter and would never be streamed back -- the client would wait forever for
        // rows that never arrive. Enrich them first: EXIF gives exact coordinates, vision
        // gives the caption that becomes their text plus the alt text accessibility needs.
        for (const record of imageRecords) {
          const decoded = decodeDataUrl(record.imageRef);
          let meta: Awaited<ReturnType<typeof readImageMeta>> = {};
          let described: Awaited<ReturnType<typeof describeImage>> = null;
          let ocr: Awaited<ReturnType<typeof readImageText>> = null;

          if (decoded) {
            meta = await readImageMeta(decoded.bytes);
            described = await describeImage(decoded.bytes, decoded.mimeType);
            // A screenshot is the documented fallback for platforms that block us, so always
            // try to read text out of the image as well as describe it.
            ocr = await readImageText(decoded.bytes, decoded.mimeType);
          }

          const ocrText = ocr?.text?.trim() ?? "";
          const text = ocrText || described?.caption?.trim() || record.text;

          // EXIF is the only exact geo source in this system; it outranks any inference.
          const places =
            meta.lat != null && meta.lon != null
              ? geoparse({ text, lat: meta.lat, lon: meta.lon, method: "exif" })
              : geoparse({ text });

          const enriched: FloodRecord = {
            ...record,
            text,
            ...(described?.altText ? { imageAlt: described.altText } : {}),
            ...(meta.timestamp ? { timestamp: record.timestamp ?? meta.timestamp } : {}),
            places,
            labels: described
              ? {
                  relevant: { value: described.hazardVisible, confidence: described.confidence, via: "hazard" },
                  hazard: { value: described.hazard, confidence: described.confidence },
                  category: { value: described.category, confidence: described.confidence },
                  has_place: { value: places.length > 0, confidence: places.length ? 0.9 : 0.5 },
                }
              : {
                  // No vision available. Say so rather than inventing a classification.
                  relevant: { value: false, confidence: 0, via: "hazard" },
                },
            classifier: described ? "jev" : "heuristic",
          };

          if (enriched.labels.relevant?.value) {
            funnel.relevant++;
            if (places.length) funnel.mappable++;
            else funnel.noPlaceMentioned++;
          }
          send({ type: "record", record: enriched });
        }
        if (imageRecords.length) send({ type: "funnel", funnel });

        // Rows with neither text nor an image cannot be classified by anything. They are
        // still returned, labelled honestly, because a row that vanishes is a row the user
        // cannot account for.
        for (const record of unusable) {
          funnel.rejectedRows.push({ row: 0, reason: `record ${record.id} has no text and no image` });
          send({
            type: "record",
            record: { ...record, labels: { relevant: { value: false, confidence: 0, via: "hazard" } }, classifier: "heuristic" } satisfies FloodRecord,
          });
        }

        // Dropped records are emitted immediately, labelled honestly as not-relevant by
        // the local pass. They are never silently discarded.
        for (const d of dropped) {
          const base = byId.get(d.id);
          if (!base) continue;
          const out: FloodRecord = {
            ...base,
            labels: {
              relevant: { value: false, confidence: 0.4, via: "hazard" },
              is_spam: { value: d.prefilter.likelySpam, confidence: d.prefilter.likelySpam ? 0.6 : 0.3 },
            },
            classifier: "heuristic",
          };
          send({ type: "record", record: out });
        }

        // ---- stage 2: typed decisions ---------------------------------------
        send({ type: "progress", done: 0, total: candidates.length, stage: "classify" });

        let done = 0;
        let consecutiveFailures = 0;
        let cursor = 0;

        const worker = async () => {
          for (;;) {
            // If the reader has gone (tab closed, judge navigated away) stop immediately.
            // Without this the stream runs to completion and keeps spending on classification
            // nobody will ever see.
            if (request.signal.aborted) return;
            const index = cursor++;
            if (index >= candidates.length) return;
            const candidate = candidates[index];
            const base = byId.get(candidate.id);
            if (!base) continue;

            let labels: RecordLabels;
            let classifier: FloodRecord["classifier"] = "heuristic";

            if (!degraded && budget.apiKey) {
              try {
                const res = await decideWithRetry(candidate.text, questions, {
                  apiKey: budget.apiKey,
                });
                labels = toLabels(res);
                classifier = "jev";
                modelVersion = res.model ?? modelVersion;
                consecutiveFailures = 0;

                const cost = res.usage?.cost ?? 0;
                if (!budget.byo) {
                  spent += cost;
                  recordDailySpend(cost);
                  // Stop paying the moment the budget is gone; finish the rest locally.
                  if (!budget.unlimited && budget.used + spent >= budget.budget) {
                    degraded = true;
                    send({
                      type: "degraded",
                      reason: "over_budget",
                      message: blockedMessage("over_budget"),
                    });
                  }
                }
              } catch (err) {
                consecutiveFailures++;
                labels = heuristicLabels(candidate.text, profile);
                // A 402 is terminal; repeated failures mean the provider is unhealthy.
                const terminal = err instanceof SystemOneError && err.status === 402;
                if (terminal || consecutiveFailures >= 5) {
                  degraded = true;
                  send({
                    type: "degraded",
                    reason: terminal ? "402" : "429",
                    message: terminal
                      ? blockedMessage("over_budget")
                      : "Classification is failing upstream. Remaining rows use local heuristics.",
                  });
                }
              }
            } else {
              labels = heuristicLabels(candidate.text, profile);
            }

            // ---- stage 3: geoparse (free, local) ----------------------------
            const provided = base.places.find((p) => p.method === "provided");
            const places =
              labels.has_place?.value === false && !provided
                ? [] // the model says there is no place; do not go looking for one
                : geoparse({
                    text: candidate.text,
                    lat: provided?.lat,
                    lon: provided?.lon,
                    method: provided?.method,
                  });

            const piiFired = labels.has_pii?.value === true;
            const out: FloodRecord = {
              ...base,
              text: piiFired ? redact(candidate.text) : base.text,
              ...(piiFired ? { rawText: undefined } : {}),
              labels,
              places,
              classifier,
              ...(modelVersion ? { modelVersion } : {}),
              review:
                (labels.relevant?.confidence ?? 0) < CONFIDENCE_GATE.relevant ? "auto" : base.review,
            };

            if (labels.relevant?.value) {
              funnel.relevant++;
              if (places.length) funnel.mappable++;
              else funnel.noPlaceMentioned++;
            }

            send({ type: "record", record: out });

            done++;
            if (done % 25 === 0 || done === candidates.length) {
              send({ type: "progress", done, total: candidates.length, stage: "classify" });
              send({ type: "funnel", funnel });
              send({
                type: "spend",
                spend: {
                  used: budget.used + spent,
                  budget: budget.budget,
                  unlimited: budget.unlimited || budget.byo,
                  degraded,
                },
              });
            }
          }
        };

        await Promise.all(
          Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
        );

        send({
          type: "done",
          funnel,
          spend: {
            used: budget.used + spent,
            budget: budget.budget,
            unlimited: budget.unlimited || budget.byo,
            degraded,
          },
          modelVersion,
        });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies that buffer would defeat the point of streaming.
    "X-Accel-Buffering": "no",
  });
  // Meter the visitor's own spend only; a BYO key costs us nothing. The estimate is charged
  // rather than the actual, for the ordering reason explained above. A visitor can reset it
  // by clearing cookies — accepted deliberately; the real ceiling is the daily global limit
  // plus a small account balance, not this counter.
  if (!budget.byo && !budget.unlimited) {
    headers.append("Set-Cookie", spendCookie(budget.used + estimatedCost));
  }

  return new Response(stream, { headers });
}
