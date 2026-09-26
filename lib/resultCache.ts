/**
 * Browser-side cache of paid classification results, so loading the same file again (or a file
 * that overlaps an earlier one) is instant and free.
 *
 * Only "jev" results are ever stored. Heuristic or degraded labels would poison later runs.
 * What is stored: a SHA-256 of hazard + text + model version (not the text), the labels, the
 * classifier, the model version, and a timestamp. It never leaves this browser.
 *
 * Every IndexedDB call is wrapped: a blocked, missing or throwing store means "no cache", and
 * a run must never fail or slow down because of it.
 */

import { buildQuestions, CONFIDENCE_GATE } from "./questions";
import type { EventProfile, FloodRecord, PlaceHit, RecordLabels } from "./types";

/** Bump when anything besides the question set changes how a post is labelled. */
export const CACHE_MODEL_VERSION = "jev-1";
/** Hard cap on stored entries; the oldest are evicted first. */
export const MAX_ENTRIES = 200_000;

const DB_NAME = "deucalion-results";
const STORE = "results";

export interface CacheEntry {
  key: string;
  labels: RecordLabels;
  classifier: "jev";
  modelVersion?: string;
  /** Redacted display text, kept only when the classifier flagged PII (the server redacts). */
  redactedText?: string;
  ts: number;
}

/** The storage seam. IndexedDB in the browser, a Map in tests. */
export interface CacheStore {
  getMany(keys: string[]): Promise<Map<string, CacheEntry>>;
  putMany(entries: CacheEntry[], max: number): Promise<void>;
  clear(): Promise<void>;
}

/** Conservative on purpose: only whitespace and Unicode form, so distinct posts never merge. */
export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Cheap 53-bit string hash (cyrb53). Fallback when crypto.subtle is unavailable. */
export function simpleHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "s" + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export async function hashString(s: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const buf = await subtle.digest("SHA-256", new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Fall through to the simple hash.
  }
  return simpleHash(s);
}

/**
 * Version string covering the question set for this profile, so editing a question in
 * lib/questions.ts invalidates old entries without anyone remembering to bump a constant.
 */
export function modelVersionFor(profile: EventProfile): string {
  return `${CACHE_MODEL_VERSION}:${simpleHash(JSON.stringify(buildQuestions(profile)))}`;
}

/** The exact string that gets hashed. Exported for tests. */
export function keyMaterial(profile: Pick<EventProfile, "hazard">, text: string, version: string): string {
  return `${profile.hazard}|${normalizeText(text)}|${version}`;
}

export async function buildKey(profile: EventProfile, text: string): Promise<string> {
  return hashString(keyMaterial(profile, text, modelVersionFor(profile)));
}

/** True when a freshly classified record may be written to the cache. */
export function isCacheable(r: FloodRecord): boolean {
  return r.classifier === "jev" && r.text.trim().length > 0 && !!r.labels.relevant;
}

/**
 * Turns a cache hit into the record the server would have produced. Places are passed in
 * (the caller re-geoparses exactly as the route does) because they depend on the row's own
 * coordinates, which are not part of the key. Never mutates its inputs.
 */
export function mergeCached(base: FloodRecord, entry: CacheEntry, places: PlaceHit[]): FloodRecord {
  const piiFired = entry.labels.has_pii?.value === true;
  const out: FloodRecord = {
    ...base,
    text: piiFired && entry.redactedText !== undefined ? entry.redactedText : base.text,
    labels: entry.labels,
    places,
    classifier: "jev",
    review: (entry.labels.relevant?.confidence ?? 0) < CONFIDENCE_GATE.relevant ? "auto" : base.review,
  };
  if (piiFired) delete out.rawText;
  if (entry.modelVersion) out.modelVersion = entry.modelVersion;
  return out;
}

/** Same rule as the route: a relevant record is mappable if it has a place, else "no place". */
export function funnelDelta(records: FloodRecord[]) {
  const d = { prefiltered: 0, relevant: 0, mappable: 0, noPlaceMentioned: 0 };
  for (const r of records) {
    d.prefiltered++;
    if (r.labels.relevant?.value) {
      d.relevant++;
      if (r.places.length) d.mappable++;
      else d.noPlaceMentioned++;
    }
  }
  return d;
}

/**
 * Splits records into cache hits (already merged) and the rest to send to the network.
 * `regeoparse` mirrors the route's stage 3 for a hit.
 */
export async function partitionByCache(
  store: CacheStore,
  profile: EventProfile,
  records: FloodRecord[],
  regeoparse: (base: FloodRecord, labels: RecordLabels) => PlaceHit[],
): Promise<{ hits: FloodRecord[]; misses: FloodRecord[]; keys: Map<string, string> }> {
  const keys = new Map<string, string>(); // record id -> key, for writing back
  const hits: FloodRecord[] = [];
  const misses: FloodRecord[] = [];
  try {
    const version = modelVersionFor(profile);
    for (const r of records) {
      if (r.text.trim()) keys.set(r.id, await hashString(keyMaterial(profile, r.text, version)));
    }
    const found = await store.getMany([...new Set(keys.values())]);
    for (const r of records) {
      const key = keys.get(r.id);
      const entry = key ? found.get(key) : undefined;
      if (entry && entry.classifier === "jev") hits.push(mergeCached(r, entry, regeoparse(r, entry.labels)));
      else misses.push(r);
    }
    return { hits, misses, keys };
  } catch {
    return { hits: [], misses: records, keys };
  }
}

/** Writes newly classified jev records back. Never throws. */
export async function storeResults(
  store: CacheStore,
  keys: Map<string, string>,
  records: FloodRecord[],
): Promise<void> {
  try {
    const ts = Date.now();
    const entries: CacheEntry[] = [];
    for (const r of records) {
      const key = keys.get(r.id);
      if (!key || !isCacheable(r)) continue;
      const pii = r.labels.has_pii?.value === true;
      entries.push({
        key,
        labels: r.labels,
        classifier: "jev",
        ...(r.modelVersion ? { modelVersion: r.modelVersion } : {}),
        ...(pii ? { redactedText: r.text } : {}),
        ts,
      });
    }
    if (entries.length) await store.putMany(entries, MAX_ENTRIES);
  } catch {
    // A failed write only costs a future cache hit.
  }
}

/** In-memory store for tests. Same eviction rule as the IndexedDB one. */
export function createMemoryStore(): CacheStore & { size(): number } {
  const m = new Map<string, CacheEntry>();
  return {
    async getMany(keys) {
      const out = new Map<string, CacheEntry>();
      for (const k of keys) {
        const e = m.get(k);
        if (e) out.set(k, e);
      }
      return out;
    },
    async putMany(entries, max) {
      for (const e of entries) m.set(e.key, e);
      if (m.size > max) {
        const oldest = [...m.values()].sort((a, b) => a.ts - b.ts).slice(0, m.size - max);
        for (const e of oldest) m.delete(e.key);
      }
    },
    async clear() {
      m.clear();
    },
    size: () => m.size,
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("ts", "ts");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** The browser store. Every method resolves to "nothing" instead of rejecting when unavailable. */
export const browserStore: CacheStore = {
  async getMany(keys) {
    const out = new Map<string, CacheEntry>();
    try {
      const db = await openDb();
      if (!db) return out;
      const os = db.transaction(STORE, "readonly").objectStore(STORE);
      const rows = await Promise.all(keys.map((k) => req(os.get(k)).catch(() => undefined)));
      for (const row of rows) if (row) out.set((row as CacheEntry).key, row as CacheEntry);
    } catch {
      // No cache.
    }
    return out;
  },
  async putMany(entries, max) {
    try {
      const db = await openDb();
      if (!db) return;
      const tx = db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const e of entries) os.put(e);
      await txDone(tx);
      const count = await req(db.transaction(STORE, "readonly").objectStore(STORE).count());
      if (count > max) {
        let excess = count - max;
        const etx = db.transaction(STORE, "readwrite");
        const cursorReq = etx.objectStore(STORE).index("ts").openKeyCursor();
        cursorReq.onsuccess = () => {
          const c = cursorReq.result;
          if (c && excess > 0) {
            etx.objectStore(STORE).delete(c.primaryKey);
            excess--;
            c.continue();
          }
        };
        await txDone(etx);
      }
    } catch {
      // No cache.
    }
  },
  async clear() {
    try {
      const db = await openDb();
      if (!db) return;
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await txDone(tx);
    } catch {
      // Nothing to clear.
    }
  },
};
