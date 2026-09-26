// Times a small grounded Q&A prompt across proxy models. Uses ~4 of the proxy quota. Never prints keys.
// Run: node --env-file=.env.local --import tsx scripts/probe-ask-models.mts
import { generateText } from "../lib/llm";

const prompt =
  "Answer in one short sentence using only these posts.\nPosts:\n1. Bridge on Hwy 22 washed out near Turner Valley.\n2. Need sandbags in Bowness, please help.\n3. Siksika Nation declared a state of emergency.\nQuestion: Where do people need help?";

for (const model of ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]) {
  const t0 = Date.now();
  try {
    const out = await generateText(prompt, { timeoutMs: 60000, model });
    console.log(model, ((Date.now() - t0) / 1000).toFixed(1) + "s", JSON.stringify(String(out).slice(0, 90)));
  } catch (e) {
    console.log(model, ((Date.now() - t0) / 1000).toFixed(1) + "s", "ERR", String((e as Error).message).slice(0, 90));
  }
}
