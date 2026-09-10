#!/usr/bin/env bun
// Prepare gallery payloads: CSV/JSON inputs -> one build/data.json.
//
// Pure data transform. No HTML, no CSS, no JavaScript: the front-end is authored
// normally under src/gallery/ and assembled by bundle.py.
//
// DATA is the 寝取 CSV plus the POV559 universe crawl (fetch_tags.py --pov 559):
// the attlist.php search page truncates its list, the DB does not, and a game
// the CSV missed still belongs to the gallery's base set. TAGS merges user tags
// (egs_tags.json) and POV 属性 (egs_povs.json) intersected with DATA.
//
// The output shape is deliberately lean. Fields the browser can derive were
// dropped, because the whole document is inlined into one HTML file and every
// byte is paid on first load:
//
//   STORE.dlsite  {id, wt, folder, domain, n, page, samples}
//              -> {id, d, n, sm?}    wt/folder/page derive from id (urls.js);
//                                    sm only when stems are not plain smp1..smpN
//   STORE.dmm     {id, n, page}   -> {id, n}
//   STORE.getchu  {id, page}      -> {id, n?}  n merged in from getchu_meta.json
//   CACHE         image{url,thumbnail} + shots[{url,thumbnail}]
//              -> img:"<url>" + shots:["<url>"]   thumbnails derive via vnThumb()
//   GETCHU        (whole payload) -> removed; only feed GCN, which was unused
//
// Verified derivable against the current dataset (see test/build.test.js):
// 0 mismatches on 744 dlsite pages, 723 getchu pages, 744 wt, 744 folders,
// 507/555 VNDB thumbnails (the rest are cover-image forms vnThumb handles).
//
// Usage: bun scripts/prep_data.ts [--root DIR]

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const HERE = import.meta.dir;
const REPO = path.dirname(HERE);
const WORKSPACE = path.dirname(REPO);
const DATA_DIR = path.join(REPO, "data");
const OUT_DIR = path.join(REPO, "build");

const INPUTS = {
  csv: "pov559_netori_eroge_only_by_median.csv",
  vndb_cache: "vndb_cache_top60.json",
  store_cache: "store_cache.json",
  getchu_meta: "getchu_meta.json",
  fullcg: "fullcg_links.json",
  brand_group: "brand_group.json",
  egs_tags: "egs_tags.json",
  egs_povs: "egs_povs.json",
  vndb_tags: "vndb_tags.json",
  universe: "pov559_universe.json",
};

// repo/data holds the committed snapshot that a fresh clone builds from. The
// workspace is searched last because the crawl scripts (enrich_dlsite.py,
// recount_dmm.py, ...) write their results there.
const SEARCH_DIRS: string[] = [DATA_DIR, WORKSPACE];

// ---------------------------------------------------------------------------
// Python-parity helpers.
//
// Python dicts keep insertion order; JS objects reorder integer-like keys
// ("20764") numerically, which would scramble the gid-keyed payloads. JSON
// objects are therefore parsed into Map and both serializers below walk Maps
// and plain objects in insertion order.

type PyVal = string | number | boolean | null | PyVal[] | Map<string, PyVal>;

// Python json.dump(ensure_ascii=False, separators=(",", ":")).
function dumpsCompact(v: PyVal): string {
  return encode(v, null, false, 0);
}

// Python json.dump(ensure_ascii=False, indent=1, sort_keys=True).
function dumpsIndentSorted(v: PyVal): string {
  return encode(v, 1, true, 0);
}

function encode(v: PyVal, indent: number | null, sortKeys: boolean, level: number): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`pyjson: non-integer number ${v}`);
    return String(v); // -0 prints as "0", like Python json
  }
  if (typeof v === "string") return quoteJson(v);
  // dict (Map or plain object) in insertion order
  let items = v instanceof Map ? [...v.entries()] : (Object.entries(v as Record<string, PyVal>) as [string, PyVal][]);
  if (sortKeys) {
    items = items.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  if (indent === null) {
    // separators=(",", ":")
    if (Array.isArray(v)) return "[" + v.map((x) => encode(x, null, sortKeys, level)).join(",") + "]";
    if (items.length === 0) return "{}";
    return "{" + items.map(([k, x]) => quoteJson(k) + ":" + encode(x, null, sortKeys, level)).join(",") + "}";
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const inner = " ".repeat(indent * (level + 1));
    const enc = v.map((x) => inner + encode(x, indent, sortKeys, level + 1));
    return "[\n" + enc.join(",\n") + "\n" + " ".repeat(indent * level) + "]";
  }
  if (items.length === 0) return "{}";
  const inner = " ".repeat(indent * (level + 1));
  const items2 = items.map(([k, x]) => inner + quoteJson(k) + ": " + encode(x, indent, sortKeys, level + 1));
  return "{\n" + items2.join(",\n") + "\n" + " ".repeat(indent * level) + "}";
}

function quoteJson(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 8) out += "\\b";
    else if (c === 9) out += "\\t";
    else if (c === 10) out += "\\n";
    else if (c === 12) out += "\\f";
    else if (c === 13) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// Recursive-descent parse producing Maps for JSON objects (order-preserving).
function parsePyJson(text: string): PyVal {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
  function value(): PyVal {
    ws();
    const c = text[i];
    if (c === "{") return dict();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "t" || c === "f") return literal();
    if (c === "n") {
      literal();
      return null;
    }
    return number();
  }
  function literal(): boolean {
    const m = /^(true|false|null)/.exec(text.slice(i))!;
    i += m[0].length;
    return m[0] === "true";
  }
  function number(): number {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))!;
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isInteger(n)) throw new Error(`pyjson: non-integer number ${m[0]}`);
    return n;
  }
  function string(): string {
    i++; // opening quote
    let out = "";
    while (text[i] !== '"') {
      if (text[i] === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          out += { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e as never];
          i += 2;
        }
      } else {
        out += text[i];
        i++;
      }
    }
    i++; // closing quote
    return out;
  }
  function dict(): Map<string, PyVal> {
    const m = new Map<string, PyVal>();
    i++; // {
    ws();
    if (text[i] === "}") {
      i++;
      return m;
    }
    for (;;) {
      ws();
      const k = string();
      ws();
      i++; // :
      m.set(k, value());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      i++; // }
      return m;
    }
  }
  function array(): PyVal[] {
    const a: PyVal[] = [];
    i++; // [
    ws();
    if (text[i] === "]") {
      i++;
      return a;
    }
    for (;;) {
      a.push(value());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      i++; // ]
      return a;
    }
  }
  const v = value();
  ws();
  if (i !== text.length) throw new Error("pyjson: trailing data");
  return v;
}

// Python str.strip() / str.rstrip(): Python's whitespace set, not JS trim's
// (no U+FEFF; does include \x1c-\x1f and U+0085).
const PY_WS = "\t\n\u000b\f\r \u001c\u001d\u001e\u001f   -     　";
const pyStrip = (s: string) => s.replace(new RegExp(`^[${PY_WS}]+`), "").replace(new RegExp(`[${PY_WS}]+$`), "");
const pyRstrip = (s: string) => s.replace(new RegExp(`[${PY_WS}]+$`), "");

// Python int(str(v).strip()) with try/except ValueError/TypeError -> 0:
// only plain (optionally signed) decimal digits parse ("2.5" -> 0, "" -> 0).
function pyInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = pyStrip(String(v));
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
}

// Python truthiness: unlike JS, [] and {} (empty Map here) are falsy.
function pyTruthy(x: unknown): boolean {
  return !!x && !(x instanceof Map && x.size === 0) && !(Array.isArray(x) && x.length === 0);
}

const fmtInt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ---------------------------------------------------------------------------
// RFC4180 CSV, ported from csv.DictReader(encoding="utf-8-sig", newline=""):
// quoted fields, embedded delimiters/newlines, "" escapes, CR-LF records, and
// the leading BOM stripped. _csv's state machine, minus the error paths this
// dataset never hits (unterminated quote -> _csv.Error like Python).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state = "START_RECORD";
  const saveField = () => {
    row.push(field);
    field = "";
  };
  const saveRow = () => {
    rows.push(row);
    row = [];
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    switch (state) {
      case "START_RECORD":
        if (c === "\n" || c === "\r") i++; // blank record: skipped
        else state = "START_FIELD";
        break;
      case "START_FIELD":
        if (c === '"') {
          state = "IN_QUOTED_FIELD";
          i++;
        } else if (c === ",") {
          saveField();
          i++;
        } else if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else {
          field += c;
          state = "IN_FIELD";
          i++;
        }
        break;
      case "IN_FIELD":
        if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else if (c === ",") {
          saveField();
          state = "START_FIELD";
          i++;
        } else {
          field += c;
          i++;
        }
        break;
      case "IN_QUOTED_FIELD":
        if (c === '"') {
          state = "QUOTE_IN_QUOTED_FIELD";
          i++;
        } else {
          field += c; // CR-LF inside quotes is kept verbatim
          i++;
        }
        break;
      case "QUOTE_IN_QUOTED_FIELD":
        if (c === '"') {
          field += '"';
          state = "IN_QUOTED_FIELD";
          i++;
        } else if (c === ",") {
          saveField();
          state = "START_FIELD";
          i++;
        } else if (c === "\n" || c === "\r") {
          saveField();
          saveRow();
          state = "EAT_CRNL";
          i++;
        } else {
          field += c;
          state = "IN_FIELD";
          i++;
        }
        break;
      case "EAT_CRNL":
        if (c === "\n" || c === "\r") i++;
        else state = "START_RECORD";
        break;
    }
  }
  if (state === "IN_QUOTED_FIELD") throw new Error("csv: unexpected end of data");
  if (state === "START_FIELD" || state === "IN_FIELD" || state === "QUOTE_IN_QUOTED_FIELD") {
    saveField();
    saveRow();
  }
  return rows;
}

// DictReader: first row is the header; short rows read as null, extras under
// the None restkey are dropped (unused by the transforms).
function csvDicts(text: string): Record<string, string | null>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const d: Record<string, string | null> = {};
    header.forEach((h, i) => {
      d[h] = i < r.length ? r[i] : null;
    });
    return d;
  });
}

// ---------------------------------------------------------------------------

// Locate INPUTS[key], preferring the repo snapshot. Warn if a newer copy
// exists elsewhere so a stale commit can never silently win.
function find(key: keyof typeof INPUTS): string | null {
  const name = INPUTS[key];
  let chosen: string | null = null;
  for (const d of SEARCH_DIRS) {
    const p = path.join(d, name);
    if (existsSync(p) && statSync(p).isFile()) {
      chosen = p;
      break;
    }
  }
  if (chosen === null) return null;
  for (const d of SEARCH_DIRS) {
    const other = path.join(d, name);
    if (other === chosen || !existsSync(other)) continue;
    if (statSync(other).mtimeMs > statSync(chosen).mtimeMs + 1) {
      console.log(
        `warning: ${name} is newer at ${other}\n` +
          `         but building from ${chosen}\n` +
          `         (copy it into ${DATA_DIR} to update the snapshot)`,
      );
    }
  }
  return chosen;
}

function load(key: keyof typeof INPUTS, def?: PyVal): PyVal {
  const p = find(key);
  if (p === null) {
    if (def === undefined) {
      console.error(`error: input ${INPUTS[key]} not found in ${SEARCH_DIRS}`);
      process.exit(1);
    }
    console.log(`note: ${INPUTS[key]} missing, using default`);
    return def;
  }
  if (p.endsWith(".csv")) {
    const buf = readFileSync(p);
    const text = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf).toString("utf8");
    return csvDicts(text) as unknown as PyVal;
  }
  return parsePyJson(readFileSync(p, "utf8"));
}

function cmpData(a: any, b: any): number {
  // Gallery rank order: median desc, count2 desc, newer sellday, gid asc.
  const ma = a.median ?? 0, mb = b.median ?? 0;
  if (ma !== mb) return ma > mb ? -1 : 1;
  const ca = a.count2, cb = b.count2;
  if (ca !== cb) return ca > cb ? -1 : 1;
  const da = a.sellday ?? "", db = b.sellday ?? "";
  if (da !== db) return da > db ? -1 : 1;
  const ga = a.gid, gb = b.gid;
  return ga < gb ? -1 : ga > gb ? 1 : 0;
}

function leanData(csvRows: Record<string, string | null>[], universe: PyVal): any[] {
  // CSV rows first (their EGS ranking sequence is kept), then games the
  // 寝取 universe crawl (POV559 straight from the DB, where the attlist search
  // page truncates at 1000) knows but the CSV missed. Ranks are renumbered
  // over the merge; ties between a new game and a CSV row keep the CSV row.
  const data: any[] = [];
  for (const r of csvRows) {
    const median = pyInt(r.median);
    data.push({
      rank: pyInt(r.rank),
      gid: pyStrip(String(r.game_id ?? "")),
      name: r.gamename ?? "",
      brand: r.brandname ?? "",
      sellday: r.sellday ?? "",
      median: median ? median : null,
      count2: pyInt(r.count2_get_score),
      votes: pyInt(r.pov_votes),
    });
  }
  const seen = new Set(data.map((d) => d.gid));
  const extras: any[] = [];
  for (const e of universe ?? []) {
    const row = e as Map<string, PyVal>;
    const gid = pyStrip(String(row?.get?.("id") ?? ""));
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    const median = pyInt(row.get("median"));
    extras.push({
      rank: 0,
      gid,
      name: (row.get("name") as string) ?? "",
      brand: (row.get("brand") as string) ?? "",
      sellday: (row.get("sellday") as string) ?? "",
      median: median ? median : null,
      count2: pyInt(row.get("count2")),
      votes: pyInt(row.get("n")),
    });
  }
  extras.sort(cmpData);
  const merged: any[] = [];
  let i = 0, j = 0;
  while (i < data.length || j < extras.length) {
    if (j >= extras.length || (i < data.length && cmpData(extras[j], data[i]) >= 0)) merged.push(data[i++]);
    else merged.push(extras[j++]);
  }
  merged.forEach((d, idx) => {
    d.rank = idx + 1;
  });
  return merged;
}

// Mirrors dlStems() in src/urls.js: a missing stem list with a non-zero count is
// not derivable, so it is flagged instead of silently guessed.
function leanDlsite(d: Map<string, PyVal>): Record<string, PyVal> {
  const out: Record<string, PyVal> = { id: d.get("id") as string, d: (d.get("domain") as string) || "maniax", n: pyInt(d.get("n")) };
  const samples = (d.get("samples") ?? null) as PyVal;
  const stems: PyVal = pyTruthy(samples) ? samples : [];
  const plain = Array.isArray(stems) && stems.every((s, i) => s === `smp${i + 1}`);
  if (pyTruthy(stems) && !plain) out.sm = stems;
  if (!pyTruthy(stems) && out.n) {
    // A count exists but the crawl never collected stem names, so
    // smp1..smpN is a guess rather than a derivation. Flagged so the gallery
    // asks live meta exactly once for these instead of trusting the guess.
    out.un = 1;
  }
  return out;
}

function leanDmm(e: Map<string, PyVal>): Record<string, PyVal> {
  return { id: e.get("id") as string, n: pyInt(e.get("n")) };
}

function leanStore(storeCache: Map<string, PyVal>, getchuMeta: Map<string, PyVal>): Map<string, PyVal> {
  // {gid: {l, m, m2, g}} keeping only irreducible facts.
  const out = new Map<string, PyVal>();
  for (const [gid, v0] of storeCache) {
    const v = v0 as Map<string, PyVal>;
    if (!(v instanceof Map)) continue;
    const e: Record<string, PyVal> = {};
    if (pyTruthy(v.get("dlsite"))) e.l = leanDlsite(v.get("dlsite") as Map<string, PyVal>);
    for (const [key, short] of [["dmm", "m"], ["dmm2", "m2"]] as const) {
      const dm = v.get(key) as Map<string, PyVal>;
      if (pyTruthy(dm)) e[short] = { id: dm.get("id") as string, n: pyInt(dm.get("n")) };
    }
    if (pyTruthy(v.get("getchu"))) {
      const g: Record<string, PyVal> = { id: String((v.get("getchu") as Map<string, PyVal>).get("id")) };
      // Baking the crawled sample count means the Getchu tab never asks
      // the Worker, which is the single largest KV write saving.
      const meta = getchuMeta.get(g.id as string);
      if (meta instanceof Map && meta.get("ok") === true) g.n = pyInt(meta.get("n"));
      e.g = g;
    }
    if (Object.keys(e).length) out.set(String(gid), e);
  }
  return out;
}

function leanCache(vndbCache: Map<string, PyVal>): Map<string, PyVal> {
  // {gid: {id, title, alttitle, released, img, shots[urls], extra, release, via}}
  const out = new Map<string, PyVal>();
  for (const [gid, v0] of vndbCache) {
    const v = v0 ?? new Map<string, PyVal>();
    const pick = v.get("pick");
    if (!pyTruthy(pick)) {
      out.set(String(gid), null);
      continue;
    }
    const p = pick as Map<string, PyVal>;
    out.set(String(gid), {
      id: p.get("id") ?? null,
      title: p.get("title") ?? null,
      alttitle: p.get("alttitle") ?? null,
      released: p.get("released") ?? null,
      img: urlOf(p.get("image")),
      shots: ((Array.isArray(p.get("screenshots")) ? (p.get("screenshots") as PyVal[]) : []).slice(0, 30) as PyVal[])
        .map((s) => urlOf(s))
        .filter((u) => u),
      extra: (Array.isArray(v.get("extra_vns")) ? (v.get("extra_vns") as Map<string, PyVal>[]) : [])
        .filter((e) => pyTruthy(e.get("id")))
        .map((e) => ({ id: e.get("id") ?? null, title: e.get("title") ?? null, alttitle: e.get("alttitle") ?? null })),
      release: v.get("release") ?? null,
      via: v.get("via") ?? null,
    });
  }
  return out;
}

function urlOf(x: PyVal): string | null {
  if (!pyTruthy(x)) return null;
  return x instanceof Map ? (x.get("url") as string) : String(x);
}

function leanTags(
  egsTags: Map<string, PyVal>,
  egsPovs: Map<string, PyVal>,
  vndbTags: Map<string, PyVal>,
  gidSet: Set<string>,
): Map<string, string[]> {
  // {tag: [gid, ...]} limited to games this gallery lists.
  //
  // Sources: egs_tags.json (user tags, 親子丼), egs_povs.json (POV 属性,
  // 堕ちる過程) from the EGS SQL interface, and vndb_tags.json (fetch_vndb_ts,
  // kana API) — the 親子丼 key unions with the EGS one, 寝取り(VNDB) ships as
  // its own key. The 寝取 CSV is itself POV559, and the universe crawl unions
  // it into DATA, so a source whose intersection covers every listed game
  // (寝取り) cannot filter anything and is not shipped. A name known to more
  // than one source merges as the union: both assert the game carries the
  // concept.
  const out = new Map<string, string[]>();
  const sources: [string, PyVal][] = [...egsTags.entries(), ...egsPovs.entries(), ...vndbTags.entries()];
  for (const [tag, games] of sources) {
    const rows = Array.isArray(games) ? (games as PyVal[]) : (games as Map<string, PyVal>)?.get("gids");
    const gids = new Set<string>();
    for (const e of Array.isArray(rows) ? (rows as PyVal[]) : []) {
      const gid = pyStrip(String(e?.get("id") ?? ""));
      if (gidSet.has(gid)) gids.add(gid);
    }
    if (gids.size === 0 || [...gidSet].every((g) => gids.has(g))) continue;
    out.set(tag, [...new Set([...(out.get(tag) ?? []), ...gids])].sort((a, b) => pyInt(a) - pyInt(b)));
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--root")) {
    SEARCH_DIRS.unshift(path.resolve(argv[argv.indexOf("--root") + 1]));
  }

  const rows = load("csv") as unknown as Record<string, string | null>[];
  const data = leanData(rows, load("universe", new Map()) as PyVal);

  const payloads = new Map<string, PyVal>([
    ["DATA", data],
    ["CACHE", leanCache(load("vndb_cache", new Map()) as Map<string, PyVal>)],
    ["STORE", leanStore(load("store_cache", new Map()) as Map<string, PyVal>, load("getchu_meta", new Map()) as Map<string, PyVal>)],
    ["FULLCG", load("fullcg", new Map())],
    ["BRANDG", load("brand_group", new Map())],
    ["TAGS", leanTags(
      load("egs_tags", new Map()) as Map<string, PyVal>,
      load("egs_povs", new Map()) as Map<string, PyVal>,
      load("vndb_tags", new Map()) as Map<string, PyVal>,
      new Set(data.map((d) => d.gid)),
    )],
  ]);

  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "data.json");
  // LF endings so the artifact is byte-identical on every platform; bundle.py
  // inlines it verbatim into public/index.html.
  writeFileSync(out, dumpsCompact(payloads as unknown as PyVal) + "\n");

  const st = payloads.get("STORE") as Map<string, any>;
  console.log("wrote", out);
  for (const [name, val] of payloads) {
    const raw = dumpsCompact(val as PyVal);
    const len = Array.isArray(val) ? val.length : (val as Map<string, PyVal>).size;
    console.log(`  ${name.padEnd(7)} ${String(len).padStart(5)} entries  ${String(fmtInt(Buffer.byteLength(raw, "utf8"))).padStart(8)} B`);
  }
  console.log(
    `  totals: ${st.size} products with store ids, ` +
      `${[...st.values()].filter((e) => "l" in e).length} DLsite, ` +
      `${[...st.values()].filter((e) => "m" in e || "m2" in e).length} FANZA, ` +
      `${[...st.values()].filter((e) => "g" in e).length} Getchu, ` +
      `${[...st.values()].filter((e) => "g" in e && "n" in (e.g as any)).length} with baked Getchu counts`,
  );
  for (const [tag, gids] of payloads.get("TAGS") as Map<string, string[]>) {
    console.log(`  tag ${tag}: ${gids.length} games in list`);
  }
}

if (import.meta.main) main();
