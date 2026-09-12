"""Export store IDs for the 1021 eroge-only games from EGS."""
import csv, json, re, time, requests

URL = 'https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/sql_for_erogamer_form.php'
rows = list(csv.DictReader(open('pov559_netori_eroge_only_by_median.csv', encoding='utf-8-sig')))
gids = [r['game_id'] for r in rows]
print("total", len(gids))

COLS = "id, dlsite_id, dlsite_domain, dmm, comike, banner_url, dmm_sample_image_count, dlsite_sample_image_count"

def run_sql(sql):
    r = requests.post(URL, data={'sql': sql}, timeout=45)
    r.encoding = 'utf-8'
    m = re.search(r'<div id="query_result_main"><table>(.*?)</table>', r.text, re.S)
    if not m:
        raise RuntimeError("no result table: " + r.text[:500])
    tbl = m.group(1)
    trs = re.findall(r'<tr>(.*?)</tr>', tbl, re.S)
    out = []
    for tr in trs[1:]:
        tds = re.findall(r'<td>(.*?)</td>', tr, re.S)
        # strip tags, unescape
        import html as H
        vals = [H.unescape(re.sub(r'<.*?>', '', c)).strip() for c in tds]
        out.append(vals)
    return out

store = {}
B = 100
for i in range(0, len(gids), B):
    chunk = gids[i:i+B]
    ids = ",".join(chunk)
    sql = f"SELECT {COLS} FROM gamelist WHERE id IN ({ids})"
    for attempt in range(3):
        try:
            data = run_sql(sql)
            for vals in data:
                # order: id, dlsite_id, dlsite_domain, dmm, comike, banner_url, dmm_cnt, dlsite_cnt
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
        print(f"batch {i//B+1} FAILED")
    time.sleep(1)

json.dump(store, open('store_ids.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
have_dlsite = sum(1 for v in store.values() if v.get('dlsite_id'))
have_dmm = sum(1 for v in store.values() if v.get('dmm'))
have_comike = sum(1 for v in store.values() if v.get('comike'))
print(f"saved {len(store)} have_dlsite={have_dlsite} have_dmm={have_dmm} have_comike={have_comike}")
# show examples for the two user cases if present
for gid, v in store.items():
    if v.get('dlsite_id') == 'RJ136119' or v.get('dmm') == 'inf_0128':
        print("HIT", gid, v)
