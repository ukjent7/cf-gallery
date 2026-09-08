#!/usr/bin/env python3
"""Build wrangler kv bulk put file from workspace seed data (stdlib only).

Reads <workspace>/getchu_meta.json ({cid: {gid, n, ok}}), keeps ok==True
with n>0 (n<=0 means "no samples" and the worker answers 404 for those,
so seeding them would be misleading), writes JSON array of
{"key": "meta:{cid}", "value": "{\"n\":N,\"ts\":T}"}. value must be a
string per `wrangler kv bulk put` format. ts is milliseconds to match
what the worker writes on fresh fetches.

Usage: python3 make-kv-bulk.py [seed.json] [out.json]
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(os.path.dirname(HERE))
DEFAULT_SEED = os.path.join(WORKSPACE, "getchu_meta.json")
DEFAULT_OUT = os.path.join(os.path.dirname(HERE), "kv-bulk.json")


def main():
    seed_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SEED
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    with open(seed_path, encoding="utf-8") as f:
        seed = json.load(f)
    ts = int(time.time() * 1000)
    rows = []
    for cid, ent in seed.items():
        if not isinstance(ent, dict) or ent.get("ok") is not True:
            continue
        if not str(cid).isdigit():
            continue
        n = int(ent.get("n", 0))
        if n <= 0:
            continue
        rows.append({
            "key": f"meta:{cid}",
            "value": json.dumps({"n": n, "ts": ts},
                                ensure_ascii=False),
        })
    rows.sort(key=lambda r: int(r["key"].split(":", 1)[1]))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"ok: {len(rows)} entries -> {out_path} (ts={ts})")


if __name__ == "__main__":
    main()
