"use client";

/**
 * The four front doors: a CSV, a photo, a pasted link or text, and speech.
 *
 * Deliberately leads with "Load the Alberta 2013 sample" -- a judge must never have to find a
 * file before they can see anything work. The other doors exist because the sponsor's actual
 * users are band-office staff and responders, who have a phone and a link, not a dataset.
 */

import { useEffect, useRef, useState } from "react";
import {
  FileCsv,
  Image as ImageIcon,
  Link as LinkIcon,
  Microphone,
  StopCircle,
  Spinner,
} from "@phosphor-icons/react/dist/ssr";

import type { EventProfile, FloodRecord, FunnelCounts } from "../lib/types";
import { CHUNK_THRESHOLD_BYTES, ingestLargeCsv, readIngestResponse } from "./chunkedIngest";

export interface IngestResult {
  records: FloodRecord[];
  profile: EventProfile;
  funnel: FunnelCounts;
  detectedColumns?: string[];
  chosenColumn?: string;
  mappedColumns?: Record<string, string | undefined>;
  duplicatesRemoved?: number;
}

/** Minimal shape of the Web Speech API we use. Not in TS lib types. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

const DEFAULT_SAMPLE_PATH = "/sample/alberta-2013.csv";

export function Intake({
  onIngest,
  onError,
  busy,
  lowBandwidth,
  onDemoLoad,
  onAdd,
}: {
  onIngest: (result: IngestResult) => void;
  onError: (message: string) => void;
  busy: boolean;
  lowBandwidth: boolean;
  /** Set in demo mode: Load replays fixtures and uploads make no network call. */
  onDemoLoad?: () => void;
  /** Single reports (link, typed, dictated, photo) are added to what is loaded, not a replacement. */
  onAdd?: (result: IngestResult) => void;
}) {
  const DEMO_UPLOAD_MESSAGE =
    "Demo mode is on, so nothing is sent to the classifier. Open the page without ?demo=1 to classify your own data.";
  const [pasted, setPasted] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);

  const post = async (label: string, body: FormData) => {
    setWorking(label);
    try {
      const res = await fetch("/api/ingest", { method: "POST", body });
      // Not res.json(): a 413 from the platform is plain text and threw "Unexpected token".
      const data = await readIngestResponse(res);
      if (!res.ok || data.error) {
        onError(data.error ?? `Ingest failed (${res.status}).`);
        return;
      }
      if (onAdd && (label === "link" || label === "text" || label === "image")) onAdd(data);
      else onIngest(data);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Ingest failed.");
    } finally {
      setWorking(null);
    }
  };

  const loadSample = async (path = DEFAULT_SAMPLE_PATH, name = "alberta-2013.csv") => {
    if (onDemoLoad) {
      // Only the Alberta sample has bundled fixtures; replaying them for the world feed would
      // look like it worked while showing the wrong data.
      if (path === DEFAULT_SAMPLE_PATH) onDemoLoad();
      else onError(DEMO_UPLOAD_MESSAGE);
      return;
    }
    setWorking("sample");
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`Sample not found (${res.status}).`);
      const file = new File([await res.blob()], name, { type: "text/csv" });

      // The world feed is 6 MB, over the single-request limit, so it takes the same chunked path
      // as any large upload. Going through it here means the one-click sample exercises the real
      // large-file code, instead of a shortcut that a judge's own big file would never get.
      if (file.size > CHUNK_THRESHOLD_BYTES) {
        onIngest(await ingestLargeCsv(file, undefined, () => {}));
        setWorking(null);
        return;
      }

      const form = new FormData();
      form.set("file", file);
      await post("sample", form);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load the sample.");
      setWorking(null);
    }
  };

  const onCsv = (file: File) => {
    if (onDemoLoad) {
      onError(DEMO_UPLOAD_MESSAGE);
      return;
    }
    if (file.size > CHUNK_THRESHOLD_BYTES) {
      setWorking("csv");
      void ingestLargeCsv(file, undefined, () => {})
        .then((merged) => onIngest(merged))
        .catch((err) => onError(err instanceof Error ? err.message : "Could not read the file."))
        .finally(() => setWorking(null));
      return;
    }
    const form = new FormData();
    form.set("file", file);
    void post("csv", form);
  };

  const onImages = (files: FileList) => {
    if (onDemoLoad) {
      onError(DEMO_UPLOAD_MESSAGE);
      return;
    }
    const form = new FormData();
    for (const file of Array.from(files)) form.append("images", file);
    void post("image", form);
  };

  /**
   * A pasted value is either a link or raw text. Links go through /api/resolve first, because
   * a blocked platform must come back as a clear "screenshot it instead" rather than a silent
   * failure. Multiple lines are treated as multiple records.
   */
  const submitPasted = async () => {
    if (onDemoLoad) {
      onError(DEMO_UPLOAD_MESSAGE);
      return;
    }
    const value = pasted.trim();
    if (!value) return;
    const looksLikeUrl = /^https?:\/\/\S+$/i.test(value);

    if (looksLikeUrl) {
      setWorking("link");
      try {
        const res = await fetch("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: value }),
        });
        const data = (await res.json()) as {
          text?: string;
          error?: string;
          detail?: string;
          needsScreenshot?: boolean;
        };
        if (res.status === 409 || data.needsScreenshot) {
          onError(
            `${data.detail ?? "That platform blocks automated reading."} Take a screenshot of the post and add it as an image instead.`,
          );
          return;
        }
        if (!res.ok || !data.text) {
          onError(data.error ?? data.detail ?? `Could not read that link (${res.status}).`);
          return;
        }
        const form = new FormData();
        form.set("text", data.text);
        await post("link", form);
        setPasted("");
      } catch (err) {
        onError(err instanceof Error ? err.message : "Could not read that link.");
      } finally {
        setWorking(null);
      }
      return;
    }

    const form = new FormData();
    form.set("text", value);
    if (value.includes("\n")) form.set("split", "lines");
    await post("text", form);
    setPasted("");
  };

  /**
   * Speech input. This is a front door, not a checkbox: it serves low literacy, cold hands
   * outdoors, and anyone who would rather talk than type into a phone in the rain.
   * Disabled in low-bandwidth mode because Chrome uploads the audio to Google.
   */
  // Resolved in an effect, not during render. Reading `window` while rendering makes the
  // server produce different HTML from the client and React throws a hydration error (#418),
  // which was happening on every page load.
  const [speechSupported, setSpeechSupported] = useState(false);
  useEffect(() => {
    setSpeechSupported(
      Boolean(
        (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
          (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition,
      ),
    );
  }, []);

  const toggleListening = () => {
    if (listening) {
      recognition.current?.stop();
      setListening(false);
      return;
    }
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;
    if (!Ctor) return;

    const instance = new Ctor();
    instance.lang = "en-CA";
    instance.continuous = false;
    instance.interimResults = false;
    instance.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) setPasted((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    instance.onerror = () => setListening(false);
    instance.onend = () => setListening(false);
    instance.start();
    recognition.current = instance;
    setListening(true);
  };

  const disabled = busy || working !== null;

  return (
    <section aria-labelledby="intake-heading" className="flex flex-col gap-3 p-4">
      <h2 id="intake-heading" className="text-sm font-medium" style={{ color: "var(--text-muted)" }}>
        Add reports
      </h2>

      <div className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
        <h3 className="font-medium" style={{ color: "var(--text)" }}>
          Who this is for
        </h3>
        <ul className="flex flex-col gap-1">
          <li>
            <span className="font-medium" style={{ color: "var(--text)" }}>Community members:</span>{" "}
            See if flooding is reaching your area, and who is asking for help.
          </li>
          <li>
            <span className="font-medium" style={{ color: "var(--text)" }}>Leaders:</span>{" "}
            See which communities and roads are affected and what to act on first.
          </li>
          <li>
            <span className="font-medium" style={{ color: "var(--text)" }}>Emergency responders:</span>{" "}
            See the most urgent posts first, with how sure we are about each place.
          </li>
        </ul>
        <p>
          Firsthand posts often appear before official data. Every result here is a proposal with a
          confidence, never a confirmed fact.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void loadSample()}
        disabled={disabled}
        className="flex items-center justify-center gap-2 rounded px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
        style={{ borderRadius: "var(--radius)" }}
      >
        {working === "sample" ? <Spinner size={15} className="animate-spin" aria-hidden /> : null}
        Load Alberta 2013 sample
      </button>

      <button
        type="button"
        onClick={() => void loadSample("/sample/bonus-global.csv", "bonus-global.csv")}
        disabled={disabled}
        className="flex items-center justify-center gap-2 rounded px-3 py-2 text-sm transition-colors disabled:opacity-50 border border-[var(--line-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-sunken)]"
        style={{ borderRadius: "var(--radius)" }}
        title="61,159 posts about many kinds of disaster worldwide. Mixed files are focused on floods."
      >
        Load world feed (61,159 posts)
      </button>

      <div className="grid grid-cols-2 gap-2">
        <FileButton
          label="CSV"
          icon={<FileCsv size={15} aria-hidden />}
          accept=".csv,text/csv,text/plain"
          disabled={disabled}
          busy={working === "csv"}
          onPick={(files) => onCsv(files[0])}
        />
        <FileButton
          label="Photo"
          icon={<ImageIcon size={15} aria-hidden />}
          accept="image/*"
          multiple
          disabled={disabled}
          busy={working === "image"}
          onPick={(files) => onImages(files)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="paste" className="text-sm" style={{ color: "var(--text-muted)" }}>
          Paste a link or type a report
        </label>
        <div className="flex gap-1.5">
          <input
            id="paste"
            name="report"
            type="text"
            autoComplete="off"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitPasted();
            }}
            placeholder="https://x.com/… or: the bridge on Highway 11 is under water"
            disabled={disabled}
            className="min-w-0 flex-1 rounded px-2 py-1.5 text-sm"
            style={{
              background: "var(--surface-raised)",
              border: "1px solid var(--line-strong)",
              color: "var(--text)",
              borderRadius: "var(--radius)",
            }}
          />
          {speechSupported && !lowBandwidth && (
            <button
              type="button"
              onClick={toggleListening}
              disabled={disabled}
              aria-pressed={listening}
              aria-label={listening ? "Stop dictation" : "Dictate a report"}
              title={
                listening
                  ? "Stop dictation"
                  : "Dictate a report. Chrome sends the audio to Google, so this is off in low-bandwidth mode."
              }
              className="rounded px-2 transition-colors hover:brightness-95"
              style={{
                border: listening ? "1px solid var(--urgent)" : "1px solid var(--line-strong)",
                background: listening ? "var(--urgent-weak)" : "var(--surface-raised)",
                color: listening ? "var(--urgent)" : "var(--text-muted)",
                borderRadius: "var(--radius)",
              }}
            >
              {/* While recording: a stop button (square in a circle), the universal "tap to stop"
                  shape; back to the mic once stopped. */}
              {listening ? <StopCircle size={18} weight="fill" aria-hidden /> : <Microphone size={15} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            onClick={() => void submitPasted()}
            disabled={disabled || !pasted.trim()}
            className="inline-flex items-center gap-1 rounded px-2.5 text-sm transition-colors disabled:opacity-40 border border-[var(--line-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-sunken)]"
            style={{ borderRadius: "var(--radius)" }}
          >
            {working === "link" || working === "text" ? (
              <Spinner size={15} className="animate-spin" aria-hidden />
            ) : (
              <LinkIcon size={15} aria-hidden />
            )}
            <span className="text-sm">Add</span>
          </button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-faint)" }}>
          X, Bluesky and Mastodon links resolve directly. Facebook, Instagram and Reddit block
          automated reading, so screenshot those and add the image.
          {speechSupported && !lowBandwidth && (
            <> Dictation uses your browser&apos;s speech service: Chrome sends the audio to Google.</>
          )}
        </p>
      </div>
    </section>
  );
}

function FileButton({
  label,
  icon,
  accept,
  multiple,
  disabled,
  busy,
  onPick,
}: {
  label: string;
  icon: React.ReactNode;
  accept: string;
  multiple?: boolean;
  disabled: boolean;
  busy: boolean;
  onPick: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm transition-colors disabled:opacity-50 border border-[var(--line-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-sunken)]"
        style={{ borderRadius: "var(--radius)" }}
      >
        {busy ? <Spinner size={15} className="animate-spin" aria-hidden /> : icon}
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        aria-label={`Upload ${label}`}
        onChange={(e) => {
          if (e.target.files?.length) onPick(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}
