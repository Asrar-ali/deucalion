/** node --import tsx scripts/test-cache.mts */
import {
  buildKey, createMemoryStore, funnelDelta, keyMaterial, mergeCached, normalizeText,
  partitionByCache, storeResults, MAX_ENTRIES,
} from "../lib/resultCache";
import type { EventProfile, FloodRecord, RecordLabels } from "../lib/types";

let failures = 0;
const ok = (c: boolean, m: string) => { if (c) console.log(`  ok   ${m}`); else { failures++; console.error(`  FAIL ${m}`); } };

const profile: EventProfile = { hazard: "flood", places: [], terms: [], userEdited: false };
const quake: EventProfile = { ...profile, hazard: "quake" };
const labels: RecordLabels = { relevant: { value: true, confidence: 0.9, via: "hazard" }, has_place: { value: true, confidence: 0.8 } };
const rec = (id: string, text: string, extra: Partial<FloodRecord> = {}): FloodRecord => ({
  id, source: "csv", text, labels: {}, places: [], review: "auto", classifier: "heuristic", ...extra,
});

const a = await buildKey(profile, "Road  closed at\nBow River");
const b = await buildKey(profile, "  Road closed at Bow River ");
ok(a === b, "key ignores whitespace differences");
ok(a !== await buildKey(quake, "Road closed at Bow River"), "key depends on hazard");
ok(a !== await buildKey(profile, "road closed at bow river"), "key is case sensitive");
ok(a === await buildKey(profile, "Road closed at Bow River"), "key is stable");
ok(keyMaterial(profile, "x", "v").startsWith("flood|x|"), "key material layout");
ok(normalizeText("é") === "é", "NFC normalization");

const store = createMemoryStore();
const recs = [rec("1", "Bow River flooding"), rec("2", "Second post"), rec("3", "")];
const keys = new Map<string, string>();
for (const r of recs.slice(0, 2)) keys.set(r.id, await buildKey(profile, r.text));
await storeResults(store, keys, [
  rec("1", "Bow River flooding", { classifier: "jev", labels, modelVersion: "m1" }),
  rec("2", "Second post", { classifier: "heuristic", labels }),
]);
ok(store.size() === 1, "heuristic records are never cached");

const geo = () => [{ name: "Calgary", lat: 1, lon: 2, confidence: 0.9, method: "gazetteer" as const }];
const part = await partitionByCache(store, profile, recs, geo);
ok(part.hits.length === 1 && part.hits[0].id === "1", "one hit");
ok(part.misses.map((r) => r.id).join() === "2,3", "misses keep order, empty text is a miss");
const h = part.hits[0];
ok(h.classifier === "jev" && h.modelVersion === "m1" && h.places.length === 1 && h.labels === labels, "merge carries labels, version, places");
ok(Object.keys(recs[0].labels).length === 0, "input record not mutated");
const d = funnelDelta(part.hits);
ok(d.prefiltered === 1 && d.relevant === 1 && d.mappable === 1 && d.noPlaceMentioned === 0, "funnel delta");

const pii = mergeCached(rec("p", "call 555-123-4567", { rawText: "raw" }),
  { key: "k", labels: { ...labels, has_pii: { value: true, confidence: 1 } }, classifier: "jev", redactedText: "call [phone redacted]", ts: 1 }, []);
ok(pii.text === "call [phone redacted]" && pii.rawText === undefined, "PII redaction preserved");

await store.clear();
ok(store.size() === 0, "clear empties store");
const many = createMemoryStore();
await many.putMany(Array.from({ length: 5 }, (_, i) => ({ key: "k" + i, labels, classifier: "jev" as const, ts: i })), 3);
ok(many.size() === 3 && !(await many.getMany(["k0"])).has("k0"), "oldest evicted at cap");
ok(MAX_ENTRIES === 200_000, "cap constant");

const broken = { getMany: async () => { throw new Error("x"); }, putMany: async () => { throw new Error("x"); }, clear: async () => {} };
const p2 = await partitionByCache(broken, profile, recs, geo);
ok(p2.hits.length === 0 && p2.misses.length === 3, "throwing store degrades to no cache");
await storeResults(broken, keys, [rec("1", "t", { classifier: "jev", labels })]);
ok(true, "throwing write does not throw");

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
