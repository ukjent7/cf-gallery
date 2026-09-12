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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

import { dumpsCompact, fmtInt, parsePyJson, pyRstrip, type PyVal } from "./lib/pyjson.ts";

const rstripNl = (s: string) => s.replace(/\n+$/, ""); // Python .rstrip("\n")

function readText(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------

// src/urls.js verbatim, minus its ESM export statements.
//
// Concatenation contract (single classic <script>, no module loader):
// payload consts (DATA, CACHE, STORE, FULLCG, BRANDG, TAGS) first, then this
// file's top-level declarations as shared globals, then the gallery app
// which reads both. Comments are kept because they document the rules at
// the point of use.
function urlsSource(): string {
  const src = readText(path.join(REPO, "src", "urls.js"));
  if (src.includes("BEGIN-EXPORTS") || src.includes("END-EXPORTS")) {
    fail("error: src/urls.js still carries BEGIN/END-EXPORTS markers (removed; exports are stripped generically)");
  }
  // Strip ESM syntax so the same file serves the Worker (ESM import) and the
  // file:// gallery (classic script globals): the export list plus any
  // future `export` prefixes on declarations.
  let stripped = src.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "\n");
  stripped = stripped.replace(/^(\s*)export\s+(?=(?:async\s+)?(?:var|let|const|function|class|default)\b)/gm, "$1");
  if (/^\s*export\b/m.test(stripped)) fail("error: src/urls.js has an export form urlsSource() does not strip");
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
  // The client is authored as focused modules under js/ and css/ and
  // concatenated here, so no single source file grows past a healthy size
  // while the shipped artifact stays one self-contained document.
  const cssDir = path.join(GALLERY, "css");
  const jsDir = path.join(GALLERY, "js");
  const css = existsSync(cssDir)
    ? readdirSync(cssDir).filter((f) => f.endsWith(".css")).sort().map((f) => rstripNl(readText(path.join(cssDir, f)))).join("\n")
    : rstripNl(readText(path.join(GALLERY, "style.css")));
  const app = existsSync(jsDir)
    ? readdirSync(jsDir).filter((f) => f.endsWith(".js")).sort().map((f) => rstripNl(readText(path.join(jsDir, f)))).join("\n")
    : rstripNl(readText(path.join(GALLERY, "app.js")));

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
