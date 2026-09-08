#!/usr/bin/env python3
"""Prepare gallery payloads: CSV/JSON inputs -> one build/data.json.

Pure data transform. No HTML, no CSS, no JavaScript: the front-end is authored
normally under src/gallery/ and assembled by bundle.py.

The output shape is deliberately lean. Fields the browser can derive were
dropped, because the whole document is inlined into one HTML file and every
byte is paid on first load:

  STORE.dlsite  {id, wt, folder, domain, n, page, samples}
             -> {id, d, n, sm?}    wt/folder/page derive from id (urls.js);
                                   sm only when stems are not plain smp1..smpN
  STORE.dmm     {id, n, page}   -> {id, n}
  STORE.getchu  {id, page}      -> {id, n?}  n merged in from getchu_meta.json
  CACHE         image{url,thumbnail} + shots[{url,thumbnail}]
             -> img:"<url>" + shots:["<url>"]   thumbnails derive via vnThumb()
  GETCHU        (whole payload) -> removed; only feed GCN, which was unused

Verified derivable against the current dataset (see test/build.test.js):
0 mismatches on 744 dlsite pages, 723 getchu pages, 744 wt, 744 folders,
507/555 VNDB thumbnails (the rest are cover-image forms vnThumb handles).

Usage: python scripts/prep_data.py [--root DIR]
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WORKSPACE = os.path.dirname(REPO)
DATA_DIR = os.path.join(REPO, "data")
OUT_DIR = os.path.join(REPO, "build")

INPUTS = {
    "csv": "pov559_netori_eroge_only_by_median.csv",
    "vndb_cache": "vndb_cache_top60.json",
    "store_cache": "store_cache.json",
    "getchu_meta": "getchu_meta.json",
    "fullcg": "fullcg_links.json",
    "brand_group": "brand_group.json",
}

# repo/data holds the committed snapshot that a fresh clone builds from. The
# workspace is searched last because the crawl scripts (enrich_dlsite.py,
# recount_dmm.py, ...) write their results there.
SEARCH_DIRS = [DATA_DIR, WORKSPACE]


def find(key):
    """Locate INPUTS[key], preferring the repo snapshot. Warn if a newer copy
    exists elsewhere so a stale commit can never silently win."""
    name = INPUTS[key]
    chosen = None
    for d in SEARCH_DIRS:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            chosen = p
            break
    if chosen is None:
        return None
    for d in SEARCH_DIRS:
        other = os.path.join(d, name)
        if other == chosen or not os.path.isfile(other):
            continue
        if os.path.getmtime(other) > os.path.getmtime(chosen) + 1:
            print(f"warning: {name} is newer at {other}\n"
                  f"         but building from {chosen}\n"
                  f"         (copy it into {DATA_DIR} to update the snapshot)")
    return chosen


def load(key, default=None):
    path = find(key)
    if path is None:
        if default is None:
            sys.exit(f"error: input {INPUTS[key]} not found in {SEARCH_DIRS}")
        print(f"note: {INPUTS[key]} missing, using default")
        return default
    if path.endswith(".csv"):
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def as_int(v):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


# Mirrors dlStems() in src/urls.js: a missing stem list with a non-zero count is
# not derivable, so it is flagged instead of silently guessed.
def lean_dlsite(d):
    out = {"id": d["id"], "d": d.get("domain") or "maniax", "n": as_int(d.get("n"))}
    stems = d.get("samples") or []
    plain = stems == [f"smp{i + 1}" for i in range(len(stems))]
    if stems and not plain:
        out["sm"] = stems
    if not stems and out["n"]:
        # A count exists but the crawl never collected stem names, so
        # smp1..smpN is a guess rather than a derivation. Flagged so the gallery
        # asks live meta exactly once for these instead of trusting the guess.
        out["un"] = 1
    return out


def lean_dmm(e):
    return {"id": e["id"], "n": as_int(e.get("n"))}


def lean_store(store_cache, getchu_meta):
    """{gid: {l, m, m2, g}} keeping only irreducible facts."""
    out = {}
    for gid, v in store_cache.items():
        if not isinstance(v, dict):
            continue
        e = {}
        if v.get("dlsite"):
            e["l"] = lean_dlsite(v["dlsite"])
        for key, short in (("dmm", "m"), ("dmm2", "m2")):
            if v.get(key):
                e[short] = lean_dmm(v[key])
        if v.get("getchu"):
            g = {"id": str(v["getchu"]["id"])}
            # Baking the crawled sample count means the Getchu tab never asks
            # the Worker, which is the single largest KV write saving.
            meta = getchu_meta.get(g["id"])
            if isinstance(meta, dict) and meta.get("ok") is True:
                g["n"] = as_int(meta.get("n"))
            e["g"] = g
        if e:
            out[str(gid)] = e
    return out


def lean_cache(vndb_cache):
    """{gid: {id, title, alttitle, released, img, shots[urls], extra, release, via}}"""
    out = {}
    for gid, v in vndb_cache.items():
        pick = (v or {}).get("pick")
        if not pick:
            out[str(gid)] = None
            continue
        out[str(gid)] = {
            "id": pick.get("id"),
            "title": pick.get("title"),
            "alttitle": pick.get("alttitle"),
            "released": pick.get("released"),
            "img": url_of(pick.get("image")),
            "shots": [u for u in (url_of(s) for s in (pick.get("screenshots") or [])[:30]) if u],
            "extra": [
                {"id": e.get("id"), "title": e.get("title"), "alttitle": e.get("alttitle")}
                for e in ((v or {}).get("extra_vns") or []) if e.get("id")
            ],
            "release": (v or {}).get("release"),
            "via": (v or {}).get("via"),
        }
    return out


def url_of(x):
    if not x:
        return None
    return x.get("url") if isinstance(x, dict) else str(x)


def main():
    if "--root" in sys.argv:
        i = sys.argv.index("--root")
        SEARCH_DIRS.insert(0, os.path.abspath(sys.argv[i + 1]))

    rows = load("csv")
    data = []
    for r in rows:
        data.append({
            "rank": as_int(r.get("rank")),
            "gid": str(r.get("game_id", "")).strip(),
            "name": r.get("gamename", ""),
            "brand": r.get("brandname", ""),
            "sellday": r.get("sellday", ""),
            "median": as_int(r.get("median")) or None,
            "count2": as_int(r.get("count2_get_score")),
            "votes": as_int(r.get("pov_votes")),
        })

    payloads = {
        "DATA": data,
        "CACHE": lean_cache(load("vndb_cache", {})),
        "STORE": lean_store(load("store_cache", {}), load("getchu_meta", {})),
        "FULLCG": load("fullcg", {}),
        "BRANDG": load("brand_group", {}),
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "data.json")
    # newline="\n" so the artifact is byte-identical on every platform; bundle.py
    # inlines it verbatim into public/index.html.
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payloads, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")

    st = payloads["STORE"]
    print("wrote", out)
    for name, val in payloads.items():
        raw = json.dumps(val, ensure_ascii=False, separators=(",", ":"))
        print(f"  {name:7} {len(val):5} entries  {len(raw.encode('utf-8')):>8,} B")
    print(f"  totals: {len(st)} products with store ids, "
          f"{sum(1 for e in st.values() if 'l' in e)} DLsite, "
          f"{sum(1 for e in st.values() if 'm' in e or 'm2' in e)} FANZA, "
          f"{sum(1 for e in st.values() if 'g' in e)} Getchu, "
          f"{sum(1 for e in st.values() if 'g' in e and 'n' in e['g'])} with baked Getchu counts")


if __name__ == "__main__":
    main()
