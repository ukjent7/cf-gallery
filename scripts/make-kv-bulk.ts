#!/usr/bin/env bun
// Build the wrangler `kv bulk put` file from workspace crawl data.
//
// Reads <repo>/data/getchu_meta.json ({cid: {gid, n, ok}}) and writes a JSON array
// of {"key": "meta:{cid}", "value": "{\"data\":N,\"hit\":true,\"ts\":T}"}.
// `value` must be a string per the bulk format; ts is milliseconds to match what
// the worker writes at runtime.
//
// The value shape MUST match src/index.js handleLazyMeta, which only trusts an
// entry when `hit` is a boolean. The previous version emitted {"n":N,"ts":T} with
// no `hit`, so every seeded entry was ignored and the whole pipeline was dead
// weight -- reads still went upstream and then wrote KV again.
//
// Both outcomes are seeded:
//   n > 0  -> hit:true   (worker answers from KV)
//   n == 0 -> hit:false  (worker answers 404 straight from KV)
// Seeding the misses is the point: Getchu has ~600 crawled-but-empty ids, and
// without a sentinel each of those costs an upstream fetch on first sight.
//
// Bulk writes are billed against the same 1,000/day free-tier quota as runtime
// writes, so this file is only uploaded when it actually changes (see
// scripts/setup-kv.cjs).
//
// Usage: bun scripts/make-kv-bulk.ts [seed.json] [out.json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const HERE = import.meta.dir;
const REPO = path.dirname(HERE);
const DEFAULT_SEED = path.join(REPO, "data", "getchu_meta.json");
const DEFAULT_OUT = path.join(REPO, "kv-bulk.json");

// ---------------------------------------------------------------------------
// Python-parity JSON helpers (same as prep_data.ts).

type PyVal = string | number | boolean | null | PyVal[] | Map<string, PyVal>;

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

function encode(v: PyVal, indent: number | null, sortKeys: boolean, level: number): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`pyjson: non-integer number ${v}`);
    return String(v); // -0 prints as "0", like Python json
  }
  if (typeof v === "string") return quoteJson(v);
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

const dumpsCompact = (v: PyVal) => encode(v, null, false, 0);
const dumpsIndent = (v: PyVal) => encode(v, 1, false, 0); // json.dumps(..., indent=1)

function parsePyJson(text: string): PyVal {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
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
  const v = value();
  ws();
  if (i !== text.length) throw new Error("pyjson: trailing data");
  return v;
}

// Python int(v): JSON ints pass through; try/except semantics -> 0 on failure.
function pyInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim();
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
}

// ---------------------------------------------------------------------------

function rowsFor(seed: Map<string, PyVal>): Record<string, PyVal>[] {
  const rows: Record<string, PyVal>[] = [];
  for (const [cid0, ent0] of seed) {
    const ent = ent0 as Map<string, PyVal>;
    if (!(ent instanceof Map) || ent.get("ok") !== true) continue;
    if (!/^[0-9]+$/.test(String(cid0))) continue;
    const n = pyInt(ent.get("n") ?? 0);
    const hit = n > 0;
    // ts is 0 by design: the worker only reads it for bookkeeping, entry
    // expiry is governed by the bulk --ttl. A constant makes this file
    // deterministic, so re-running is a no-op in git and a changed file
    // always means the data itself changed.
    rows.push({
      key: `meta:${cid0}`,
      value: dumpsCompact(new Map<string, PyVal>([["data", hit ? n : 0], ["hit", hit], ["ts", 0]])),
    });
  }
  rows.sort((a, b) => pyInt((a.key as string).split(":", 2)[1]) - pyInt((b.key as string).split(":", 2)[1]));
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  const seedPath = argv[0] ?? DEFAULT_SEED;
  const outPath = argv[1] ?? DEFAULT_OUT;
  const seed = parsePyJson(readFileSync(seedPath, "utf8")) as Map<string, PyVal>;

  const rows = rowsFor(seed);
  const newBytes = Buffer.from(dumpsIndent(rows as unknown as PyVal) + "\n", "utf8");

  if (existsSync(outPath) && readFileSync(outPath).equals(newBytes)) {
    console.log(`ok: ${rows.length} entries unchanged, ${outPath} untouched`);
    return;
  }

  writeFileSync(outPath, newBytes);

  const hits = rows.filter((r) => (parsePyJson(r.value as string) as Map<string, PyVal>).get("hit") === true).length;
  console.log(`ok: ${rows.length} entries (${hits} hits, ${rows.length - hits} miss-sentinels) -> ${outPath}`);
}

if (import.meta.main) main();
