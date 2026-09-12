#!/usr/bin/env bun
// Fetch per-tag and per-POV game lists from the ErogameScape SQL query interface.
//
// Data source: POST to ~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php with
// sql=<query>; the UTF-8 HTML answer holds the rows in its first <table>.
//
// Two EGS concepts live in different tables:
//
//   --tag NAME  user tags (userreview_with_tag)       -> data/egs_tags.json
//   --pov ID    POV 属性 (povgroups_toukei, 日更统计)  -> data/egs_povs.json
//
// Both: {name: [{id, name, sellday, n}, ...]}, id/sellday as strings, n =
// total votes, SQL id order. A POV key is its povlist system_title (short
// name) falling back to the full title. Crawling pov UNIVERSE_POV (寝取り =
// 559) additionally writes data/pov559_universe.json, the full-fidelity row
// set {id, name, brand, sellday, median, count2, n} prep_data.py unions into
// the gallery list. The attlist.php search page caps its result list (1000
// rows) while the DB holds the complete set, which is why the DB, not the
// search page, is the source of truth.
//
// The informational LIKE probe prints sibling spellings and is not stored.
// Existing keys are kept; only crawled entries are replaced.
//
// Usage: bun scripts/fetch_tags.ts [--tag NAME]... [--pov ID]...
//        no flags: refresh everything already in the files (plus defaults)

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { encode, intFloat, parsePyJson, pyStrip, type PyVal } from "./lib/pyjson.ts";
import { parseCsv } from "./lib/csv.ts";
import { Window } from "happy-dom";

const HERE = import.meta.dir;
const REPO = path.dirname(HERE);
const TAGS_PATH = path.join(REPO, "data", "egs_tags.json");
const POVS_PATH = path.join(REPO, "data", "egs_povs.json");
const UNIVERSE_PATH = path.join(REPO, "data", "pov559_universe.json");
const CSV_PATH = path.join(REPO, "data", "pov559_netori_eroge_only_by_median.csv");
const URL = "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php";
const DEFAULT_TAGS = ["親子丼"];
const UNIVERSE_POV = 559; // 寝取り: the POV the gallery's base list is built from
const TAG_AGG_SQL = `SELECT g.id, g.gamename, g.sellday, g.erogame, count(*) AS n
FROM userreview_with_tag t JOIN gamelist g ON g.id = t.game
WHERE t.tag = '{t}' GROUP BY g.id, g.gamename, g.sellday,
g.erogame ORDER BY g.id`;
const TAG_PROBE_SQL = `SELECT tag, count(*) AS n FROM userreview_with_tag
WHERE tag LIKE '%{t}%' GROUP BY tag ORDER BY n DESC`;
const POV_TITLE_SQL = "SELECT id, title, system_title FROM povlist WHERE id = {n}";
const POV_AGG_SQL = `SELECT g.id, g.gamename, g.sellday, g.erogame, sum(t."count") AS n
FROM povgroups_toukei t JOIN gamelist g ON g.id = t.game
WHERE t.pov = {n} GROUP BY g.id, g.gamename, g.sellday,
g.erogame ORDER BY g.id`;
// The universe query is the one the lean POV rows cannot answer: brand name
// (gamelist.brandname is only an id) and the rating fields prep_data.py needs
// to build DATA entries for games the 寝取 CSV never knew about.
const UNIVERSE_SQL = `SELECT g.id, g.gamename, b.brandname, g.sellday, g.median,
g.count2, sum(t."count") AS n
FROM povgroups_toukei t JOIN gamelist g ON g.id = t.game
LEFT JOIN brandlist b ON b.id = g.brandname
WHERE t.pov = {n} AND g.erogame = true AND g.median IS NOT NULL
GROUP BY g.id, g.gamename, b.brandname, g.sellday, g.median,
g.count2 ORDER BY g.id`;

// ---------------------------------------------------------------------------
// SQL answer tables are parsed with a real HTML parser (happy-dom, already a
// dev dependency for the gallery smoke tests). The parser decodes entities,
// so no hand-rolled entity table is needed; <br> becomes a newline, header
// rows are skipped, and only direct <td> children are read.

function cellTextFromElement(td: Element): string {
  for (const br of td.querySelectorAll("br")) br.replaceWith("\n");
  return pyStrip(td.textContent ?? "");
}

export function firstTableRows(seg: string): string[][] {
  const window = new Window();
  try {
    const doc = new window.DOMParser().parseFromString(seg, "text/html");
    const table = doc.querySelector("table");
    if (!table) return [];
    const rows: string[][] = [];
    for (const tr of table.querySelectorAll("tr")) {
      if (tr.querySelector("th")) continue;
      const cells = [...tr.children].filter((el) => el.tagName.toLowerCase() === "td");
      if (!cells.length) continue;
      rows.push(cells.map((td) => cellTextFromElement(td as Element)));
    }
    return rows;
  } finally {
    window.close();
  }
}

export function cellText(raw: string): string {
  const window = new Window();
  try {
    const doc = new window.DOMParser().parseFromString(`<table><tr><td>${raw}</td></tr></table>`, "text/html");
    const td = doc.querySelector("td");
    if (!td) return pyStrip(raw);
    return cellTextFromElement(td);
  } finally {
    window.close();
  }
}

// urllib.parse.quote(sql.encode("utf-8"), safe=""): unreserved ASCII stays,
// every UTF-8 byte else becomes %XX (upper hex).
export function pyQuote(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    const keep =
      (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
      b === 0x5f || b === 0x2e || b === 0x2d || b === 0x7e;
    out += keep ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

let lastRequest = 0.0; // monotonic seconds, like _last_request

// One POST, retried 3x (2/4/8s backoff) on failure, >=1.5s apart.
async function query(sql: string): Promise<string[][]> {
  const waitMs = Math.max(0, 1.5 - (performance.now() / 1000 - lastRequest)) * 1000;
  if (waitMs > 0) await Bun.sleep(waitMs);
  // percent-encoded UTF-8 keeps the body ascii-only, so the console is safe
  const body = "sql=" + pyQuote(sql);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      const html = new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer());
      lastRequest = performance.now() / 1000;
      const i = html.indexOf("<table"), j = html.indexOf("</table>");
      if (i < 0 || j < 0) throw new Error("no <table> in response");
      return firstTableRows(html.slice(i, j + 8));
    } catch (e) {
      if (attempt === 3) throw e;
      const backoff = 2 << attempt;
      console.error(`  retry in ${backoff}s: ${errText(e)}`);
      await Bun.sleep(backoff * 1000);
    }
  }
  throw new Error("unreachable");
}

function load(p: string): Map<string, PyVal> {
  if (!existsSync(p)) return new Map();
  return parsePyJson(readFileSync(p, "utf8")) as Map<string, PyVal>;
}

function dump(p: string, obj: PyVal): PyVal {
  const tmp = p + ".tmp";
  writeFileSync(tmp, encode(obj, 1, true, 0) + "\n");
  renameSync(tmp, p);
  return parsePyJson(readFileSync(p, "utf8")); // re-parse to verify
}

function csvIds(): Set<string> | null {
  if (!existsSync(CSV_PATH)) return null;
  const buf = readFileSync(CSV_PATH);
  const text = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf).toString("utf8");
  const rows = parseCsv(text);
  const idx = (rows[0] ?? []).indexOf("game_id");
  return new Set(rows.slice(1).map((r) => pyStrip(r[idx] ?? "")));
}

type Entry = { id: string; name: string; sellday: string; n: number };

// (id, gamename, sellday, erogame, n) rows -> lean entries + eroge count.
function toEntries(rows: string[][]): [Entry[], number] {
  const entries: Entry[] = [];
  let eroge = 0;
  for (const row of rows) {
    if (row.length !== 5) throw new Error(`need exactly 5 values to unpack (got ${row.length})`);
    const [gid, name, sellday, erogame, n] = row;
    if (erogame === "t") eroge++;
    entries.push({ id: gid, name, sellday, n: intFloat(n) });
  }
  return [entries, eroge];
}

function report(tag: string, entries: Entry[], eroge: number, ids: Set<string> | null): void {
  const extra =
    ids !== null ? ` intersect=${entries.filter((e) => ids.has(e.id)).length}` : " (pov559 CSV missing)";
  const tail = entries.length ? `, first id=${entries[0].id} last id=${entries[entries.length - 1].id}` : "";
  console.log(`${tag}: rows=${entries.length} erogame=${eroge}${extra}${tail}`);
}

async function crawlTag(tag: string, ids: Set<string> | null): Promise<Entry[]> {
  const rows = await query(TAG_AGG_SQL.replaceAll("{t}", tag.replaceAll("'", "''")));
  const [entries, eroge] = toEntries(rows);
  report(tag, entries, eroge, ids);
  const prows = await query(TAG_PROBE_SQL.replaceAll("{t}", tag.replaceAll("'", "''")));
  console.log(prows.map((r) => `  probe: ${r[0]} (${r[1]})`).join("\n") || "  probe: (no LIKE matches)");
  return entries;
}

// Refresh-all keys are the stored display names, so they must be resolved back
// to a povlist id before the vote table can be queried. A missing or ambiguous
// name leaves its stored entry untouched.
async function resolvePovId(name: string): Promise<number | null> {
  const sql = "SELECT id, title, system_title FROM povlist WHERE system_title = '{n}' OR title = '{n}'";
  const rows = await query(sql.replaceAll("{n}", name.replaceAll("'", "''")));
  const hits = rows.filter((r) => /^\d+$/.test(r[0] ?? ""));
  return hits.length === 1 ? parseInt(hits[0][0], 10) : null;
}

async function crawlPov(pov: number, ids: Set<string> | null): Promise<{ key: string; entries: Entry[]; universe: Record<string, PyVal>[] | null }> {
  let key = String(pov);
  const trows = await query(POV_TITLE_SQL.replaceAll("{n}", String(pov)));
  // query() filters the <th> header away, so the data row is trows[0].
  if (trows.length === 0) fail(`error: povlist has no id ${pov}`);
  if (trows[0].length !== 3) throw new Error(`need exactly 3 values to unpack (got ${trows[0].length})`);
  const title = trows[0][1], systemTitle = trows[0][2];
  key = systemTitle || title;
  const rows = await query(POV_AGG_SQL.replaceAll("{n}", String(pov)));
  const [entries, eroge] = toEntries(rows);
  report(`${key} (pov ${pov})`, entries, eroge, ids);
  let universe: Record<string, PyVal>[] | null = null;
  if (pov === UNIVERSE_POV) {
    const urows = await query(UNIVERSE_SQL.replaceAll("{n}", String(pov)));
    universe = urows.map((r) => {
      if (r.length !== 7) throw new Error(`need exactly 7 values to unpack (got ${r.length})`);
      const [gid, name, brand, day, median, count2, n] = r;
      return {
        id: gid, name, brand: brand || "", sellday: day,
        median: intFloat(median || 0), count2: intFloat(count2 || 0),
        n: intFloat(n),
      };
    });
    console.log(`${key} universe (eroge, median known): ${universe.length} rows`);
  }
  return { key, entries, universe };
}

async function main() {
  const argv = process.argv.slice(2);
  const tagArgs: string[] = [];
  const povArgs: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag") {
      if (i + 1 >= argv.length) {
        console.error("usage: bun scripts/fetch_tags.ts [--tag NAME]... [--pov ID]...");
        process.exit(2);
      }
      tagArgs.push(argv[++i]);
    } else if (argv[i] === "--pov") {
      const v = argv[++i];
      if (v === undefined || !/^[+-]?\d+$/.test(v)) {
        console.error(`invalid int value: ${v === undefined ? "" : `'${v}'`}`);
        process.exit(2);
      }
      povArgs.push(parseInt(v, 10));
    } else {
      console.error(`unrecognized argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  const tags = load(TAGS_PATH), povs = load(POVS_PATH);
  // With no flags at all, refresh everything known; with flags, only the
  // named entries (a POV refresh should not also re-hit the tag endpoint).
  const crawlAll = tagArgs.length === 0 && povArgs.length === 0;
  const tagList = [...new Set(tagArgs.length ? tagArgs : crawlAll ? [...DEFAULT_TAGS, ...tags.keys()] : [])];
  const povList: (string | number)[] = [...new Set(povArgs.length ? povArgs : crawlAll ? [...povs.keys()] : [])];
  const ids = csvIds();
  for (const tag of tagList) {
    tags.set(tag, await crawlTag(tag, ids));
  }
  const universes: [number, Record<string, PyVal>[]][] = [];
  for (const pov of povList) {
    const id = typeof pov === "number" ? pov : await resolvePovId(pov);
    if (id === null) {
      console.log(`pov ${pov}: no unique povlist id matches, entry left unchanged`);
      continue;
    }
    const { key, entries, universe } = await crawlPov(id, ids);
    povs.set(key, entries);
    if (universe !== null) universes.push([id, universe]);
  }
  dump(TAGS_PATH, tags);
  dump(POVS_PATH, povs);
  for (const [pov, universe] of universes) {
    const p = pov === UNIVERSE_POV ? UNIVERSE_PATH : path.join(REPO, "data", `pov${pov}_universe.json`);
    const check = dump(p, universe);
    console.log(`wrote ${p}: ${(check as PyVal[]).length} rows`);
  }
}

if (import.meta.main) main();
