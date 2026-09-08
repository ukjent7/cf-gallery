"""Recount actual FANZA sample counts from detail pages.

EGS dmm_sample_image_count is stale (e.g. Hentai Prison stored as 3,
actually 11), which truncates the gallery. Fetch each digital/doujin
detail page once and record the real max sample number.

Writes dmm_counts.json incrementally (resume-safe), then overwrites
dmm_n/dmm2_n in store_ids.json. Throttled.

Usage: python3 recount_dmm.py [--limit N] [--gids GID,GID] [--merge-only]
"""
import json
import sys
import time

sys.path.insert(0, ".")
from enrich_dmm import (detail_url, floor_of_cid, get, sample_count,
                        COOKIES, THROTTLE, UA)

import requests

STORE_PATH = "store_ids.json"
OUT_PATH = "dmm_counts.json"


def doujin_detail_url(cid):
    return f"https://www.dmm.co.jp/dc/doujin/-/detail/=/cid={cid}/"


def count_for(cid, floor, session):
    url = detail_url(cid, floor)
    if floor == "doujin":
        url = doujin_detail_url(cid)
    if not url:
        return None
    html = get(url, session)
    time.sleep(THROTTLE)
    if not html:
        return None
    import re
    nums = [int(n) for _, n in
            re.findall(re.escape(cid) + r"(js|jp)-(\d+)\.jpg", html)]
    return max(nums) if nums else 0


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
        session.cookies.update(COOKIES)
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
            r = {"gid": gid, "ok": False}
            targets = []
            if v.get("dmm") and floor_of_cid(v["dmm"]) != "boxed":
                targets.append(("n", v["dmm"], floor_of_cid(v["dmm"])))
            if v.get("dmm2"):
                targets.append(("n2", v["dmm2"], "digital"))
            if not targets:
                r["reason"] = "skip"
            else:
                try:
                    r["ok"] = True
                    for key, cid, floor in targets:
                        c = count_for(cid, floor, session)
                        r[key] = c
                        if c is None:
                            r["ok"] = False
                except Exception as e:
                    r.update({"ok": False, "reason": f"error {e}"})
            done[gid] = r
            json.dump(done, open(OUT_PATH, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            print(f"[{i+1}/{len(gids)}] {gid} ok={r.get('ok')} "
                  f"n={r.get('n')} n2={r.get('n2')} {r.get('reason', '')}",
                  flush=True)

    done = json.load(open(OUT_PATH, encoding="utf-8"))
    store = json.load(open(STORE_PATH, encoding="utf-8"))
    n = 0
    for gid, r in done.items():
        if not r.get("ok") or gid not in store:
            continue
        if r.get("n") is not None and store[gid].get("dmm"):
            store[gid]["dmm_n"] = r["n"]
            n += 1
        if r.get("n2") is not None and store[gid].get("dmm2"):
            store[gid]["dmm2_n"] = r["n2"]
            n += 1
    import shutil
    shutil.copy(STORE_PATH, STORE_PATH + ".bak")
    json.dump(store, open(STORE_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"merged counts={n}")


if __name__ == "__main__":
    main()
