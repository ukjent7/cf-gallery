#!/usr/bin/env bun
// Assemble the self-contained gallery document.
//
// Reads src/gallery/{index.src.html,style.css,app.js} plus src/urls.js and
// build/data.json, and writes public/index.html: one file with no external
// requests, so it still works when double-clicked from disk.
//
// Why inline instead of shipping separate files: fetch() of a sibling .json is
// blocked under file://, and the whole point of this artifact is that it can be
// emailed or opened locally without a server.
//
// Usage: bun scripts/bundle.ts [--out PATH] [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import * as path from "node:path";

const HERE = import.meta.dir;
const REPO = path.dirname(HERE);
const GALLERY = path.join(REPO, "src", "gallery");
const DATA_JSON = path.join(REPO, "build", "data.json");
const DEFAULT_OUT = path.join(REPO, "public", "index.html");

const PAYLOAD_ORDER = ["DATA", "CACHE", "STORE", "FULLCG", "BRANDG", "TAGS"];

// ---------------------------------------------------------------------------
// Python-parity helpers (same as prep_data.ts): JSON objects parse into Map so
// gid keys keep insertion order, and both serializers reproduce Python
// json.dump byte-for-byte.

type PyVal = string | number | boolean | null | PyVal[] | Map<string, PyVal>;

function dumpsCompact(v: PyVal): string {
  return encode(v, null, false, 0);
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

// Python str.rstrip() and text-mode read(): Python's whitespace set, plus
// universal-newline translation of CRLF/CR to LF.
const PY_WS = "\t\n\u000b\f\r \x1c\x1d\x1e\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const pyRstrip = (s: string) => s.replace(new RegExp(`[${PY_WS}]+$`), "");
const rstripNl = (s: string) => s.replace(/\n+$/, ""); // Python .rstrip("\n")

function readText(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const fmtInt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// ---------------------------------------------------------------------------

// src/urls.js verbatim, minus its ESM export block.
//
// The gallery has no module loader; the file's declarations become part of the
// single script. Comments are kept because they document the rules at the
// point of use.
function urlsSource(): string {
  const src = readText(path.join(REPO, "src", "urls.js"));
  const start = src.indexOf("// BEGIN-EXPORTS");
  if (start < 0) fail("error: // BEGIN-EXPORTS missing from src/urls.js");
  const end = src.indexOf("// END-EXPORTS") + "// END-EXPORTS".length;
  if (end < "// END-EXPORTS".length) fail("error: // END-EXPORTS missing from src/urls.js");
  const stripped = src.slice(0, start) + src.slice(end);
  // Drop the leading module doc comment's import-era wording, and any
  // leftover blank lines at the join.
  return pyRstrip(stripped.replaceAll("\n\n\n", "\n\n")) + "\n";
}

function payloadSource(data: Map<string, PyVal>): string {
  const lines: string[] = [];
  for (const name of PAYLOAD_ORDER) {
    if (!data.has(name)) fail(`error: build/data.json missing ${name}`);
    let blob = dumpsCompact(data.get(name)!);
    // "</script>" inside a JSON string would close the tag early. The data
    // is machine-generated titles, but this is cheap insurance.
    blob = blob.replaceAll("</", "<\\/");
    lines.push(`const ${name} = ${blob};`);
  }
  return lines.join("\n") + "\n";
}

function build(outPath?: string, checkOnly = false): string {
  outPath = outPath ?? DEFAULT_OUT;
  const dataPath = DATA_JSON;
  if (!existsSync(dataPath)) fail("error: build/data.json not found; run scripts/prep_data.py first");
  const data = parsePyJson(readText(dataPath)) as Map<string, PyVal>;

  const shell = readText(path.join(GALLERY, "index.src.html"));
  const css = readText(path.join(GALLERY, "style.css"));
  const app = readText(path.join(GALLERY, "app.js"));

  for (const token of ["/*__STYLE__*/", "/*__PAYLOAD__*/", "/*__URLS__*/", "/*__APP__*/"]) {
    if (!shell.includes(token)) fail(`error: ${token} missing from index.src.html`);
  }

  // Function replacements: JS would otherwise treat "$&" inside the inserted
  // sources (urls.js reEscape) as substitution patterns, unlike str.replace.
  const doc = shell
    .replaceAll("/*__STYLE__*/", () => rstripNl(css))
    .replaceAll("/*__PAYLOAD__*/", () => rstripNl(payloadSource(data)))
    .replaceAll("/*__URLS__*/", () => rstripNl(urlsSource()))
    .replaceAll("/*__APP__*/", () => rstripNl(app));

  // Guard: the inlined JS must not contain a literal closing script tag.
  const open = doc.indexOf("<script>");
  const close = doc.lastIndexOf("</script>");
  if (open < 0 || close < 0) fail("error: <script> tags missing from the assembled document");
  const scriptBody = doc.slice(open + "<script>".length, close);
  if (/<\/script/i.test(scriptBody)) fail("error: inlined payload contains a literal </script");

  const raw = Buffer.from(doc, "utf8");
  if (checkOnly) {
    console.log(`check ok: ${fmtInt(raw.length)} B would be written to ${outPath}`);
    return doc;
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc);

  // node:zlib at level 9 is the same deflate as Python's gzip.compress(raw, 9).
  const gz = gzipSync(raw, { level: 9 }).length;
  console.log(`wrote ${outPath}`);
  console.log(`  ${fmtInt(raw.length)} B raw, ${fmtInt(gz)} B gzip`);
  const payloadBytes = PAYLOAD_ORDER.reduce(
    (acc, n) => acc + Buffer.byteLength(dumpsCompact(data.get(n)!), "utf8"),
    0,
  );
  console.log(
    `  markup+code ${fmtInt(raw.length - payloadBytes)} B, payload ${fmtInt(payloadBytes)} B`,
  );
  return doc;
}

const argv = process.argv.slice(2);
let out: string | undefined;
const check = argv.includes("--check");
if (argv.includes("--out")) {
  out = path.resolve(argv[argv.indexOf("--out") + 1]);
}
if (import.meta.main) build(out, check);
