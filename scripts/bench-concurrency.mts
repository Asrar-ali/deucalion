// Measures Jev throughput at several concurrency levels. Costs a few cents. Never prints the key.
// Run: node --env-file=.env.local --import tsx scripts/bench-concurrency.mts
import { buildQuestions } from "../lib/questions";
import { decideWithRetry, mapConcurrent } from "../lib/systemone";
import { detectEventProfile } from "../lib/prefilter";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

const texts = [
  "Bridge on Highway 22 is washed out, water over the road #flood",
  "Tornado warning issued for the county, take cover now",
  "Anyone need sandbags near Elbow River? We have a truck",
  "Great game last night, what a finish",
  "Wildfire smoke is heavy in the valley, evacuations ordered",
  "Rivers rising fast in Bundaberg, residents told to leave",
];
const profile = detectEventProfile(texts, {} as never);
const questions = buildQuestions({ ...profile, hazard: "flood" });

for (const [level, n] of [[20, 200], [60, 400], [100, 500]] as const) {
  const items = Array.from({ length: n }, (_, i) => `${texts[i % texts.length]} (${i})`);
  const t0 = Date.now();
  const out = await mapConcurrent(items, level, (t) => decideWithRetry(t, questions, { apiKey }));
  const secs = (Date.now() - t0) / 1000;
  const errs = out.filter((r) => r instanceof Error) as Error[];
  console.log(
    `conc ${level}: ${n} calls in ${secs.toFixed(1)}s = ${(n / secs).toFixed(0)}/s, errors ${errs.length}`,
    errs[0] ? errs[0].message.slice(0, 80) : "",
  );
}
