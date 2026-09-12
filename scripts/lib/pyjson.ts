#!/usr/bin/env bun
// Shared Python-parity JSON helpers: single source of truth for the build scripts.
//
// Python dicts keep insertion order; JS objects reorder integer-like keys
// ("20764") numerically, which would scramble gid-keyed payloads. JSON
// objects are therefore parsed into Map and the serializers below walk Maps
// and plain objects in insertion order, reproducing Python
// json.dump(ensure_ascii=False) byte-for-byte.

export type PyVal = string | number | boolean | null | PyVal[] | Map<string, PyVal>;

// Python str.strip()/rstrip() whitespace set (no U+FEFF; includes \x1c-\x1f
// and U+0085). Escaped form is canonical: identical to the old literal
// UTF-8 bytes in prep_data.ts, but explicit and copy-safe.
export const PY_WS = "\t\n\u000b\f\r \x1c\x1d\x1e\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
export const pyStrip = (s: string) =>
  s.replace(new RegExp(`^[${PY_WS}]+`), "").replace(new RegExp(`[${PY_WS}]+$`), "");
export const pyRstrip = (s: string) => s.replace(new RegExp(`[${PY_WS}]+$`), "");

// Python int(str(v).strip()) with try/except ValueError/TypeError -> 0:
// only plain (optionally signed) decimal digits parse ("2.5" -> 0, "" -> 0).
export function pyInt(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = pyStrip(String(v));
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
}

// Python int(float(n)) for DB numeric strings ("2" -> 2, "2.5" -> 2).
export function intFloat(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  const s = pyStrip(String(v ?? ""));
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// Python str < compares code points; JS "<" compares UTF-16 code units.
// The two agree on BMP text but diverge on astral characters, so the
// code-point form is the correct Python parity.
export function pyStrCmp(a: string, b: string): number {
  const ca = [...a], cb = [...b];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    if (ca[i] !== cb[i]) return ca[i]! < cb[i]! ? -1 : 1;
  }
  return ca.length === cb.length ? 0 : ca.length < cb.length ? -1 : 1;
}

// Integer-like keys sort numerically (JS objects would otherwise reorder
// them), everything else by code point. Used for vndb artifacts.
export function keyCmpNumeric(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return parseInt(a, 10) - parseInt(b, 10);
  return pyStrCmp(a, b);
}

export function quoteJson(s: string): string {
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

function entriesOf(v: PyVal): [string, PyVal][] {
  return v instanceof Map
    ? [...v.entries()]
    : (Object.entries(v as Record<string, PyVal>) as [string, PyVal][]);
}

export function encode(
  v: PyVal,
  indent: number | null,
  sortKeys: boolean,
  level: number,
  cmp: (a: string, b: string) => number = pyStrCmp,
): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`pyjson: non-integer number ${v}`);
    return String(v); // -0 prints as "0", like Python json
  }
  if (typeof v === "string") return quoteJson(v);
  let items = entriesOf(v);
  if (sortKeys) {
    items = items.slice().sort((a, b) => cmp(a[0], b[0]));
  }
  if (indent === null) {
    // separators=(",", ":")
    if (Array.isArray(v)) return "[" + v.map((x) => encode(x, null, sortKeys, level, cmp)).join(",") + "]";
    if (items.length === 0) return "{}";
    return "{" + items.map(([k, x]) => quoteJson(k) + ":" + encode(x, null, sortKeys, level, cmp)).join(",") + "}";
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const inner = " ".repeat(indent * (level + 1));
    const enc = v.map((x) => inner + encode(x, indent, sortKeys, level + 1, cmp));
    return "[\n" + enc.join(",\n") + "\n" + " ".repeat(indent * level) + "]";
  }
  if (items.length === 0) return "{}";
  const inner = " ".repeat(indent * (level + 1));
  const items2 = items.map(([k, x]) => inner + quoteJson(k) + ": " + encode(x, indent, sortKeys, level + 1, cmp));
  return "{\n" + items2.join(",\n") + "\n" + " ".repeat(indent * level) + "}";
}

// Python json.dump(ensure_ascii=False, separators=(",", ":")).
export const dumpsCompact = (v: PyVal): string => encode(v, null, false, 0);

// Python json.dump(ensure_ascii=False, indent=1, sort_keys=True).
export const dumpsIndentSorted = (v: PyVal): string => encode(v, 1, true, 0);

// json.dumps(..., indent=1) without key sorting (kv-bulk seed file).
export const dumpsIndent = (v: PyVal): string => encode(v, 1, false, 0);

// Recursive-descent parse producing Maps for JSON objects (order-preserving).
export function parsePyJson(text: string): PyVal {
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

// Python truthiness: unlike JS, [] and {} (empty Map here) are falsy.
export function pyTruthy(x: unknown): boolean {
  return !!x && !(x instanceof Map && x.size === 0) && !(Array.isArray(x) && x.length === 0);
}

export const fmtInt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
