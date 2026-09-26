/**
 * POST /api/ask -- answer a free-text question against the posts the client currently
 * holds, citing record ids that were actually sent.
 *
 * Stateless, per docs/CONTRACT.md and the sibling /api/summarize route: the client posts
 * the records it holds (already filtered to whatever is "currently relevant" in its view),
 * the server computes an answer and returns it, nothing is kept. Mirrors lib/summarize.ts's
 * narrate(): the model call is a convenience layered over provided data, and the
 * anti-fabrication guarantee is enforced in code (enforceCitations), never trusted from the
 * prompt alone.
 */

import { generateJson } from "../../../lib/llm";
import { enforceCitations } from "../../../lib/summarize";
import type { EventProfile, FloodRecord } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECORDS = 200;
const MIN_QUESTION_LEN = 3;
const MAX_QUESTION_LEN = 300;

interface AskBody {
  question: string;
  records: FloodRecord[];
  profile?: EventProfile;
}

function isValidBody(value: unknown): value is AskBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.question !== "string") return false;
  if (!Array.isArray(v.records)) return false;
  return true;
}

/** Model-facing view of a record. No rawText, ever. */
interface AskInputRecord {
  id: string;
  text: string;
  category?: string;
  severity?: number;
  place?: string;
}

function buildContext(records: FloodRecord[]): AskInputRecord[] {
  return records.map((r) => ({
    id: r.id,
    text: r.text,
    category: r.labels.category?.value,
    severity: r.labels.severity?.value,
    place: r.places[0]?.name,
  }));
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" },
          citedRecordIds: { type: "array", items: { type: "string" } },
        },
        required: ["sentence", "citedRecordIds"],
      },
    },
  },
  required: ["answer"],
};

interface AskResponseShape {
  answer: Array<{ sentence: string; citedRecordIds: string[] }>;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body." }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return Response.json(
      { error: "Expected { question: string, records: FloodRecord[], profile?: EventProfile }." },
      { status: 400 },
    );
  }

  const question = body.question.trim();
  if (question.length < MIN_QUESTION_LEN || question.length > MAX_QUESTION_LEN) {
    return Response.json(
      { error: `question must be between ${MIN_QUESTION_LEN} and ${MAX_QUESTION_LEN} characters.` },
      { status: 400 },
    );
  }

  // Cap server-side too: the client already selects at most 200, but the server is the
  // actual boundary that protects the prompt size and the event's request quota.
  const records = body.records.slice(0, MAX_RECORDS);
  const inputRecords = buildContext(records);
  const allowedIds = new Set(inputRecords.map((r) => r.id));

  const contextLines = inputRecords
    .map((r, i) => {
      const bits = [
        r.category ? `category=${r.category}` : undefined,
        r.severity != null ? `severity=${r.severity.toFixed(2)}` : undefined,
        r.place ? `place=${r.place}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `${i + 1}. [id=${r.id}]${bits ? ` (${bits})` : ""} ${r.text}`;
    })
    .join("\n");

  const systemInstruction =
    "You answer a question about a set of flood-report social media posts, for emergency " +
    "responders and First Nations community staff. Answer the question ONLY using the " +
    "numbered posts given below -- never use outside knowledge, never guess. Write 1 to 5 " +
    "short, factual sentences. Every sentence MUST include citedRecordIds: 1 to 4 record " +
    "ids drawn ONLY from the ids given in the posts -- never invent an id, never cite an id " +
    "not listed. If the posts do not answer the question, output exactly one sentence saying " +
    "so, with an empty citedRecordIds array. These are unverified public posts, not official " +
    "records: never use the words 'verified', 'confirmed', or 'real-time'. Never state a " +
    "number of people affected, injured, or displaced -- count posts, not people, if you " +
    "must count anything. Output only sentences you can support with the given record ids.";

  const prompt =
    systemInstruction +
    "\n\nQuestion: " +
    question +
    "\n\nPosts:\n" +
    (contextLines || "(no posts provided)");

  const parsed = await generateJson<AskResponseShape>(prompt, RESPONSE_SCHEMA);

  if (!parsed) {
    return Response.json(
      { error: "The answer service is unavailable right now. The map, filters and summary still work." },
      { status: 503 },
    );
  }

  const { kept, dropped } = enforceCitations(parsed.answer, allowedIds);
  if (dropped.length) {
    console.warn(
      `ask: dropped ${dropped.length} sentence(s): ${dropped.map((d) => d.reason).join("; ")}`,
    );
  }

  return Response.json({ answer: kept, used: records.length });
}
