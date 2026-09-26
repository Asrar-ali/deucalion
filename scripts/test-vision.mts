/**
 * Real test for lib/exif.ts and lib/vision.ts.
 *
 *   npx tsx scripts/test-vision.mts
 *
 * EXIF assertions (offline, deterministic, no network): hand-built JPEG buffers with a
 * minimal TIFF/EXIF/GPS block, plus a hand-built PNG with no EXIF at all.
 * Vision assertions (live): a small synthetic PNG sent to Gemini through describeImage and
 * readImageText. Then GEMINI_API_KEY is unset in-process to prove both functions degrade to
 * null instead of throwing.
 */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// Same minimal .env.local loader used by scripts/smoke.mjs and scripts/test-routes.mts.
try {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  console.error("No .env.local found. Create it from .env.example first.");
  process.exit(1);
}

const problems: string[] = [];

function check(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    problems.push(label);
  }
}

// ---------------------------------------------------------------------------
// Byte-level test fixtures — no image library is installed, so these are hand-built.
// ---------------------------------------------------------------------------

function asciiField(str: string): Buffer {
  return Buffer.concat([Buffer.from(str, "ascii"), Buffer.from([0])]);
}

function ifdEntry(tag: number, type: number, count: number, valueOrOffset: number | Buffer): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt16LE(tag, 0);
  buf.writeUInt16LE(type, 2);
  buf.writeUInt32LE(count, 4);
  if (Buffer.isBuffer(valueOrOffset)) {
    valueOrOffset.copy(buf, 8);
  } else {
    buf.writeUInt32LE(valueOrOffset, 8);
  }
  return buf;
}

function rational(num: number, den: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(num, 0);
  b.writeUInt32LE(den, 4);
  return b;
}

function inlineAscii2(ch: string): Buffer {
  const b = Buffer.alloc(4);
  b.write(ch, 0, "ascii");
  return b;
}

/**
 * Builds a minimal (non-renderable, but structurally valid enough for exifr) JPEG: just
 * SOI + an APP1/Exif segment carrying a TIFF IFD0 (Make/Model/DateTime + a GPS IFD pointer)
 * + EOI. exifr only needs to walk markers up to the metadata it cares about, so no SOF/SOS
 * scan data is required.
 */
function buildExifJpeg(opts: {
  latDeg: number;
  latRef: "N" | "S";
  lonDeg: number;
  lonRef: "E" | "W";
}): Buffer {
  const make = asciiField("TestCam");
  const model = asciiField("Model1");
  const date = asciiField("2024:06:15 12:30:00");

  const tiffHeader = Buffer.alloc(8);
  tiffHeader.write("II", 0, "ascii");
  tiffHeader.writeUInt16LE(42, 2);
  tiffHeader.writeUInt32LE(8, 4);

  const ifd0EntryCount = 4;
  const ifd0Start = 8;
  const ifd0HeaderSize = 2 + ifd0EntryCount * 12 + 4;
  const extraStart = ifd0Start + ifd0HeaderSize;

  const makeOffset = extraStart;
  const modelOffset = makeOffset + make.length;
  const dateOffset = modelOffset + model.length;
  const gpsIfdOffset = dateOffset + date.length;

  const ifd0 = Buffer.alloc(ifd0HeaderSize);
  let o = 0;
  ifd0.writeUInt16LE(ifd0EntryCount, o);
  o += 2;
  ifdEntry(0x010f, 2, make.length, makeOffset).copy(ifd0, o);
  o += 12;
  ifdEntry(0x0110, 2, model.length, modelOffset).copy(ifd0, o);
  o += 12;
  ifdEntry(0x0132, 2, date.length, dateOffset).copy(ifd0, o);
  o += 12;
  ifdEntry(0x8825, 4, 1, gpsIfdOffset).copy(ifd0, o);
  o += 12;
  ifd0.writeUInt32LE(0, o);

  const extra = Buffer.concat([make, model, date]);

  const gpsEntryCount = 4;
  const gpsHeaderSize = 2 + gpsEntryCount * 12 + 4;
  const gpsExtraStart = gpsIfdOffset + gpsHeaderSize;
  const latOffset = gpsExtraStart;
  const lonOffset = latOffset + 24;

  const latRational = Buffer.concat([rational(opts.latDeg, 1), rational(0, 1), rational(0, 1)]);
  const lonRational = Buffer.concat([rational(opts.lonDeg, 1), rational(0, 1), rational(0, 1)]);

  const gpsIfd = Buffer.alloc(gpsHeaderSize);
  o = 0;
  gpsIfd.writeUInt16LE(gpsEntryCount, o);
  o += 2;
  ifdEntry(0x0001, 2, 2, inlineAscii2(opts.latRef)).copy(gpsIfd, o);
  o += 12;
  ifdEntry(0x0002, 5, 3, latOffset).copy(gpsIfd, o);
  o += 12;
  ifdEntry(0x0003, 2, 2, inlineAscii2(opts.lonRef)).copy(gpsIfd, o);
  o += 12;
  ifdEntry(0x0004, 5, 3, lonOffset).copy(gpsIfd, o);
  o += 12;
  gpsIfd.writeUInt32LE(0, o);

  const gpsExtra = Buffer.concat([latRational, lonRational]);

  const tiff = Buffer.concat([tiffHeader, ifd0, extra, gpsIfd, gpsExtra]);
  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const app1Payload = Buffer.concat([exifHeader, tiff]);
  const app1LenBuf = Buffer.alloc(2);
  app1LenBuf.writeUInt16BE(app1Payload.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), app1LenBuf, app1Payload]);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

// Minimal CRC32 for hand-rolled PNG chunks. No image library is installed in this project.
let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** A tiny valid grayscale PNG with a two-band pattern — enough for a real Gemini call. */
function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 0; // color type: grayscale
  const ihdr = pngChunk("IHDR", ihdrData);

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const shade = y < height / 2 ? 40 : 220; // two bands, so it isn't a flat single colour
    rows.push(Buffer.from([0, ...Array(width).fill(shade)]));
  }
  const idat = pngChunk("IDAT", deflateSync(Buffer.concat(rows)));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// 1. EXIF — offline, deterministic
// ---------------------------------------------------------------------------

async function testExif() {
  console.log("\n=== lib/exif.ts (offline)\n");
  const { readImageMeta } = await import("../lib/exif");

  const validJpeg = buildExifJpeg({ latDeg: 51, latRef: "N", lonDeg: 114, lonRef: "W" });
  const meta = await readImageMeta(validJpeg);
  console.log("  valid JPEG ->", meta);
  check(meta.lat === 51, "valid GPS: lat extracted correctly (51)");
  check(meta.lon === -114, "valid GPS: lon extracted correctly (-114, W is negative)");
  check(typeof meta.timestamp === "string" && !Number.isNaN(Date.parse(meta.timestamp)), "valid GPS: timestamp is a parseable ISO 8601 string");
  check(meta.make === "TestCam", "valid GPS: make extracted");
  check(meta.model === "Model1", "valid GPS: model extracted");

  const zeroJpeg = buildExifJpeg({ latDeg: 0, latRef: "N", lonDeg: 0, lonRef: "E" });
  const zeroMeta = await readImageMeta(zeroJpeg);
  console.log("  (0,0) JPEG ->", zeroMeta);
  check(zeroMeta.lat === undefined && zeroMeta.lon === undefined, "(0,0) sentinel is rejected, not returned as a coordinate");

  const png = buildPng(4, 4);
  const pngMeta = await readImageMeta(png);
  console.log("  no-EXIF PNG ->", pngMeta);
  check(Object.keys(pngMeta).length === 0, "PNG with no EXIF returns {} without throwing");

  const garbage = Buffer.from("this is not an image at all, just text bytes");
  let garbageThrew = false;
  let garbageMeta: unknown;
  try {
    garbageMeta = await readImageMeta(garbage);
  } catch {
    garbageThrew = true;
  }
  console.log("  garbage bytes ->", garbageMeta);
  check(!garbageThrew, "corrupt/non-image input does not throw");
}

// ---------------------------------------------------------------------------
// 2. Vision — live
// ---------------------------------------------------------------------------

async function testVisionLive() {
  console.log("\n=== lib/vision.ts (live Gemini call)\n");
  const { describeImage, readImageText } = await import("../lib/vision");

  const png = buildPng(64, 64);

  const description = await describeImage(png, "image/png");
  console.log("  describeImage result:", JSON.stringify(description, null, 2));
  check(description !== null, "describeImage returned a non-null result with a real key");
  if (description) {
    check(typeof description.altText === "string" && description.altText.length > 0, "altText is a non-empty string");
    check(description.altText.length <= 200, "altText is truncated to <=200 chars");
    check(!/\b(verified|confirmed)\b/i.test(description.altText), "altText does not contain banned words verified/confirmed");
    check(typeof description.confidence === "number" && description.confidence >= 0 && description.confidence <= 1, "confidence is within 0..1");
    check(Array.isArray(description.submerged), "submerged is an array");
  }

  const ocr = await readImageText(png, "image/png");
  console.log("  readImageText result:", JSON.stringify(ocr, null, 2));
  check(ocr !== null, "readImageText returned a non-null result with a real key");
  if (ocr) {
    check(typeof ocr.text === "string", "OCR text is a string (may be empty for a synthetic image)");
    check(typeof ocr.isScreenshot === "boolean", "isScreenshot is a boolean");
  }
}

// ---------------------------------------------------------------------------
// 3. Degradation — key removed in-process
// ---------------------------------------------------------------------------

async function testDegradation() {
  console.log("\n=== degradation (GEMINI_API_KEY unset in-process)\n");
  // vision.ts reads process.env.GEMINI_API_KEY fresh on every call (no module-level client
  // cache), specifically so this in-process flip is a valid test of the degrade path.
  const { describeImage, readImageText } = await import("../lib/vision");

  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const png = buildPng(4, 4);

    const description = await describeImage(png, "image/png");
    console.log("  describeImage with no key ->", description);
    check(description === null, "describeImage returns null when GEMINI_API_KEY is missing");

    const ocr = await readImageText(png, "image/png");
    console.log("  readImageText with no key ->", ocr);
    check(ocr === null, "readImageText returns null when GEMINI_API_KEY is missing");
  } finally {
    if (savedKey) process.env.GEMINI_API_KEY = savedKey;
  }
}

await testExif();
await testVisionLive();
await testDegradation();

console.log("\n=== summary");
if (problems.length) {
  console.log(`${problems.length} check(s) FAILED:`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
} else {
  console.log("all checks passed");
}
