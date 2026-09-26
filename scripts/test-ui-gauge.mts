import { resolveGauge } from "../components/gaugeState";

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok  ${message}`);
  else { failures++; console.log(`  FAIL  ${message}`); }
}

const yes = { value: true, confidence: 0.88 };
const base = { gate: 0.6, classifier: "jev" as const, review: "auto" as const, answer: "Sure it's about the flood" };

assert(resolveGauge({ ...base, decision: yes }).state === "measured", "0.88 above 0.6 is measured");
const below = resolveGauge({ ...base, decision: { value: true, confidence: 0.42 } });
assert(below.state === "below" && below.label === "Needs checking", "0.42 below 0.6 needs checking");
assert(below.ariaText.includes("below the review line"), "aria text says below the review line");
assert(resolveGauge({ ...base, decision: undefined }).state === "pending", "no decision is pending");
const heur = resolveGauge({ ...base, classifier: "heuristic", decision: { value: false, confidence: 0.7 } });
assert(heur.state === "no-reading" && heur.level === 0, "heuristic shows no reading and no fill");
assert(resolveGauge({ ...base, review: "confirmed", decision: yes }).state === "checked", "confirmed is checked");
assert(resolveGauge({ ...base, review: "rejected", decision: yes }).state === "rejected", "rejected wins over everything");
assert(resolveGauge({ ...base, decision: { value: true, confidence: 1.4 } }).level === 1, "confidence is clamped to 1");
assert(resolveGauge({ ...base, decision: yes }).number === "0.88", "number is two decimals");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
