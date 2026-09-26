"use client";

/**
 * Free-text Q&A over the posts currently in view. A convenience layered on top of the map,
 * filters and summary -- never their replacement, per the graceful-failure contract those
 * views already follow (lib/summarize.ts narrate()). The client selects a relevant, roughly
 * on-topic subset of at most 200 posts and sends it stateless to POST /api/ask; the server
 * answers only from what was sent and cites its sources, which is why every sentence below
 * carries citation chips instead of being trusted on its own.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { computeAskFacts, selectRecordsForQuestion } from "../lib/askFacts";
import type { FloodRecord } from "../lib/types";

const MAX_RECORDS = 60;

const SUGGESTIONS = [
  "Which roads or bridges are reported closed?",
  "What do people need most right now?",
  "Which communities are mentioned, and what is happening there?",
] as const;

const NO_ANSWER_MESSAGE = "The loaded posts don't answer that. Try the filters or the summary.";

interface AskSentence {
  sentence: string;
  citedRecordIds: string[];
}

interface HistoryItem {
  id: string;
  question: string;
  sentences: AskSentence[];
  used: number;
  totalLoaded: number;
  sources: Record<string, string>;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AskPanel({
  records,
  onSelectRecord,
  demo = false,
}: {
  records: FloodRecord[];
  onSelectRecord: (id: string) => void;
  demo?: boolean;
}) {
  const headingId = useId();
  const questionId = useId();

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [readingCount, setReadingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // Keep the question in the box after an answer, selected so retyping replaces it.
  useEffect(() => {
    if (!loading && history.length > 0) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [loading, history.length]);

  const relevantRecords = useMemo(
    () => records.filter((r) => r.labels.relevant?.value === true),
    [records],
  );

  async function ask(rawQuestion: string) {
    const q = rawQuestion.trim();
    if (loading) return;
    if (q.length < 3 || q.length > 300) {
      setError("Ask a question between 3 and 300 characters.");
      return;
    }

    const selected = selectRecordsForQuestion(q, records, MAX_RECORDS);
    const facts = computeAskFacts(q, records);
    setError(null);
    setLoading(true);
    setReadingCount(selected.length);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, records: selected, facts }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data) {
        setError(
          (data && data.error) ||
            `Ask failed (${res.status}). Try again in a moment, or use the Summary page.`,
        );
        return;
      }

      setHistory((h) => [
        {
          id: newId(),
          question: q,
          sentences: data.answer ?? [],
          used: data.used ?? selected.length,
          totalLoaded: data.totalLoaded ?? records.length,
          sources: data.sources ?? {},
        },
        ...h,
      ]);
    } catch (err) {
      setError(
        err instanceof Error
          ? `${err.message} Try again in a moment, or use the Summary page.`
          : "Ask failed. Try again in a moment, or use the Summary page.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  function handleSuggestion(text: string) {
    setQuestion(text);
    void ask(text);
  }

  return (
    <section aria-labelledby={headingId} className="text-sm" style={{ color: "var(--text)" }}>
      <h2 id={headingId} className="text-sm font-semibold">
        Ask about these posts
      </h2>

      {demo ? (
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          Ask needs the live service. Open the page without ?demo=1 to use it.
        </p>
      ) : relevantRecords.length === 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          Load and classify posts first.
        </p>
      ) : (
        <>
          <form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-2">
            <label htmlFor={questionId} className="text-sm font-medium">
              Your question
            </label>
            <textarea
              ref={textareaRef}
              id={questionId}
              name="question"
              autoComplete="off"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={loading}
              rows={3}
              className="w-full rounded text-sm p-2 border border-[var(--line-strong)] bg-[var(--surface-raised)] text-[var(--text)]"
            />
            <div>
              <button
                type="submit"
                disabled={loading}
                className="rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
              >
                Ask
              </button>
            </div>
          </form>

          <div className="mt-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={loading}
                onClick={() => handleSuggestion(s)}
                className="rounded px-2 py-1 text-sm text-left transition-colors disabled:opacity-50 border border-[var(--line-strong)] bg-[var(--surface-raised)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]"
              >
                {s}
              </button>
            ))}
          </div>

          {loading ? (
            <p className="mt-2 text-sm" aria-live="polite" style={{ color: "var(--text-muted)" }}>
              Reading {readingCount} posts. Answers can take up to 30 seconds.
            </p>
          ) : null}

          {error ? (
            <p
              ref={errorRef}
              tabIndex={-1}
              className="mt-2 text-sm"
              role="alert"
              style={{ color: "var(--urgent)" }}
            >
              {error}
            </p>
          ) : null}

          <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>
            Answers are written by a language model from the most relevant loaded posts. Totals and counts are computed exactly from every loaded post, not by the model. Every
            sentence links to the posts it came from; sentences without a source are removed.
            Questions and post text are sent to the event&apos;s Gemini service, which keeps logs.
          </p>

          {history.length > 0 ? (
            <ol className="mt-3 flex flex-col gap-3 list-none p-0 m-0">
              {history.map((item) => (
                <li key={item.id} className="pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                  <p className="text-sm font-medium">{item.question}</p>
                  <p className="text-xs" style={{ color: "var(--text-faint)" }}>
                    Read {item.used} most relevant posts of {item.totalLoaded} loaded
                  </p>
                  {item.sentences.length === 0 ? (
                    <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
                      {NO_ANSWER_MESSAGE}
                    </p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-1 list-none p-0 m-0">
                      {item.sentences.map((s, i) => (
                        <li key={i} className="text-sm">
                          {s.sentence}{" "}
                          {s.citedRecordIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => onSelectRecord(id)}
                              aria-label={`Open cited post: ${item.sources[id] ?? id}`}
                              title={item.sources[id] ?? id}
                              className="text-xs rounded px-1 ml-1 align-middle transition-colors hover:bg-[var(--accent-weak)]"
                              style={{ border: "1px solid var(--line-strong)", color: "var(--accent)" }}
                            >
                              {item.sources[id] ?? id}
                            </button>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}
    </section>
  );
}
