/**
 * System One client. Plain fetch, no vendor SDK.
 *
 * Why no SDK: laya-serve exposes this IDENTICAL /v1/systemone shape, so our fallback from
 * hosted Jev to a self-hosted open-weights model is a base-URL swap and nothing else.
 * Coupling to @typesafe-ai/sdk would throw that away.
 *
 * Typed decisions do NOT go through chat completions. Using a chat SDK here is what
 * produces a 404 or a shape error.
 */

import type { Question } from "./questions";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";
/** Pin the version. Never send the console id "jev-1.13.0" to OpenRouter. */
const DEFAULT_MODEL = "jev-1.13";

export type State = string | string[] | Record<string, string>;

export interface SystemOneAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  distribution?: Record<string, number> | number[];
}

export interface SystemOneResponse {
  id?: string;
  /** Exact provider version, e.g. "typesafe/jev-1.13-20260917". Logged for the audit trail. */
  model?: string;
  provider?: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}

export class SystemOneError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** True when retrying could succeed. */
    readonly retryable: boolean,
    /** Server-suggested wait from a Retry-After header, in ms. */
    readonly retryAfterMs?: number,
  ) {
    super(`systemone ${status}: ${body.slice(0, 200)}`);
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

/**
 * One record in, typed answers out. All questions are evaluated in parallel server-side
 * in a single request — do not split them into separate calls.
 */
export async function decide(
  state: State,
  questions: Record<string, Question>,
  opts: ClientOptions,
  signal?: AbortSignal,
): Promise<SystemOneResponse> {
  const base = opts.baseUrl ?? process.env.SYSTEMONE_BASE_URL ?? DEFAULT_BASE;
  const model = opts.model ?? process.env.SYSTEMONE_MODEL ?? DEFAULT_MODEL;

  const res = await fetch(`${base}/systemone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, state, questions }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 429 rate limit and 5xx are worth retrying. 401/402/404 are not.
    const retryable = res.status === 429 || res.status >= 500;
    const ra = Number(res.headers.get("retry-after"));
    throw new SystemOneError(res.status, body, retryable, Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : undefined);
  }

  return (await res.json()) as SystemOneResponse;
}

/** Retry with exponential backoff + jitter. Only retries what is actually retryable. */
export async function decideWithRetry(
  state: State,
  questions: Record<string, Question>,
  opts: ClientOptions,
  maxAttempts = 6,
): Promise<SystemOneResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await decide(state, questions, opts);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof SystemOneError) || !err.retryable) throw err;
      const delay = (err.retryAfterMs ?? Math.min(4000, 200 * 2 ** attempt)) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Bounded-concurrency map. P50 latency is ~0.26s, so concurrency 20 put the 8k-row
 * corpus at roughly a minute. Raise carefully: OpenRouter rate limits are unpublished.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<R | Error>> {
  const results = new Array<R | Error>(items.length);
  let next = 0;
  let done = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = err instanceof Error ? err : new Error(String(err));
      }
      onProgress?.(++done, items.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/** Normalise a raw answer into a value + confidence. Never trust act_probability. */
export function readAnswer(a: SystemOneAnswer | undefined) {
  if (!a) return undefined;
  if (a.type === "noul" || typeof a.noul === "number") {
    const p = a.noul ?? 0;
    return {
      value: p >= 0.5,
      // Distance from the decision boundary IS the confidence for a calibrated noul.
      confidence: Math.abs(p - 0.5) * 2,
      probability: p,
    };
  }
  if (a.type === "choice") {
    return {
      value: a.choice,
      confidence: a.confidence ?? 0,
      distribution: a.distribution,
    };
  }
  return {
    value: a.score,
    confidence: a.confidence ?? 0,
    distribution: a.distribution,
  };
}
