/**
 * Table-driven edge-case tests for lib/csv.ts and lib/decode.ts.
 *
 * Judges upload a file we have never seen. This script exists to make that survivable:
 * every known way a real-world CSV goes sideways (encoding, delimiter, header shape,
 * ragged rows, hostile cell content) gets a case here, with a concrete assertion, not a
 * "looks fine" eyeball check.
 *
 *   npx tsx scripts/test-csv-edges.mts
 */

import { parseCsv, type ParsedCsv } from "../lib/csv";
import { decodeBytes } from "../lib/decode";

interface Case {
  name: string;
  run: () => string | null; // null = pass, string = failure reason
}

const cases: Case[] = [];
function test(name: string, run: () => string | null) {
  cases.push({ name, run });
}

function fail(reason: string): string {
  return reason;
}

// ---------------------------------------------------------------------------
// 1-4: delimiter sniffing on well-formed, unambiguous multi-column files
// ---------------------------------------------------------------------------

test("1. normal comma CSV, tweet column", () => {
  const csv = "tweet\nRoad closed near the river\nEverything is fine here";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rejected.length !== 0) return fail(`unexpected rejects: ${JSON.stringify(r.rejected)}`);
  return null;
});

test("2. semicolon-delimited (European Excel default)", () => {
  const csv = "id;tweet\n1;Highway is flooded, avoid it\n2;All clear downtown";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== "Highway is flooded, avoid it") return fail(`text=${r.rows[0].text}`);
  return null;
});

test("3. tab-delimited", () => {
  const csv = "tweet\tother\nBridge is under water\tx\nAll quiet\ty";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  return null;
});

test("4. pipe-delimited", () => {
  const csv = "tweet|other\nEvacuation ordered downtown|x\nNothing to report|y";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  return null;
});

// ---------------------------------------------------------------------------
// 5-7: byte-level encodings, via decodeBytes -- the whole point of these three
// ---------------------------------------------------------------------------

test("5. UTF-8 BOM present", () => {
  const csvText = "tweet\nWater is rising fast near the levee\n";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvText, "utf8")]);
  const decoded = decodeBytes(bytes);
  if (decoded.encoding !== "utf-8") return fail(`encoding=${decoded.encoding}`);
  if (decoded.text.charCodeAt(0) === 0xfeff) return fail("BOM leaked into decoded text");
  const r = parseCsv(decoded.text);
  if (r.headers[0] !== "tweet") return fail(`first header corrupted: ${JSON.stringify(r.headers[0])}`);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 1) return fail(`rows=${r.rows.length}`);
  return null;
});

test("6. UTF-16LE with BOM", () => {
  const csvText = "tweet\nRoad closed at the Glenmore bridge\n";
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(csvText, "utf16le");
  const bytes = Buffer.concat([bom, body]);
  const decoded = decodeBytes(bytes);
  if (decoded.encoding !== "utf-16le") return fail(`encoding=${decoded.encoding}`);
  if (decoded.confidence !== "certain") return fail(`confidence=${decoded.confidence}`);
  if (decoded.text.includes("\u0000")) return fail("NUL bytes leaked into decoded text");
  const r = parseCsv(decoded.text);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows[0]?.text !== "Road closed at the Glenmore bridge") return fail(`text=${JSON.stringify(r.rows[0]?.text)}`);
  return null;
});

test("7. windows-1252 bytes, accents + smart apostrophe", () => {
  // "Café isn't flooded" but with a real windows-1252 apostrophe (0x92), built byte-by-byte
  // so this is a genuine encoding test, not a string literal that happens to render similarly.
  const bytes = Buffer.from([
    ...Buffer.from("tweet\nCaf", "ascii"),
    0xe9, // e-acute in windows-1252
    ...Buffer.from(" isn", "ascii"),
    0x92, // right single quotation mark in windows-1252
    ...Buffer.from("t flooded\n", "ascii"),
  ]);
  const decoded = decodeBytes(bytes);
  if (decoded.encoding !== "windows-1252") return fail(`encoding=${decoded.encoding}`);
  if (decoded.confidence !== "guessed") return fail(`confidence=${decoded.confidence}`);
  if (decoded.text.includes("�")) return fail("replacement character in decoded text");
  const r = parseCsv(decoded.text);
  const text = r.rows[0]?.text ?? "";
  if (!text.includes("Café")) return fail(`missing accent: ${JSON.stringify(text)}`);
  if (!text.includes("’")) return fail(`missing smart apostrophe: ${JSON.stringify(text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 8-9: line endings
// ---------------------------------------------------------------------------

test("8. CRLF line endings", () => {
  const csv = "tweet\r\nBridge closed\r\nRoad clear\r\n";
  const r = parseCsv(csv);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== "Bridge closed") return fail(`text=${JSON.stringify(r.rows[0].text)}`);
  return null;
});

test("9. lone-CR (classic Mac) line endings", () => {
  const csv = "tweet\rBridge closed\rRoad clear";
  const r = parseCsv(csv);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[1].text !== "Road clear") return fail(`text=${JSON.stringify(r.rows[1].text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 10-12: quoting -- the actual dataset shape is a SINGLE "tweet" column, which is exactly
// where a naive delimiter sniffer has nothing to compare against and can misfire.
// ---------------------------------------------------------------------------

test("10. quoted field containing commas (single-column file)", () => {
  const csv = 'tweet\n"Flood, fire, and rain all at once"\n"Calm, quiet, normal day"';
  const r = parseCsv(csv);
  if (r.chosenColumn !== "tweet") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== "Flood, fire, and rain all at once") return fail(`text=${JSON.stringify(r.rows[0].text)}`);
  if (r.rejected.length !== 0) return fail(`spurious rejects: ${JSON.stringify(r.rejected)}`);
  return null;
});

test("11. quoted field containing embedded newlines", () => {
  const csv = 'tweet,other\n"Line one of the report\nLine two continues",x\n"Single line",y';
  const r = parseCsv(csv);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== "Line one of the report\nLine two continues") return fail(`text=${JSON.stringify(r.rows[0].text)}`);
  return null;
});

test("12. quoted field containing escaped double-quotes", () => {
  const csv = 'tweet\n"She said ""get to high ground"" on the radio"';
  const r = parseCsv(csv);
  if (r.rows.length !== 1) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== 'She said "get to high ground" on the radio') return fail(`text=${JSON.stringify(r.rows[0].text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 13-15: missing/malformed structure
// ---------------------------------------------------------------------------

test("13. header-only file, zero data rows", () => {
  const csv = "tweet\n";
  const r = parseCsv(csv);
  if (r.rows.length !== 0) return fail(`rows=${r.rows.length}`);
  if (r.rejected.length === 0) return fail("no reason given for zero data rows");
  if (!/no data rows/i.test(r.rejected[0].reason)) return fail(`unclear reason: ${JSON.stringify(r.rejected)}`);
  return null;
});

test("14. completely empty file", () => {
  const r = parseCsv("");
  if (r.rows.length !== 0) return fail(`rows=${r.rows.length}`);
  if (r.headers.length !== 0) return fail(`headers=${JSON.stringify(r.headers)}`);
  if (r.rejected.length === 0) return fail("no reason given for empty file");
  return null;
});

test("15. no header row at all (first line is data)", () => {
  // Known, documented limitation: there is no reliable way to tell "this first line is
  // data" from "this first line is a header" without semantic guessing we do not attempt.
  // The bar here is narrower than the other cases: do not crash, and do not silently drop
  // every row -- the first line is consumed as a header, which is disclosed via headers.
  const csv = "Water is rising near the bridge\nEverything looks calm today";
  let r: ParsedCsv;
  try {
    r = parseCsv(csv);
  } catch (e) {
    return fail(`threw: ${(e as Error).message}`);
  }
  if (r.headers.length !== 1) return fail(`headers=${JSON.stringify(r.headers)}`);
  if (r.rows.length !== 1) return fail(`rows=${r.rows.length}`);
  return null;
});

// ---------------------------------------------------------------------------
// 16-17: header quality
// ---------------------------------------------------------------------------

test("16. duplicate header names (text,text,text)", () => {
  const csv = "text,text,text\nFirst copy is the report,dupe b,dupe c\nSecond row,x,y";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "text") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  if (r.rows[0].text !== "First copy is the report") return fail(`text=${JSON.stringify(r.rows[0].text)}`);
  return null;
});

test("17. blank header name (text,,other)", () => {
  const csv = "text,,other\nThe report text,ignored middle column,other value";
  const r = parseCsv(csv);
  if (r.headers.includes("")) return fail(`blank header leaked into headers: ${JSON.stringify(r.headers)}`);
  if (r.chosenColumn !== "text") return fail(`chosenColumn=${r.chosenColumn}`);
  if (r.rows[0]?.text !== "The report text") return fail(`text=${JSON.stringify(r.rows[0]?.text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 18-19: ragged rows
// ---------------------------------------------------------------------------

test("18. rows with FEWER fields than the header", () => {
  const csv = "a,b,c\nonly two fields,here\nall three,fields,present";
  let r: ParsedCsv;
  try {
    r = parseCsv(csv);
  } catch (e) {
    return fail(`threw: ${(e as Error).message}`);
  }
  if (!r.rejected.some((x) => x.row === 2)) return fail(`row 2 not flagged: ${JSON.stringify(r.rejected)}`);
  return null;
});

test("19. rows with MORE fields than the header", () => {
  const csv = "a,b,c\ntoo,many,fields,here\nall three,fields,present";
  let r: ParsedCsv;
  try {
    r = parseCsv(csv);
  } catch (e) {
    return fail(`threw: ${(e as Error).message}`);
  }
  if (!r.rejected.some((x) => x.row === 2)) return fail(`row 2 not flagged: ${JSON.stringify(r.rejected)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 20-21: column inference
// ---------------------------------------------------------------------------

test("20. every column numeric -- inferTextColumn must not crash", () => {
  const csv = "a,b,c\n1,2,3\n4,5,6\n7,8,9";
  let r: ParsedCsv;
  try {
    r = parseCsv(csv);
  } catch (e) {
    return fail(`threw: ${(e as Error).message}`);
  }
  if (!r.chosenColumn) return fail("no chosenColumn picked");
  if (r.rows.length !== 3) return fail(`rows=${r.rows.length}`);
  return null;
});

test("21. single unexpectedly-named column (Post Body (raw))", () => {
  const csv = "Post Body (raw)\nRiver is over the banks near downtown\nQuiet day";
  const r = parseCsv(csv);
  if (r.chosenColumn !== "Post Body (raw)") return fail(`chosenColumn=${JSON.stringify(r.chosenColumn)}`);
  if (r.rows.length !== 2) return fail(`rows=${r.rows.length}`);
  return null;
});

// ---------------------------------------------------------------------------
// 22-24: coordinate validation
// ---------------------------------------------------------------------------

test("22. lat/lon containing non-numeric junk -- ignored, not NaN", () => {
  const csv = "tweet,lat,lon\nBad coords,not-a-number,also-junk\nGood coords,51.05,-114.07";
  const r = parseCsv(csv);
  const bad = r.rows[0];
  const good = r.rows[1];
  if (bad.lat !== undefined || bad.lon !== undefined) return fail(`junk coords not ignored: ${bad.lat},${bad.lon}`);
  if (bad.lat !== undefined && Number.isNaN(bad.lat)) return fail("NaN leaked instead of undefined");
  if (good.lat !== 51.05 || good.lon !== -114.07) return fail(`good coords wrong: ${good.lat},${good.lon}`);
  return null;
});

test("23. lat/lon swapped into impossible ranges (lat 200) -- rejected", () => {
  const csv = "tweet,lat,lon\nImpossible,200,50";
  const r = parseCsv(csv);
  if (r.rows[0].lat !== undefined || r.rows[0].lon !== undefined) {
    return fail(`impossible coords accepted: ${r.rows[0].lat},${r.rows[0].lon}`);
  }
  return null;
});

test("24. the 0,0 coordinate sentinel -- rejected", () => {
  const csv = "tweet,lat,lon\nNull Island,0,0";
  const r = parseCsv(csv);
  if (r.rows[0].lat !== undefined || r.rows[0].lon !== undefined) {
    return fail(`0,0 sentinel accepted: ${r.rows[0].lat},${r.rows[0].lon}`);
  }
  return null;
});

// ---------------------------------------------------------------------------
// 25: whitespace-only text
// ---------------------------------------------------------------------------

test("25. row whose text is only whitespace -- rejected with row + reason", () => {
  const csv = "tweet\n   \nReal report here";
  const r = parseCsv(csv);
  if (r.rows.length !== 1) return fail(`rows=${r.rows.length}`);
  const hit = r.rejected.find((x) => x.row === 2);
  if (!hit) return fail(`row 2 not in rejected: ${JSON.stringify(r.rejected)}`);
  if (!hit.reason) return fail("rejected entry has no reason");
  return null;
});

// ---------------------------------------------------------------------------
// 26: extremely long cell
// ---------------------------------------------------------------------------

test("26. extremely long single cell (~1MB) does not hang", () => {
  const big = "x".repeat(1024 * 1024);
  const csv = `tweet\n"${big}"\nshort row`;
  const t0 = Date.now();
  const r = parseCsv(csv);
  const ms = Date.now() - t0;
  if (ms > 5000) return fail(`took ${ms}ms`);
  if (r.rows[0]?.text.length !== big.length) return fail(`length=${r.rows[0]?.text.length}`);
  return null;
});

// ---------------------------------------------------------------------------
// 27: unicode survival
// ---------------------------------------------------------------------------

test("27. emoji, RTL, and CJK survive intact", () => {
  const arabic = "مساعدة"; // "help" in Arabic
  const cjk = "洪水"; // "flood" in Chinese
  const text = `🌊 flood emergency ${cjk} ${arabic}`;
  const csv = `tweet\n"${text}"\nplain row`;
  const r = parseCsv(csv);
  if (r.rows[0]?.text !== text) return fail(`mangled: ${JSON.stringify(r.rows[0]?.text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 28: formula injection
// ---------------------------------------------------------------------------

test("28. formula injection payload is treated as ordinary text", () => {
  // We only ever READ this value as a string and never hand it to a spreadsheet engine, so
  // there is nothing to interpret here. The real risk is the other direction: if this
  // codebase ever grows a CSV EXPORT feature, any cell starting with = + - or @ must be
  // prefixed (e.g. with a leading apostrophe or tab) before being written, or Excel will
  // execute it as a formula when the exported file is reopened. Not relevant to ingest,
  // but noted here because this is where the payload is proven to survive untouched.
  const payload = "=cmd|'/c calc'!A1";
  const csv = `tweet\n"${payload.replace(/"/g, '""')}"\nnormal text`;
  const r = parseCsv(csv);
  if (r.rows[0]?.text !== payload) return fail(`payload altered: ${JSON.stringify(r.rows[0]?.text)}`);
  return null;
});

// ---------------------------------------------------------------------------
// 29: scale
// ---------------------------------------------------------------------------

test("29. 50,000 rows parses in reasonable time", () => {
  const lines = ["tweet"];
  for (let i = 0; i < 50000; i++) {
    lines.push(`"Row ${i}: flood report with a comma, right here"`);
  }
  const csv = lines.join("\n");
  const t0 = Date.now();
  const r = parseCsv(csv);
  const ms = Date.now() - t0;
  console.log(`    elapsed: ${ms}ms for 50000 rows`);
  if (r.rows.length !== 50000) return fail(`rows=${r.rows.length}`);
  if (ms > 10000) return fail(`took ${ms}ms`);
  return null;
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let failures = 0;
for (const c of cases) {
  let result: string | null;
  try {
    result = c.run();
  } catch (e) {
    result = `threw: ${(e as Error).stack ?? (e as Error).message}`;
  }
  if (result === null) {
    console.log(`PASS  ${c.name}`);
  } else {
    failures++;
    console.log(`FAIL  ${c.name}  -- ${result}`);
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures) process.exit(1);
