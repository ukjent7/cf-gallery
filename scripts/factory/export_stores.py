"""Export store IDs for the 1021 eroge-only games from EGS."""
import csv
import html as H
import json
import os
import re
import sys
import time

import requests

DEFAULT_URL = 'http://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php'
URL = os.environ.get('EGS_URL', DEFAULT_URL)

HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    ),
}
PROXIES = {
    'http': os.environ['EGS_PROXY'],
    'https': os.environ['EGS_PROXY'],
} if os.environ.get('EGS_PROXY') else None

COLS = "id, dlsite_id, dlsite_domain, dmm, comike, banner_url, dmm_sample_image_count, dlsite_sample_image_count"


def probe_egs(session):
    """Fast probe with short connect timeout to test if EGS is reachable."""
    targets = [URL]
    if URL.startswith('https://'):
        targets.append('http://' + URL[len('https://'):])
    for target in targets:
        try:
            r = session.post(
                target,
                data={'sql': 'SELECT 1'},
                headers=HEADERS,
                proxies=PROXIES,
                timeout=(5, 10),
            )
            if r.status_code == 200:
                return target
        except Exception:
            continue
    return None


def run_sql(sql, s=None):
    client = s or session or requests
    r = client.post(
        URL,
        data={'sql': sql},
        headers=HEADERS,
        proxies=PROXIES,
        timeout=(5, 30),
    )
    r.encoding = 'utf-8'
    m = re.search(r'<div id="query_result_main"><table>(.*?)</table>', r.text, re.S)
    if not m:
        raise RuntimeError("no result table: " + r.text[:500])
    tbl = m.group(1)
    trs = re.findall(r'<tr>(.*?)</tr>', tbl, re.S)
    out = []
    for tr in trs[1:]:
        tds = re.findall(r'<td>(.*?)</td>', tr, re.S)
        vals = [H.unescape(re.sub(r'<.*?>', '', c)).strip() for c in tds]
        out.append(vals)
    return out


csv_path = 'pov559_netori_eroge_only_by_median.csv'
if not os.path.exists(csv_path):
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    csv_path = os.path.join(repo_root, 'data', 'pov559_netori_eroge_only_by_median.csv')
rows = list(csv.DictReader(open(csv_path, encoding='utf-8-sig')))
gids = [r['game_id'] for r in rows]
print("total", len(gids))

session = requests.Session()
active_url = probe_egs(session)
if not active_url:
    print(
        "export_stores: EGS (erogamescape.dyndns.org) is unreachable "
        "(connection timed out or IP blocked by host firewall)."
    )
    sys.exit(2)
URL = active_url

store = {}
B = 100
failed_batches = []
for i in range(0, len(gids), B):
    chunk = gids[i:i+B]
    ids = ",".join(chunk)
    sql = f"SELECT {COLS} FROM gamelist WHERE id IN ({ids})"
    for attempt in range(3):
        try:
            data = run_sql(sql)
            for vals in data:
                # order: id, dlsite_id, dlsite_domain, dmm, comike, banner, dmm_cnt, dlsite_cnt
                gid = vals[0]
                store[gid] = {
                    "dlsite_id": vals[1] or None,
                    "dlsite_domain": vals[2] or None,
                    "dmm": vals[3] or None,
                    "comike": vals[4] or None,
                    "banner": vals[5] or None,
                    "dmm_n": int(vals[6]) if vals[6] and vals[6].isdigit() else 0,
                    "dlsite_n": int(vals[7]) if vals[7] and vals[7].isdigit() else 0,
                }
            print(f"batch {i//B+1} ok rows={len(data)}")
            break
        except Exception as e:
            print(f"batch {i//B+1} attempt {attempt+1} ERR {e}")
            time.sleep(3)
    else:
        failed_batches.append(i // B + 1)
        print(f"batch {i//B+1} FAILED")
    time.sleep(1)

# A partial export must not be written: pipeline.py rolls state back on a
# nonzero exit, but only if store_ids.json was never overwritten.
if failed_batches:
    sys.exit(f"export_stores: {len(failed_batches)} batch(es) failed: {failed_batches}")

json.dump(store, open('store_ids.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
have_dlsite = sum(1 for v in store.values() if v.get('dlsite_id'))
have_dmm = sum(1 for v in store.values() if v.get('dmm'))
have_comike = sum(1 for v in store.values() if v.get('comike'))
print(f"saved {len(store)} have_dlsite={have_dlsite} have_dmm={have_dmm} have_comike={have_comike}")
# show examples for the two user cases if present
for gid, v in store.items():
    if v.get('dlsite_id') == 'RJ136119' or v.get('dmm') == 'inf_0128':
        print("HIT", gid, v)
