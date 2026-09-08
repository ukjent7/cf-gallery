"""Discover the counterpart FANZA edition (digital <-> boxed) for each game.

EGS gamelist.dmm holds a single cid per game, but FANZA sells the download
and boxed editions as separate products with different cids and different
screenshots. For each game this script searches DMM by full title, keeps
results whose title contains the game title, classifies the floor
(dlsoft = digital, mono/pcgame = boxed), and records the cid on the
complementary floor as dmm2 with its sample count from the detail page.

Writes dmm_counterparts.json incrementally (resume-safe), then merges
dmm2/dmm2_n into store_ids.json. Throttled single-threaded to stay polite.

Usage: python3 enrich_dmm.py [--limit N] [--gids GID,GID] [--merge-only]
"""
import csv
import json
import re
import sys
import time
import unicodedata

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
COOKIES = {"age_check_done": "1"}
THROTTLE = 1.2
SEARCH_URL = "https://www.dmm.co.jp/search/=/searchstr={q}/"

STORE_PATH = "store_ids.json"
CSV_PATH = "pov559_netori_eroge_only_by_median.csv"
OUT_PATH = "dmm_counterparts.json"


def norm(s):
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s).lower()


def floor_of_cid(cid):
    if re.match(r"^d_", cid, re.I):
        return "doujin"
    if re.match(r"^[0-9]+[a-z]+[0-9]+$", cid, re.I):
        return "boxed"
    return "digital"


def floor_of_url(url):
    if "dlsoft.dmm.co.jp/detail/" in url:
        return "digital"
    if "/mono/pcgame/" in url and "cid=" in url:
        return "boxed"
    if "cid=d_" in url or "/doujin/" in url:
        return "doujin"
    return None


def cid_of_url(url):
    m = re.search(r"dlsoft\.dmm\.co\.jp/detail/([A-Za-z0-9_]+)/?", url)
    if m:
        return m.group(1)
    m = re.search(r"cid=([A-Za-z0-9_]+)", url)
    if m:
        return m.group(1)
    return None


def detail_url(cid, floor):
    if floor == "digital":
        return f"https://dlsoft.dmm.co.jp/detail/{cid}/"
    if floor == "boxed":
        return f"https://www.dmm.co.jp/mono/pcgame/-/detail/=/cid={cid}/"
    return None


def get(url, session):
    for attempt in range(3):
        try:
            r = session.get(url, timeout=30)
            if r.status_code == 200 and len(r.content) > 5000:
                r.encoding = "utf-8"
                return r.text
        except Exception:
            pass
        time.sleep(3)
    return None


def parse_search(html):
    """Return [(cid, floor, title)] for pcgame-floor results in page order."""
    import html as H
    out = []
    cards = re.split(r'<div class="flex py-1\.5 pl-3">', html)
    for card in cards[1:]:
        m = re.search(
            r'<a href="(https://(?:www\.dmm\.co\.jp|dlsoft\.dmm\.co\.jp)[^"]+?)(?:\?[^"]*)?"',
            card)
        if not m:
            continue
        url = m.group(1)
        floor = floor_of_url(url)
        if floor not in ("digital", "boxed"):
            continue
        cid = cid_of_url(url)
        if not cid:
            continue
        title = re.sub(r"\s+", " ",
                       H.unescape(re.sub(r"<[^>]+>", "", card))).strip()[:200]
        out.append((cid, floor, title))
    # dedupe, keep first occurrence (best rank)
    seen = set()
    uniq = []
    for cid, floor, title in out:
        if (cid, floor) not in seen:
            seen.add((cid, floor))
            uniq.append((cid, floor, title))
    return uniq


def sample_count(cid, floor, session):
    url = detail_url(cid, floor)
    if not url:
        return 0
    html = get(url, session)
    if not html:
        return 0
    nums = [int(n) for _, n in
            re.findall(re.escape(cid) + r"(js|jp)-(\d+)\.jpg", html)]
    time.sleep(THROTTLE)
    return max(nums) if nums else 0


def enrich_gid(gid, title, stored, session):
    import urllib.parse
    url = SEARCH_URL.format(q=urllib.parse.quote(title))
    html = get(url, session)
    time.sleep(THROTTLE)
    if not html:
        return {"gid": gid, "ok": False, "reason": "search-fetch-failed"}
    cands = [(c, f, t) for c, f, t in parse_search(html)
             if norm(title) and norm(title) in norm(t)]
    by_floor = {}
    for cid, floor, t in cands:
        by_floor.setdefault(floor, []).append((cid, t))
    res = {"gid": gid, "ok": False, "found": by_floor}
    if stored:
        sfloor = floor_of_cid(stored)
        other = "boxed" if sfloor == "digital" else (
            "digital" if sfloor == "boxed" else None)
        if other and by_floor.get(other):
            cid = by_floor[other][0][0]
            n = sample_count(cid, other, session)
            res.update({"ok": True, "dmm2": cid, "dmm2_n": n,
                        "floor": other, "via": "counterpart-search"})
        else:
            res["reason"] = f"no-{other}-candidate"
    else:
        dig = by_floor.get("digital", [])
        box = by_floor.get("boxed", [])
        if len(dig) == 1 and len(box) <= 1:
            prim, pfl = (dig[0][0], "digital") if dig else (box[0][0], "boxed")
            res.update({"ok": True, "fill": {"dmm": prim, "floor": pfl},
                        "via": "gap-search"})
            if box and dig:
                cid = box[0][0]
                res.update({"dmm2": cid,
                            "dmm2_n": sample_count(cid, "boxed", session)})
        else:
            res["reason"] = (f"ambiguous digital={len(dig)} "
                             f"boxed={len(box)}")
    return res


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
        titles = {r["game_id"]: r["gamename"] for r in
                  csv.DictReader(open(CSV_PATH, encoding="utf-8-sig"))}
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
            title = titles.get(gid, "")
            stored = (store.get(gid) or {}).get("dmm")
            if not title or not stored or floor_of_cid(stored) == "doujin":
                done[gid] = {"gid": gid, "ok": False, "reason": "skip"}
            else:
                try:
                    done[gid] = enrich_gid(gid, title, stored, session)
                except Exception as e:
                    done[gid] = {"gid": gid, "ok": False,
                                 "reason": f"error {e}"}
            json.dump(done, open(OUT_PATH, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            r = done[gid]
            print(f"[{i+1}/{len(gids)}] {gid} {title[:20]} "
                  f"ok={r.get('ok')} {r.get('dmm2', '')} "
                  f"{r.get('reason', '')}", flush=True)

    done = json.load(open(OUT_PATH, encoding="utf-8"))
    store = json.load(open(STORE_PATH, encoding="utf-8"))
    n2 = nf = 0
    for gid, r in done.items():
        if not r.get("ok") or gid not in store:
            continue
        if r.get("dmm2") and not store[gid].get("dmm2"):
            store[gid]["dmm2"] = r["dmm2"]
            store[gid]["dmm2_n"] = r.get("dmm2_n", 0)
            n2 += 1
        if r.get("fill") and not store[gid].get("dmm"):
            store[gid]["dmm"] = r["fill"]["dmm"]
            store[gid]["dmm_n"] = 0
            store[gid]["dmm_via"] = r.get("via")
            nf += 1
    import shutil
    shutil.copy(STORE_PATH, STORE_PATH + ".bak")
    json.dump(store, open(STORE_PATH, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"merged dmm2={n2} gapfill={nf}")


if __name__ == "__main__":
    main()
