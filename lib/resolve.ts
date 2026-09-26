/**
 * Per-platform link adapters: URL in, { text, provenance, images } out.
 *
 * Pure logic, no Next imports -- testable with plain tsx (scripts/test-resolve.mts) and
 * reused unchanged by app/api/resolve/route.ts.
 *
 * Adapter priority, from docs/ARCHITECTURE.md 4.7 (verified 2026-09-26):
 *   1. direct image URL       -> route straight to the vision/OCR path, no fetch needed
 *   2. X / Twitter oEmbed     -> publish.x.com, no auth
 *   3. Bluesky public API     -> public.api.bsky.app, no auth
 *   4. Fediverse / Mastodon   -> <instance>/api/v1/statuses/<id>, single-status is public
 *   5. anything else          -> readability extraction, no dependency
 * Reddit, Facebook, Instagram, Threads are refused up front: their APIs need credentials
 * (OAuth app creds, or Meta App Review + business verification) we do not have.
 */

import type { Provenance } from "./types";

const USER_AGENT = "Deucalion/0.1 (+https://github.com/Asrar-ali/deucalion)";
const FETCH_TIMEOUT_MS = 8000;
// A malicious or just-huge page must not be read into memory in full.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Judges paste the same link repeatedly; oEmbed rate limits are unpublished.
const CACHE_TTL_MS = 10 * 60 * 1000;
const READABLE_TEXT_CAP = 4000;

export interface ResolveSuccess {
  text: string;
  provenance: Provenance;
  images: string[];
}

/** The platform refused, the post is gone/protected, or the request errored/timed out. */
export interface ResolveBlocked {
  needsScreenshot: true;
  reason: string;
  detail: string;
}

/** The URL itself is not acceptable to fetch server-side (SSRF guard, bad syntax). */
export interface ResolveInvalid {
  invalid: true;
  detail: string;
}

export type ResolveOutcome = ResolveSuccess | ResolveBlocked | ResolveInvalid;

export function isBlocked(outcome: ResolveOutcome): outcome is ResolveBlocked {
  return "needsScreenshot" in outcome;
}

export function isInvalid(outcome: ResolveOutcome): outcome is ResolveInvalid {
  return "invalid" in outcome;
}

function blocked(reason: string, detail: string): ResolveBlocked {
  return { needsScreenshot: true, reason, detail };
}

function invalid(detail: string): ResolveInvalid {
  return { invalid: true, detail };
}

function baseProvenance(url: URL, fetchMethod: NonNullable<Provenance["fetchMethod"]>): Provenance {
  return { sourceUrl: url.toString(), fetchMethod, fetchedAt: new Date().toISOString() };
}

// ---- in-memory cache -------------------------------------------------------
// A module-level Map is correct for a hackathon deployment: no database, and it survives
// for the lifetime of one serverless instance, which is all the TTL needs.

const cache = new Map<string, { at: number; outcome: ResolveOutcome }>();

function cacheGet(key: string): ResolveOutcome | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.outcome;
}

function cacheSet(key: string, outcome: ResolveOutcome): void {
  cache.set(key, { at: Date.now(), outcome });
}

// ---- SSRF guard -------------------------------------------------------------
// This endpoint takes a user-supplied URL and fetches it server-side. Checked against the
// literal hostname only (no DNS resolution / rebinding defence) -- proportionate for a
// hackathon judge-facing endpoint, but say so plainly rather than implying more than this does.

function isPrivateHost(hostnameRaw: string): boolean {
  const host = hostnameRaw.replace(/^\[|\]$/g, "").toLowerCase();

  if (host === "localhost" || host.endsWith(".local")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }

  if (host.includes(":")) {
    if (host === "::1") return true; // loopback
    if (host.startsWith("fe80:")) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique local
    return false;
  }

  return false;
}

/** Parses and syntax-checks a user-supplied URL. Never throws. */
function parseUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

// ---- hardcoded out-of-scope platforms ---------------------------------------
// docs/ARCHITECTURE.md 4.7: their APIs are known-closed, so a network round trip would
// only burn the 8s timeout budget for an outcome we already know.

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hardBlockReason(hostname: string): { reason: string; detail: string } | null {
  if (matchesDomain(hostname, "reddit.com") || matchesDomain(hostname, "redd.it")) {
    return {
      reason: "reddit_blocked",
      detail:
        "Reddit returns 403 to unauthenticated server-side requests; it needs OAuth app credentials we do not have.",
    };
  }
  if (matchesDomain(hostname, "facebook.com") || matchesDomain(hostname, "fb.com")) {
    return {
      reason: "facebook_blocked",
      detail: "Facebook's API requires App Review and business verification; out of scope for this deployment.",
    };
  }
  if (matchesDomain(hostname, "instagram.com")) {
    return {
      reason: "instagram_blocked",
      detail: "Instagram's API requires App Review and business verification; out of scope for this deployment.",
    };
  }
  if (matchesDomain(hostname, "threads.net")) {
    return {
      reason: "threads_blocked",
      detail: "Threads shares Meta's App Review requirement; out of scope for this deployment.",
    };
  }
  return null;
}

// ---- fetch helpers -----------------------------------------------------------

type OpenFetchResult = { ok: true; res: Response } | { ok: false; reason: string; detail: string };

const MAX_REDIRECTS = 3;

/**
 * Follows redirects MANUALLY and re-runs the SSRF guard on every hop.
 *
 * fetch() follows redirects by default, which would defeat the guard entirely: a public URL
 * can answer 302 with Location: http://169.254.169.254/latest/meta-data/ (cloud metadata) or
 * http://127.0.0.1:8080/, and the body would come straight back to the caller. Checking only
 * the hostname the user typed is not enough, and it matters most for Mastodon, where the
 * instance hostname is itself user-supplied.
 */
async function openFetch(url: string, init?: RequestInit): Promise<OpenFetchResult> {
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = parseUrl(target);
    if (!parsed) {
      return { ok: false, reason: "bad_redirect", detail: "A redirect pointed at an unsupported URL." };
    }
    if (isPrivateHost(parsed.hostname)) {
      return {
        ok: false,
        reason: "blocked_redirect",
        detail: "A redirect pointed at a private or loopback address, so the chain was abandoned.",
      };
    }

    const attempt = await openFetchOnce(target, init);
    if (!attempt.ok) return attempt;

    const status = attempt.res.status;
    const location = attempt.res.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      // Resolve relative Locations against the current URL before the next guard pass.
      target = new URL(location, parsed).toString();
      continue;
    }
    return attempt;
  }

  return {
    ok: false,
    reason: "too_many_redirects",
    detail: `Gave up after ${MAX_REDIRECTS} redirects.`,
  };
}

async function openFetchOnce(url: string, init?: RequestInit): Promise<OpenFetchResult> {
  try {
    const res = await fetch(url, {
      ...init,
      // Manual, so the guard above sees every hop. Never change this to "follow".
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { ok: true, res };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    // AbortSignal.timeout() fires a TimeoutError DOMException; some runtimes surface it
    // as AbortError instead. Treat both as a timeout, not a generic network failure.
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      reason: isTimeout ? "timeout" : "network_error",
      detail: isTimeout
        ? `Request timed out after ${FETCH_TIMEOUT_MS}ms.`
        : `Could not reach the server: ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
}

/** Reads a response body, stopping after ~2MB so a huge page cannot exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return res.text().catch(() => "");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  out += decoder.decode();
  return out;
}

type FetchJsonResult = { ok: true; data: unknown } | { ok: false; reason: string; detail: string };

async function fetchJson(url: string, init?: RequestInit): Promise<FetchJsonResult> {
  const opened = await openFetch(url, init);
  if (!opened.ok) return opened;

  const body = await readCapped(opened.res);
  if (!opened.res.ok) {
    return { ok: false, reason: `http_${opened.res.status}`, detail: `${url} returned HTTP ${opened.res.status}.` };
  }
  try {
    return { ok: true, data: JSON.parse(body) };
  } catch {
    return { ok: false, reason: "bad_response", detail: "Response was not valid JSON." };
  }
}

// ---- HTML utilities ------------------------------------------------------
// No dependency for HTML parsing anywhere in this file, per the brief.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  nbsp: " ",
  hellip: "…",
};

function unescapeHtml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n");
  return unescapeHtml(stripTags(withBreaks))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pulls only the quoted-post <p> out of an X/Twitter oEmbed blockquote, dropping the
 * trailing "-- Author (@handle) date" attribution that sits outside the <p> tag. */
function extractTweetText(html: string): string | null {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!match) return null;
  const withBreaks = match[1].replace(/<br\s*\/?>/gi, "\n");
  return unescapeHtml(stripTags(withBreaks)).trim();
}

function extractMeta(html: string, property: string): string | undefined {
  // property/content can appear in either attribute order.
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']|` +
      `<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`,
    "i",
  );
  const m = html.match(re);
  const raw = m?.[1] ?? m?.[2];
  return raw ? unescapeHtml(raw).trim() : undefined;
}

const STRIPPED_TAGS = ["script", "style", "nav", "header", "footer", "aside", "svg"];

function extractReadableText(html: string): string {
  let cleaned = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of STRIPPED_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
  }

  const title = extractMeta(html, "og:title");
  const description = extractMeta(html, "og:description");

  // <article>/<main> narrows out nav rails and related-links chrome that a plain tag
  // strip would otherwise fold into the body text.
  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const scoped = articleMatch?.[1] ?? mainMatch?.[1] ?? cleaned;

  const bodyText = unescapeHtml(stripTags(scoped))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();

  const prefix = [title, description].filter(Boolean).join(" -- ");
  const full = prefix ? `${prefix}\n\n${bodyText}` : bodyText;
  return full.slice(0, READABLE_TEXT_CAP);
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|heic)$/i;

function looksLikeImagePath(pathname: string): boolean {
  return IMAGE_EXTENSIONS.test(pathname);
}

// ---- adapters -----------------------------------------------------------

function isTwitterHost(hostname: string): boolean {
  return matchesDomain(hostname, "twitter.com") || matchesDomain(hostname, "x.com");
}

async function resolveTwitter(url: URL): Promise<ResolveOutcome> {
  // publish.twitter.com 301-redirects to publish.x.com -- call the target directly so a
  // dead/flaky redirect hop cannot eat into the 8s timeout budget.
  const oembedUrl = `https://publish.x.com/oembed?url=${encodeURIComponent(url.toString())}&omit_script=1`;
  const result = await fetchJson(oembedUrl);
  if (!result.ok) return blocked(result.reason, result.detail);

  const data = result.data as { html?: string; author_name?: string };
  if (!data.html) {
    return blocked("oembed_empty", "X oEmbed returned no html field; the post may be deleted or protected.");
  }
  const text = extractTweetText(data.html);
  if (text === null) {
    return blocked("oembed_unparseable", "Could not find a <p> element in the oEmbed HTML.");
  }

  return {
    text,
    images: [],
    provenance: { ...baseProvenance(url, "oembed"), author: data.author_name },
  };
}

async function resolveBluesky(url: URL): Promise<ResolveOutcome> {
  const match = url.pathname.match(/^\/profile\/([^/]+)\/post\/([^/]+)/);
  if (!match) return blocked("bluesky_bad_url", "Not a recognizable bsky.app post URL.");
  const [, profile, rkey] = match;

  let did = profile;
  if (!did.startsWith("did:")) {
    const handleResult = await fetchJson(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(profile)}`,
    );
    if (!handleResult.ok) return blocked(handleResult.reason, handleResult.detail);
    const handleData = handleResult.data as { did?: string };
    if (!handleData.did) return blocked("bluesky_handle_unresolved", "Could not resolve the handle to a DID.");
    did = handleData.did;
  }

  const threadUri = `at://${did}/app.bsky.feed.post/${rkey}`;
  const threadResult = await fetchJson(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(threadUri)}&depth=0`,
  );
  if (!threadResult.ok) return blocked(threadResult.reason, threadResult.detail);

  const data = threadResult.data as {
    thread?: {
      post?: {
        record?: { text?: string };
        author?: { handle?: string };
        embed?: { images?: Array<{ fullsize?: string }> };
      };
    };
  };
  const post = data.thread?.post;
  if (!post || post.record?.text === undefined) {
    return blocked("bluesky_not_found", "Post thread had no post record -- likely deleted or blocked.");
  }

  const images = (post.embed?.images ?? []).map((i) => i.fullsize).filter((u): u is string => Boolean(u));

  return {
    text: post.record.text,
    images,
    provenance: { ...baseProvenance(url, "api"), author: post.author?.handle },
  };
}

function parseMastodonStatusId(pathname: string): string | null {
  const userStatus = pathname.match(/\/@[^/]+\/(\d+)\/?$/);
  if (userStatus) return userStatus[1];
  const usersStatus = pathname.match(/\/users\/[^/]+\/statuses\/(\d+)\/?$/);
  if (usersStatus) return usersStatus[1];
  return null;
}

async function resolveMastodon(url: URL): Promise<ResolveOutcome> {
  const id = parseMastodonStatusId(url.pathname);
  if (!id) return blocked("mastodon_bad_url", "Not a recognizable Mastodon status URL.");

  // The single-status endpoint is public even on instances whose timeline endpoint
  // now requires auth -- verified 2026-09-26 against mastodon.social.
  const result = await fetchJson(`https://${url.hostname}/api/v1/statuses/${id}`);
  if (!result.ok) return blocked(result.reason, result.detail);

  const data = result.data as {
    content?: string;
    account?: { acct?: string };
    media_attachments?: Array<{ url?: string }>;
  };
  if (typeof data.content !== "string") {
    return blocked("mastodon_empty", "Status response had no content field.");
  }

  const images = (data.media_attachments ?? []).map((a) => a.url).filter((u): u is string => Boolean(u));

  return {
    text: htmlToPlainText(data.content),
    images,
    provenance: { ...baseProvenance(url, "api"), author: data.account?.acct },
  };
}

async function resolveGeneric(url: URL): Promise<ResolveOutcome> {
  const opened = await openFetch(url.toString());
  if (!opened.ok) return blocked(opened.reason, opened.detail);
  if (!opened.res.ok) {
    return blocked(`http_${opened.res.status}`, `The page returned HTTP ${opened.res.status}.`);
  }

  // Check content-type before consuming the body: an extensionless image URL still
  // deserves the image path rather than being decoded as garbled "HTML".
  const contentType = opened.res.headers.get("content-type") ?? "";
  if (contentType.startsWith("image/")) {
    return { text: "", images: [url.toString()], provenance: baseProvenance(url, "manual") };
  }

  const html = await readCapped(opened.res);
  return { text: extractReadableText(html), images: [], provenance: baseProvenance(url, "readability") };
}

// ---- entry points -----------------------------------------------------------

/** Resolves one URL. Never throws -- every failure path returns a typed outcome. */
export async function resolveUrl(raw: string): Promise<ResolveOutcome> {
  const trimmed = raw.trim();

  const cached = cacheGet(trimmed);
  if (cached) return cached;

  const url = parseUrl(trimmed);
  if (!url) return invalid("URL must be an absolute http:// or https:// URL.");
  if (isPrivateHost(url.hostname)) {
    return invalid("Refusing to fetch a localhost, .local, or private/loopback/link-local address.");
  }

  const hardBlock = hardBlockReason(url.hostname);
  if (hardBlock) {
    const outcome = blocked(hardBlock.reason, hardBlock.detail);
    cacheSet(trimmed, outcome);
    return outcome;
  }

  let outcome: ResolveOutcome;
  if (looksLikeImagePath(url.pathname)) {
    outcome = { text: "", images: [url.toString()], provenance: baseProvenance(url, "manual") };
  } else if (isTwitterHost(url.hostname)) {
    outcome = await resolveTwitter(url);
  } else if (matchesDomain(url.hostname, "bsky.app")) {
    outcome = await resolveBluesky(url);
  } else if (parseMastodonStatusId(url.pathname)) {
    outcome = await resolveMastodon(url);
  } else {
    outcome = await resolveGeneric(url);
  }

  // Invalid outcomes are local and deterministic -- nothing to save by caching them.
  // The cache exists to avoid re-hitting rate-limited upstreams.
  if (!isInvalid(outcome)) cacheSet(trimmed, outcome);
  return outcome;
}

/**
 * Resolves a batch with bounded concurrency. Caps at 20 URLs and 5 concurrent fetches so
 * one request cannot fan out into an unbounded number of outbound calls.
 */
export async function resolveMany(urls: string[]): Promise<ResolveOutcome[]> {
  const capped = urls.slice(0, 20);
  const results = new Array<ResolveOutcome>(capped.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= capped.length) return;
      results[i] = await resolveUrl(capped[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(5, capped.length) }, worker));
  return results;
}
