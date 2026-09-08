#!/usr/bin/env python3
"""Build the wrangler `kv bulk put` file from workspace crawl data.

Reads <repo>/data/getchu_meta.json ({cid: {gid, n, ok}}) and writes a JSON array
of {"key": "meta:{cid}", "value": "{\\"data\\":N,\\"hit\\":true,\\"ts\\":T}"}.
`value` must be a string per the bulk format; ts is milliseconds to match what
the worker writes at runtime.

The value shape MUST match src/index.js handleLazyMeta, which only trusts an
entry when `hit` is a boolean. The previous version emitted {"n":N,"ts":T} with
no `hit`, so every seeded entry was ignored and the whole pipeline was dead
weight -- reads still went upstream and then wrote KV again.

Both outcomes are seeded:
  n > 0  -> hit:true   (worker answers from KV)
  n == 0 -> hit:false  (worker answers 404 straight from KV)
Seeding the misses is the point: Getchu has ~600 crawled-but-empty ids, and
without a sentinel each of those costs an upstream fetch on first sight.

Bulk writes are billed against the same 1,000/day free-tier quota as runtime
writes, so this file is only uploaded when it actually changes (see
scripts/setup-kv.cjs).

Usage: python3 make-kv-bulk.py [seed.json] [out.json]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_SEED = os.path.join(REPO, "data", "getchu_meta.json")
DEFAULT_OUT = os.path.join(REPO, "kv-bulk.json")


def rows_for(seed):
    rows = []
    for cid, ent in seed.items():
        if not isinstance(ent, dict) or ent.get("ok") is not True:
            continue
        if not str(cid).isdigit():
            continue
        n = int(ent.get("n") or 0)
        hit = n > 0
        # ts is 0 by design: the worker only reads it for bookkeeping, entry
        # expiry is governed by the bulk --ttl. A constant makes this file
        # deterministic, so re-running is a no-op in git and a changed file
        # always means the data itself changed.
        rows.append({
            "key": f"meta:{cid}",
            "value": json.dumps({"data": n if hit else 0, "hit": hit, "ts": 0},
                                ensure_ascii=False, separators=(",", ":")),
        })
    rows.sort(key=lambda r: int(r["key"].split(":", 1)[1]))
    return rows


def main():
    seed_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SEED
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)

    rows = rows_for(seed)
    new = json.dumps(rows, ensure_ascii=False, indent=1) + "\n"

    if os.path.isfile(out_path) and open(out_path, "rb").read() == new.encode("utf-8"):
        print(f"ok: {len(rows)} entries unchanged, {out_path} untouched")
        return

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)

    hits = sum(1 for r in rows if json.loads(r["value"])["hit"])
    print(f"ok: {len(rows)} entries ({hits} hits, {len(rows) - hits} miss-sentinels) -> {out_path}")


if __name__ == "__main__":
    main()
