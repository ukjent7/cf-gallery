#!/usr/bin/env python3
"""One-command factory pipeline: EGS export -> merge -> enrich -> recount -> cache.

State lives in scripts/factory/state, the published snapshot in data/.
Run from anywhere: python3 scripts/factory/pipeline.py [--stage NAME] [--limit N]

Merge policy (export never touches the live file directly):
- fresh rows win, except where the fresh export is all-null while the
  previous state holds store data (EGS gap, e.g. audit rows): keep previous base;
- a fresh dmm_n of 0 never survives on its own for an unchanged cid:
  a successful recount measurement wins, else the previous positive count
  is kept (delisted pages fetch as empty while their CDN frames still serve);
- enrichment extras (dmm2/dmm2_n/dmm_via/dlsite_samples) always carry over.
Snapshot rows the factory cannot derive (universe extras outside the CSV)
are preserved on sync, never deleted.
"""

import json
import os
import shutil
import subprocess
import sys

FACTORY = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(FACTORY))
STATE = os.path.join(FACTORY, "state")
STORE = os.path.join(STATE, "store_ids.json")
COUNTS = os.path.join(STATE, "dmm_counts.json")

BASE_KEYS = ("dlsite_id", "dlsite_domain", "dmm", "comike", "banner",
             "dmm_n", "dlsite_n")
EXTRA_KEYS = ("dmm2", "dmm2_n", "dmm_via", "dlsite_samples")


def storeless(v):
    return not v.get("dlsite_id") and not v.get("dmm") and not v.get("comike")


def sh(args, limit=None):
    if limit is not None and not any(a in ("--limit", "--gids") for a in args):
        args = args + ["--limit", str(limit)]
    env = dict(os.environ, PYTHONPATH=FACTORY + os.pathsep +
               os.environ.get("PYTHONPATH", ""))
    r = subprocess.run([sys.executable] + args, cwd=STATE, env=env)
    if r.returncode != 0:
        sys.exit(f"pipeline: {' '.join(args)} failed ({r.returncode})")


def sync_csv():
    src = os.path.join(REPO, "data", "pov559_netori_eroge_only_by_median.csv")
    dst = os.path.join(STATE, "pov559_netori_eroge_only_by_median.csv")
    if (not os.path.exists(dst) or
            os.path.getmtime(src) > os.path.getmtime(dst)):
        shutil.copy(src, dst)
        print("pipeline: csv synced")


def stage_export():
    sync_csv()
    shutil.copy(STORE, STORE + ".prev")
    try:
        sh(["../export_stores.py"])
    except SystemExit:
        shutil.copy(STORE + ".prev", STORE)
        raise


def stage_merge():
    if not os.path.exists(STORE + ".prev"):
        print("pipeline: no .prev backup, merge skipped")
        return
    fresh = json.load(open(STORE, encoding="utf-8"))
    prev = json.load(open(STORE + ".prev", encoding="utf-8"))
    try:
        counts = json.load(open(COUNTS, encoding="utf-8"))
    except FileNotFoundError:
        counts = {}
    for gid, old in prev.items():
        new = fresh.get(gid)
        if new is None:
            continue
        if storeless(new) and not storeless(old):
            for k in BASE_KEYS:
                new[k] = old.get(k)
        elif (new.get("dmm") and new.get("dmm_n") == 0
                and new.get("dmm") == old.get("dmm")):
            measured = (counts.get(gid) or {}).get("n")
            if isinstance(measured, int):
                new["dmm_n"] = measured
            elif (old.get("dmm_n") or 0) > 0:
                new["dmm_n"] = old["dmm_n"]
        for k in EXTRA_KEYS:
            if k in old and k not in new:
                new[k] = old[k]
    json.dump(fresh, open(STORE, "w", encoding="utf-8", newline="\n"),
              ensure_ascii=False, indent=1)
    print(f"pipeline: merged {len(fresh)} rows")


def stage_cache():
    sh(["../build_store_cache.py"])
    cache = json.load(open(os.path.join(STATE, "store_cache.json"),
                           encoding="utf-8"))
    dst = os.path.join(REPO, "data", "store_cache.json")
    try:
        snap = json.load(open(dst, encoding="utf-8"))
    except FileNotFoundError:
        snap = {}
    for gid, row in snap.items():
        if gid not in cache:
            cache[gid] = row
    cache = {gid: cache[gid] for gid in sorted(cache, key=int)}
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(cache, ensure_ascii=False, indent=2))
    print("pipeline: snapshot synced")


def main():
    args = sys.argv[1:]
    stage = "all"
    limit = os.environ.get("PIPELINE_LIMIT")
    if "--stage" in args:
        stage = args[args.index("--stage") + 1]
    if "--limit" in args:
        limit = args[args.index("--limit") + 1]
    if stage in ("all", "export"):
        stage_export()
    if stage in ("all", "merge"):
        stage_merge()
    if stage in ("all", "enrich"):
        sh(["../enrich_dmm.py"], limit)
    if stage in ("all", "recount"):
        sh(["../recount_dmm.py"], limit)
    if stage in ("all", "dlsite"):
        sh(["../enrich_dlsite.py"], limit)
    if stage in ("all", "cache"):
        stage_cache()
    if stage not in ("all", "export", "merge", "enrich", "recount",
                     "dlsite", "cache"):
        sys.exit(f"pipeline: unknown stage {stage}")


if __name__ == "__main__":
    main()
