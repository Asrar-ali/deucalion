/**
 * Byte-level decoding for uploaded files. A judge's CSV arrives as raw bytes with no
 * declared encoding. Excel on Windows still emits windows-1252 for anything typed by a
 * human (curly quotes, accented names); some government/band-office export tools emit
 * UTF-16 with or without a BOM. Get this wrong and lib/csv.ts never sees valid text:
 * a UTF-16 file decoded as UTF-8 becomes NUL-interleaved garbage, and a BOM left on the
 * front of a UTF-8 file corrupts the first header name so every column lookup silently
 * misses it.
 *
 * This must run once, on the raw bytes, before parseCsv ever sees a string.
 */

export type DecodeConfidence = "certain" | "guessed";

export interface DecodedText {
  text: string;
  encoding: string;
  confidence: DecodeConfidence;
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * BOM-less UTF-16LE detector. ASCII/Latin text in UTF-16LE puts a 0x00 high byte after
 * almost every code unit, so zero bytes cluster at odd offsets and are rare at even
 * offsets. A real UTF-8 or windows-1252 file of ordinary text essentially never has this
 * shape, so the asymmetry is a reliable signature without needing a full charset library.
 */
function looksLikeUtf16LeNoBom(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 1024) & ~1; // even length for clean pairs
  if (sampleLen < 16) return false;

  let zeroAtOdd = 0;
  let zeroAtEven = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 1) zeroAtOdd++;
    else zeroAtEven++;
  }
  const halves = sampleLen / 2;
  return zeroAtOdd / halves > 0.5 && zeroAtEven / halves < 0.1;
}

function lossyUtf8(bytes: Uint8Array): DecodedText {
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), encoding: "utf-8", confidence: "guessed" };
}

export function decodeBytes(bytes: ArrayBuffer | Uint8Array): DecodedText {
  const buf = toBytes(bytes);

  try {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return {
        text: new TextDecoder("utf-8").decode(buf.subarray(3)),
        encoding: "utf-8",
        confidence: "certain",
      };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return {
        text: new TextDecoder("utf-16le").decode(buf.subarray(2)),
        encoding: "utf-16le",
        confidence: "certain",
      };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return {
        text: new TextDecoder("utf-16be").decode(buf.subarray(2)),
        encoding: "utf-16be",
        confidence: "certain",
      };
    }

    if (looksLikeUtf16LeNoBom(buf)) {
      return { text: new TextDecoder("utf-16le").decode(buf), encoding: "utf-16le", confidence: "guessed" };
    }

    // Strict UTF-8 first: if every byte sequence is valid UTF-8, trust it completely.
    // Only fall back to windows-1252 when strict decoding actually throws, since guessing
    // wrong the other way around would mangle real UTF-8 (emoji, CJK, accented names).
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return { text, encoding: "utf-8", confidence: "certain" };
    } catch {
      // Not valid UTF-8. windows-1252 is what Excel on Windows actually emits, and what
      // most municipal and band-office exports turn out to be in practice.
      const text = new TextDecoder("windows-1252").decode(buf);
      return { text, encoding: "windows-1252", confidence: "guessed" };
    }
  } catch {
    // Never throw out of ingest over an encoding guess. Worst case, hand back the lossy
    // UTF-8 decode (replacement characters for anything invalid) rather than failing closed.
    return lossyUtf8(buf);
  }
}
