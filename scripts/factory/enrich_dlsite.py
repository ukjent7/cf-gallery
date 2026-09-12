"""Capture exact DLsite sample-image stems per product.

DLsite sample names are not derivable from the product ID: some products
use {id}_img_smp{N} (e.g. RJ136119) while others use {id}_img_smpa{N}
(e.g. VJ011759, VJ01003103). Guessing the stem breaks most samples, so
fetch each product page once and record the real stems.

Writes dlsite_samples.json incrementally (resume-safe), then merges
dlsite_samples/dlsite_samples_n into store_ids.json. Throttled.

Usage: python3 enrich_dlsite.py [--limit N] [--gids GID,GID] [--merge-only]
"""
import json
import re
import sys
import time

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
THROTTLE = 1.0

STORE_PATH = "store_ids.json"
OUT_PATH = "dlsite_samples.json"


def page_url(rid, domain):
    return (f"https://www.dlsite.com/{domain or 'maniax'}/work/=/product_id/"
            f"{rid}.html")


def get(url, session):
    for _ in range(3):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 200 and len(r.content) > 5000:
                r.encoding = "utf-8"
                return r.text
        except Exception:
            pass
        time.sleep(3)
    return None


def parse_samples(rid, html):
    stems = re.findall(re.escape(rid) + r"_img_(smp[a-z]*\d+)\.(?:jpg|webp)",
                       html)
    uniq = []
    for s in stems:
        if s not in uniq:
            uniq.append(s)
    def key(s):
        m = re.match(r"smp([a-z]*)(\d+)$", s)
        return (m.group(1), int(m.group(2)))
    return sorted(uniq, key=key)


def main():
    args = sys.argv[1:]
    limit = None
    only = None
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--gids" in args:
        only = set(args[args.index("--gids") + 1].split(","))
    merge_only = "--merge-only" in args

    if not merge_only:
        store = json.load(open(STORE_PATH, encoding="utf-8"))
        try:
            done = json.load(open(OUT_PATH, encoding="utf-8"))
        except FileNotFoundError:
            done = {}
        session = requests.Session()
        session.headers["User-Agent"] = UA
        gids = sorted(store.keys(), key=int)
        if only:
            gids = [g for g in gids if g in only]
        else:
            gids = [g for g in gids if g not in done]
        if limit:
            gids = gids[:limit]
        print(f"todo {len(gids)}")
        for i, gid in enumerate(gids):
            v = store.get(gid) or {}
            rid = v.get("dlsite_id")
            if not rid or not re.match(r"^[A-Z]+\d+$", rid):
                done[gid] = {"gid": gid, "ok": False, "reason": "skip"}
            else:
                html = get(page_url(rid, v.get("dlsite_domain")), session)
                time.sleep(THROTTLE)
                if not html:
                    done[gid] = {"gid": gid, "ok": False,
                                 "reason": "fetch-failed"}
                else:
                    stems = parse_samples(rid, html)
                    done[gid] = {"gid": gid, "ok": bool(stems),
                                 "samples": stems}
            json.dump(done, open(OUT_PATH, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            r = done[gid]
            print(f"[{i+1}/{len(gids)}] {gid} {rid} ok={r.get('ok')} "
                  f"n={len(r.get('samples') or [])}", flush=True)

    done = json.load(open(OUT_PATH, encoding="utf-8"))
    store = json.load(open(STORE_PATH, encoding="utf-8"))
    n = 0
    for gid, r in done.items():
        if r.get("ok") and gid in store and "dlsite_samples" not in store[gid]:
            store[gid]["dlsite_samples"] = r["samples"]
            n += 1
    import shutil
    shutil.copy(STORE_PATH, STORE_PATH + ".bak")
    json.dump(store, open(STORE_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"merged samples={n}")


if __name__ == "__main__":
    main()
