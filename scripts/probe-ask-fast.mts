// Times the OpenRouter fast path for Ask. Run: node --env-file=.env.local --import tsx scripts/probe-ask-fast.mts
import { generateJsonFast } from "../lib/llm";
const schema = { type: "object", properties: { answer: { type: "array", items: { type: "object", properties: { sentence: { type: "string" }, citedRecordIds: { type: "array", items: { type: "string" } } }, required: ["sentence", "citedRecordIds"] } } }, required: ["answer"] };
const prompt = "Answer using only these posts, as JSON with sentences and the ids you cite.\nPosts:\nc1: Bridge on Hwy 22 washed out near Turner Valley.\nc2: Need sandbags in Bowness, please help.\nc3: Siksika Nation declared a state of emergency.\nQuestion: Where do people need help?";
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  const out = await generateJsonFast(prompt, schema);
  console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", JSON.stringify(out).slice(0, 200));
}
