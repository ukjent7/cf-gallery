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

import { dumpsCompact, dumpsIndent, parsePyJson, pyInt, type PyVal } from "./lib/pyjson.ts";

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
