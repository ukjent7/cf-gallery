"""Build store_cache.json: deterministic DLsite/DMM URLs from EGS IDs (no API calls)."""
import json, re

store = json.load(open('store_ids.json', encoding='utf-8'))

def group_folder(rid):
    m = re.match(r'^([A-Z]+)(\d+)$', rid)
    prefix, digits = m.group(1), m.group(2)
    n = int(digits)
    g = ((n - 1) // 1000 + 1) * 1000
    return f"{prefix}{g:0{len(digits)}d}"

def dlsite_worktype(rid):
    if rid.startswith('VJ'):
        return 'professional'
    return 'doujin'

cache = {}
for gid, v in store.items():
    rid = v.get('dlsite_id')
    domain = v.get('dlsite_domain') or 'maniax'
    entry = {}
    if rid and re.match(r'^[A-Z]+\d+$', rid):
        wt = dlsite_worktype(rid)
        folder = group_folder(rid)
        base = f"https://img.dlsite.jp/modpub/images2/work/{wt}/{folder}/{rid}"
        samples = v.get('dlsite_samples')
        entry['dlsite'] = {
            'id': rid,
            'wt': wt,
            'folder': folder,
            'domain': domain,
            'n': len(samples) if samples else int(v.get('dlsite_n', 0) or 0),
            'page': f"https://www.dlsite.com/{domain}/work/=/product_id/{rid}.html",
        }
        if samples:
            entry['dlsite']['samples'] = samples
    cid = v.get('dmm')
    if cid:
        entry['dmm'] = {'id': cid, 'n': int(v.get('dmm_n', 0) or 0)}
    cid2 = v.get('dmm2')
    is_boxed2 = bool(cid2) and re.match(r'^[0-9]+[a-z]+[0-9]+[a-z]?$', cid2, re.I)
    has_digital = bool(cid) and not re.match(r'^[0-9]+[a-z]+[0-9]+[a-z]?$', cid, re.I)
    # Digital-first, boxed-fallback: a boxed (mono) counterpart is kept when
    # the game has no digital/download edition, so boxed-only games still
    # show FANZA instead of dropping it entirely.
    if cid2 and cid2 != cid and (not is_boxed2 or not has_digital):
        entry['dmm2'] = {'id': cid2, 'n': int(v.get('dmm2_n', 0) or 0)}
    if v.get('comike'):
        entry['getchu'] = {'id': v['comike'], 'page': f"https://www.getchu.com/soft.phtml?id={v['comike']}"}
    if entry:
        cache[gid] = entry

json.dump(cache, open('store_cache.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
n_dl = sum(1 for e in cache.values() if 'dlsite' in e)
n_dmm = sum(1 for e in cache.values() if 'dmm' in e)
n_gc = sum(1 for e in cache.values() if 'getchu' in e)
print(f"store_cache {len(cache)} dlsite={n_dl} dmm={n_dmm} getchu={n_gc}")
