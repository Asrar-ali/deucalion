/**
 * LLM plumbing for text generation and image understanding.
 *
 * Text and structured output (narrate, plainLanguage): hackathon organizers' Gemini proxy.
 * Why not the SDK: the proxy is a simple POST endpoint; coupling to @google/genai ties us
 * to that specific transport forever, defeating the fallback to a self-hosted model.
 *
 * Images (describeImage, readImageText): OpenRouter's Gemini implementation.
 * Why OpenRouter: the proxy cannot parse parts arrays. Images go to a provider that can.
 *
 * Circuit breaker: after any 401, 403, or 429, all proxy calls return null instantly with
 * no network request. One exhausted-quota reply must not become fifty requests wasted.
 * Retry: at most once, and only on 500 or a network error. Never retry 401/403/422/429:
 * they fail identically and each attempt costs a request.
 */

export class LlmError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /** True when retrying could succeed (5xx, network error). */
    readonly retryable: boolean,
  ) {
    super(`llm ${status}: ${body.slice(0, 200)}`);
  }
}

/** The most recent requests_remaining from a proxy response, or null if never called. */
let lastQuotaValue: number | null = null;

/** True if a 401, 403, or 429 has been seen. All proxy calls thereafter return null. */
let circuitBreakerOpen = false;

export function lastQuota(): number | null {
  return lastQuotaValue;
}

/**
 * Generate plain text via the hackathon organizers' proxy.
 * Returns null on any failure (no key, network error, quota exhausted, safety block).
 * Retries at most once, only on 500 or network error.
 */
export async function generateText(
  prompt: string,
  opts?: { timeoutMs?: number; model?: string },
): Promise<string | null> {
  if (circuitBreakerOpen) return null;

  const baseUrl = process.env.GEMINI_PROXY_BASE_URL || "https://hackathon-api-new-152590733511.northamerica-northeast2.run.app/api/generate";
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = opts?.model || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
  const timeoutMs = opts?.timeoutMs || 90_000;

  let lastErr: LlmError | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contents: prompt, model }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");

          // Track quota before deciding on circuit breaker
          // (the proxy may include it in error responses)
          if (typeof (res as any).headers?.get?.("X-Requests-Remaining") === "string") {
            lastQuotaValue = parseInt((res as any).headers.get("X-Requests-Remaining"));
          }

          // 401, 403, 429 are permanent failures for this process. Open circuit.
          if (res.status === 401 || res.status === 403 || res.status === 429) {
            circuitBreakerOpen = true;
            return null;
          }

          // 5xx errors are worth retrying.
          const retryable = res.status >= 500;
          lastErr = new LlmError(res.status, body, retryable);

          if (!retryable) return null;
          if (attempt === 0) {
            // Backoff before retry
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          return null;
        }

        const data = (await res.json()) as { text?: string; requests_remaining?: number };
        if (data.requests_remaining !== undefined) {
          lastQuotaValue = data.requests_remaining;
        }

        return data.text ?? null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return null; // Timeout
      }
      // Network error: retryable
      lastErr = new LlmError(0, String(err), true);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Generate structured JSON via the hackathon organizers' proxy.
 * Schema is passed as the response_schema field.
 * Returns null if generation fails OR the response cannot be parsed as valid JSON
 * matching the expected shape.
 */
export async function generateJson<T>(
  prompt: string,
  schema: unknown,
  opts?: { timeoutMs?: number; model?: string },
): Promise<T | null> {
  if (circuitBreakerOpen) return null;

  const baseUrl = process.env.GEMINI_PROXY_BASE_URL || "https://hackathon-api-new-152590733511.northamerica-northeast2.run.app/api/generate";
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = opts?.model || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
  const timeoutMs = opts?.timeoutMs || 90_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ contents: prompt, model, response_schema: schema }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");

          if (res.status === 401 || res.status === 403 || res.status === 429) {
            circuitBreakerOpen = true;
            return null;
          }

          const retryable = res.status >= 500;
          if (!retryable) return null;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          return null;
        }

        const data = (await res.json()) as { text?: string; requests_remaining?: number };
        if (data.requests_remaining !== undefined) {
          lastQuotaValue = data.requests_remaining;
        }

        if (!data.text) return null;

        try {
          return JSON.parse(data.text) as T;
        } catch {
          // Malformed JSON from the model
          return null;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return null;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Generate structured JSON from an image via OpenRouter's Gemini.
 * Base64-encodes the image and sends it with the prompt and schema.
 * Returns null on any failure (no key, network error, bad image, generation failure).
 * Retries at most once, only on 500 or network error.
 */
export async function describeImageJson<T>(
  base64: string,
  mimeType: string,
  prompt: string,
  schema: unknown,
  opts?: { timeoutMs?: number; model?: string },
): Promise<T | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const model = opts?.model || process.env.VISION_MODEL || "google/gemini-3.5-flash-lite";
  const timeoutMs = opts?.timeoutMs || 120_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${base64}` },
                  },
                ],
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "result",
                strict: true,
                schema: schema as Record<string, unknown>,
              },
            },
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");

          // OpenRouter doesn't have our circuit breaker rules, but we still don't want
          // to burn requests on permanent failures. Never retry on 401, 402, 403, 422.
          const retryable = res.status === 500 || res.status === 503;

          if (!retryable) return null;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          return null;
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        const content = data.choices?.[0]?.message?.content;
        if (!content) return null;

        try {
          return JSON.parse(content) as T;
        } catch {
          return null;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return null;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Text-only structured JSON via OpenRouter. The organizers' proxy is shared and its latency
 * swings from 6 s to 90 s, so callers that need a snappy answer try this first and fall back
 * to generateJson. Returns null on any failure.
 */
export async function generateJsonFast<T>(
  prompt: string,
  schema: unknown,
  opts?: { timeoutMs?: number; model?: string },
): Promise<T | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const model = opts?.model || process.env.ASK_MODEL || process.env.VISION_MODEL || "google/gemini-3.5-flash-lite";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 12_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "result", strict: true, schema: withNoExtraProps(schema) },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    return content ? (JSON.parse(content) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Strict json_schema mode requires additionalProperties:false on every object. */
function withNoExtraProps(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withNoExtraProps);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) out[k] = withNoExtraProps(v);
    if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
    return out;
  }
  return schema;
}
