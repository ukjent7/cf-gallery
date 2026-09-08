"""Build self-contained VNDB gallery HTML for POV559 eroge-only ranking."""
import csv, json, re

csv_path = "pov559_netori_eroge_only_by_median.csv"
cache_path = "vndb_cache_top60.json"
out_path = "vndb_gallery.html"

rows = list(csv.DictReader(open(csv_path, encoding="utf-8-sig")))
cache = json.load(open(cache_path, encoding="utf-8"))
try:
    store_cache = json.load(open("store_cache.json", encoding="utf-8"))
except FileNotFoundError:
    store_cache = {}

data = []
for r in rows:
    data.append({
        "rank": int(r["rank"]),
        "gid": r["game_id"],
        "name": r["gamename"],
        "brand": r["brandname"],
        "sellday": r["sellday"],
        "median": int(r["median"]) if r["median"] else None,
        "count2": int(r["count2_get_score"]) if r["count2_get_score"] else 0,
        "votes": int(r["pov_votes"]) if r["pov_votes"] else 0,
    })

slim = {}
for gid, v in cache.items():
    pick = v.get("pick")
    if pick:
        slim[gid] = {
            "id": pick.get("id"),
            "title": pick.get("title"),
            "alttitle": pick.get("alttitle"),
            "released": pick.get("released"),
            "image": pick.get("image"),
            "shots": (pick.get("screenshots") or [])[:30],
            "extra": [
                {"id": e.get("id"), "title": e.get("title"), "alttitle": e.get("alttitle")}
                for e in (v.get("extra_vns") or []) if e.get("id")
            ],
            "release": v.get("release"),
            "via": v.get("via"),
        }
    else:
        slim[gid] = None

data_json = json.dumps(data, ensure_ascii=False)
cache_json = json.dumps(slim, ensure_ascii=False)
store_json = json.dumps(store_cache, ensure_ascii=False)
try:
    getchu_json = json.dumps(json.load(open("getchu_meta.json", encoding="utf-8")), ensure_ascii=False)
except FileNotFoundError:
    getchu_json = "{}"
try:
    fullcg_json = json.dumps(json.load(open("fullcg_links.json", encoding="utf-8")), ensure_ascii=False)
except FileNotFoundError:
    fullcg_json = "{}"

html_doc = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>POV559 寝取り EROGE排名画廊 - 封面+Screenshots</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#111;color:#eee}
header{position:sticky;top:0;z-index:10;background:#1a1a1a;border-bottom:1px solid #333;padding:12px 16px}
header h1{margin:0;font-size:18px}
header p{margin:6px 0 0;font-size:13px;color:#aaa}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.controls input[type=text]{flex:1;min-width:180px;padding:8px;border-radius:8px;border:1px solid #444;background:#222;color:#eee}
.controls select,.controls button{padding:8px 10px;border-radius:8px;border:1px solid #444;background:#222;color:#eee}
.controls label{font-size:13px;color:#ccc;display:flex;align-items:center;gap:6px}
#stats{font-size:13px;color:#999;margin:10px 16px 0}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:12px 16px 40px}
.card{background:#1d1d1d;border:1px solid #333;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.cover{position:relative;aspect-ratio:3/4;background:#000;cursor:pointer}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.cover .rank{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.7);padding:2px 8px;border-radius:999px;font-size:12px}
.cover .median{position:absolute;right:8px;top:8px;background:#e91e63;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
.cover .shotcount{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.7);padding:2px 8px;border-radius:999px;font-size:12px}
.cover .novndb{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;font-size:13px;padding:20px;text-align:center}
.cover .loadbtn{position:absolute;inset:auto 8px 8px 8px;padding:8px;border-radius:8px;border:1px solid #555;background:rgba(30,30,30,.9);color:#fff;cursor:pointer;font-size:13px}
.meta{padding:10px 10px 6px}
.meta h3{margin:0 0 4px;font-size:14px;line-height:1.4}
.meta .sub{font-size:12px;color:#aaa;line-height:1.6}
.actions{display:flex;gap:6px;padding:8px 10px 10px}
.actions a,.actions button{flex:1;text-align:center;font-size:12px;padding:6px;border-radius:8px;border:1px solid #444;background:#262626;color:#eee;text-decoration:none;cursor:pointer}
#more{display:block;margin:0 auto 40px;padding:10px 24px;border-radius:999px;border:1px solid #555;background:#222;color:#fff;cursor:pointer}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;z-index:50;overflow:auto;padding:20px}
#modal.open{display:block}
#modal .box{max-width:900px;margin:0 auto;background:#1d1d1d;border-radius:12px;padding:16px}
#modal img.big{width:100%;max-height:60vh;object-fit:contain;background:#000;border-radius:8px;cursor:zoom-in}
#modal .sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-top:12px}
#modal .sgrid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;cursor:zoom-in;background:#000}
#close{float:right}
.tab.on{background:#e91e63;border-color:#e91e63;color:#fff}
.hint{font-size:12px;color:#888}
#viewer{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;z-index:100;align-items:center;justify-content:center;flex-direction:column;padding:16px}
#viewer.open{display:flex}
#viewer img{max-width:min(1100px,96vw);max-height:82vh;object-fit:contain;background:#000;border-radius:8px}
#viewer .bar{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;color:#ccc}
#viewer button{padding:8px 14px;border-radius:999px;border:1px solid #555;background:#222;color:#fff;cursor:pointer}
</style>
</head>
<body>
<header>
<h1>POV559 寝取り / EROGE限定 / 中央值排名画廊</h1>
<p>数据：ErogameScape 中央值 + 票数。图片：VNDB开放接口 + DLsite/FANZA官方直链（EGS自带ID拼接）+ EGS官方转存直连 + Getchu经Worker代理（线上版；本地双击走EGS转存降级）。点封面看截图，点截图页内放大。</p>
<div class="controls">
<button id="tabAll" class="tab on">综合</button>
<button id="tabVndb" class="tab">VNDB</button>
<button id="tabDlsite" class="tab">DLsite</button>
<button id="tabDmm" class="tab">FANZA</button>
<button id="tabGc" class="tab">官方图</button>
<input id="q" type="text" placeholder="搜索 游戏名 / 品牌 / VNDB标题">
<select id="minMedian"><option value="0">中央值 ≥ 0</option><option value="70">中央值 ≥ 70</option><option value="80">中央值 ≥ 80</option><option value="85">中央值 ≥ 85</option><option value="90">中央值 ≥ 90</option></select>
<label><input id="onlyMatched" type="checkbox"> 只看已匹配VNDB</label>
<label><input id="autoFetch" type="checkbox" checked> 滚动自动查VNDB</label>
<button id="reset">重置</button>
</div>
</header>
<div id="stats"></div>
<div id="grid"></div>
<button id="more">加载更多</button>
<div id="modal"><div class="box"><button id="close">关闭</button><div id="mbody"></div></div></div>
<div id="viewer"><img id="vimg" alt="viewer"><div class="bar"><button id="vprev">上一张</button><span id="vcap"></span><button id="vnext">下一张</button><button id="vopen">原图新签页</button><button id="vclose">关闭</button></div></div>
<script>
const DATA = __DATA__;
const CACHE = __CACHE__;
const STORE = __STORE__;
const GETCHU = __GETCHU__;
const FULLCG = __FULLCG__;
function fullcgOf(gid){ return FULLCG[String(gid)] || null; }
function fullcgGoogleHitomi(name, alt){
  let q = 'site:hitomi.la gamecg "' + name + '"';
  if (alt && alt !== name) q += ' OR "' + alt + '"';
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}
function fullcgGoogleEh(name, alt){
  let q = 'site:e-hentai.org "' + name + '"';
  if (alt && alt !== name) q += ' OR "' + alt + '"';
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}
// Brand -> group tag slug. ASCII brands only (Waffle -> waffle,
// Alice Soft -> alice_soft); Japanese brands cannot be romanized
// reliably, so those fall back to title-only search.
function brandSlug(brand){
  const b = String(brand || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,40}$/.test(b)) return null;
  const s = b.toLowerCase().replace(/[\\s.'-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return s || null;
}
// On-site search URLs (verified format): hitomi takes the raw query
// after search.html? (gallery-dl HitomiSearchExtractor), e-hentai uses
// f_search with $ for exact tag match (EHWiki Gallery Searching).
function hitomiSiteUrl(item, alt){
  const parts = ["type:gamecg"];
  const g = brandSlug(item.brand);
  if (g) parts.push("group:" + g);
  parts.push((alt && alt !== item.name) ? alt : item.name);
  return "https://hitomi.la/search.html?" + encodeURIComponent(parts.join(" "));
}
function ehSiteUrl(item, alt){
  const parts = [];
  const g = brandSlug(item.brand);
  if (g) parts.push("group:" + g + "$");
  const t = (alt && alt !== item.name) ? alt : item.name;
  parts.push('title:"' + t + '"');
  return "https://e-hentai.org/?f_search=" + encodeURIComponent(parts.join(" ")) + "&f_apply=Apply+Filter";
}
function fullcgHtml(item, alt){
  const e = fullcgOf(item.gid);
  const direct = [];
  if (e && e.hitomi) direct.push(`<a href="${esc(e.hitomi)}" target="_blank" rel="noopener">hitomi全CG直连</a>`);
  if (e && e.ehentai) direct.push(`<a href="${esc(e.ehentai)}" target="_blank" rel="noopener">e-hentai全CG直连</a>`);
  const g = brandSlug(item.brand);
  const hUrl = hitomiSiteUrl(item, alt);
  const sUrl = ehSiteUrl(item, alt);
  const gHitomi = fullcgGoogleHitomi(item.name, alt);
  const gEh = fullcgGoogleEh(item.name, alt);
  const keys = alt && alt !== item.name ? esc(item.name) + " / " + esc(alt) : esc(item.name);
  return `<h3>全CG（站外）</h3>`
    + (direct.length ? `<p>已核实：${direct.join(" | ")}</p>` : "")
    + `<p><a href="${esc(hUrl)}" target="_blank" rel="noopener">hitomi站内搜${g ? "(group:" + esc(g) + ")" : "(标题)"}</a> | <a href="${esc(sUrl)}" target="_blank" rel="noopener">e-hentai站内搜${g ? "(group:" + esc(g) + "$)" : "(标题)"}</a></p>`
    + `<p><a href="${esc(gHitomi)}" target="_blank" rel="noopener">Google搜hitomi全CG</a> | <a href="${esc(gEh)}" target="_blank" rel="noopener">Google搜e-hentai全CG</a></p>`
    + `<p class="hint">站内搜关键词：${keys}${g ? "＋品牌group:" + esc(g) : "（品牌是日文拼不出group标签，只用标题搜）"}。先用本页官方截图核对是否为同一作，全CG图不在本画廊内展示，对方站内需各自过年龄确认/登录。</p>`;
}
const GCN = Object.values(GETCHU).filter(x=>x&&x.ok).length;
let TAB = "all";
const API = "https://api.vndb.org/kana/vn";
let filtered = DATA.slice();
let shown = 0;
const PAGE = 36;
const liveCache = new Map(Object.entries(CACHE));
const pending = new Map();
try {
  const ls = JSON.parse(localStorage.getItem("vndb_live_v3") || "{}");
  for (const [k,v] of Object.entries(ls)) if (!liveCache.has(k) && v) liveCache.set(k, v);
} catch(e) {}
function saveLive(){
  try {
    const o = {};
    for (const [k,v] of liveCache) if (v && !CACHE[k]) o[k]=v;
    localStorage.setItem("vndb_live_v3", JSON.stringify(o).slice(0, 900000));
  } catch(e) {}
}
// VNDB省流队列：最多2并发，请求间隔800ms
const queue = [];
let active = 0;
let lastStart = 0;
function pump(){
  if (active >= 2) return;
  const job = queue.shift();
  if (!job) return;
  const wait = Math.max(0, 800 - (Date.now() - lastStart));
  active++;
  setTimeout(async ()=>{
    lastStart = Date.now();
    try { job.resolve(await doFetch(job.item)); }
    catch(e){ job.resolve(null); }
    finally { active--; pump(); }
  }, wait);
}
function normT(s){return String(s||"").replace(/[～〜]/g,"~").replace(/[　]/g," ").trim();}
function normVariants(title){
  const out=[title];
  const push=x=>{ x=String(x||"").trim(); if(x&&!out.includes(x)&&out.length<6) out.push(x); };
  let v=String(title).replace(/[\\(\（][^\\)）]{0,30}[\\)）]\\s*$/,"").trim();
  push(v);
  const tails=[/\\s+DVD EDITION\\s*$/i,/\\s+EXTENDED EDITION\\s*$/i,/\\s+WORLD'S END COMPLETE\\s*$/i,/\\s+COMPLETE\\s*$/i,/パワーアップキット\\s*$/, /限定再装版\\s*$/, /\\s+Re-order～?\\s*$/i, /～chocolat second brew Re-order～\\s*$/i];
  for (const base of [...out]) for (const pat of tails) push(base.replace(pat,""));
  for (const base of [...out]){
    for (const sep of ["〜","～"," -"," "]){
      if (base.includes(sep)&&base.length>8){ const core=base.split(sep)[0].trim(); if(core.length>=3) push(core); break; }
    }
  }
  return out;
}
function exactPick(list, queries){
  for (const q of queries){
    const nq=normT(q).toLowerCase();
    for (const c of list){
      for (const k of [c.alttitle||"",c.title||""]){
        if (normT(k).toLowerCase()===nq) return c;
      }
    }
  }
  return null;
}
function containsPick(list, core){
  const nc=normT(core).toLowerCase();
  if (nc.length<3) return null;
  for (const c of list){
    for (const k of [c.alttitle||"",c.title||""]){
      if (normT(k).toLowerCase().includes(nc)) return c;
    }
  }
  return null;
}
async function apiPost(path, body){
  const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok) return null;
  return r.json();
}
async function vnSearch(t){ const j=await apiPost(API,{filters:["search","=",t],fields:"title, alttitle, image{url,thumbnail}, screenshots{url,thumbnail}, released",results:3}); return (j&&j.results)||[]; }
async function relSearch(t){ const j=await fetch("https://api.vndb.org/kana/release",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filters:["search","=",t],fields:"title, alttitle, vns{id,title}, released",results:3})}).then(r=>r.ok?r.json():null).catch(()=>null); return (j&&j.results)||[]; }
async function vnById(vid){ const j=await apiPost(API,{filters:["id","=",vid],fields:"title, alttitle, image{url,thumbnail}, screenshots{url,thumbnail}, released"}); return j&&j.results&&j.results[0]; }
function toSlim(v, extra, release, via){ return {id:v.id,title:v.title,alttitle:v.alttitle,released:v.released,image:v.image,shots:(v.screenshots||[]).slice(0,30),extra:(extra||[]).map(e=>({id:e.id,title:e.title,alttitle:e.alttitle})),release:release||null,via:via||null}; }
async function doFetch(item){
  const variants=normVariants(item.name);
  // 先 VN 搜：要求精确命中原标题或变体
  for (const v of variants){
    let list=[];
    try{ list=await vnSearch(v); }catch(e){ continue; }
    if(!list.length) continue;
    let pick=exactPick(list,[item.name,v]);
    if(pick){ const s=toSlim(pick,null,null,"vn:"+v); liveCache.set(item.gid,s); saveLive(); return s; }
    // 短变体只接受包含关系，防止 街ヤリ 这类模糊噪音
    if(v!==item.name){ pick=containsPick(list,v); if(pick&&((pick.alttitle||pick.title||"").length<30||v.length>=4)){ const s=toSlim(pick,null,null,"vn-core:"+v); liveCache.set(item.gid,s); saveLive(); return s; } }
  }
  // 再发行版搜：r -> v
  for (const v of variants){
    let rels=[];
    try{ rels=await relSearch(v); }catch(e){ continue; }
    if(!rels.length) continue;
    const rel=rels[0];
    const ids=(rel.vns||[]).slice(0,3).map(x=>x.id);
    if(!ids.length) continue;
    const details=[];
    for (const id of ids){ try{ const d=await vnById(id); if(d) details.push(d); }catch(e){} }
    if(!details.length) continue;
    let primary=exactPick(details,[item.name,v])||containsPick(details,v);
    if(!primary) continue;
    const extra=details.filter(d=>d.id!==primary.id);
    const s=toSlim(primary,extra,{id:rel.id,title:rel.title},"release:"+v+":"+rel.id);
    liveCache.set(item.gid,s); saveLive();
    return s;
  }
  liveCache.set(item.gid,null);
  return null;
}
function ensureVndb(item){
  if (liveCache.has(item.gid)) return Promise.resolve(liveCache.get(item.gid));
  if (pending.has(item.gid)) return pending.get(item.gid);
  const p = new Promise(resolve=>{ queue.push({item, resolve}); pump(); }).then(v=>{
    pending.delete(item.gid);
    return v;
  });
  pending.set(item.gid, p);
  return p;
}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function vndbSearchUrl(name){return "https://vndb.org/v?sq="+encodeURIComponent(name);}
function egsUrl(gid){return "https://erogamescape.dyndns.org/~ap2/ero/toukei_kaiseki/game.php?game="+gid;}
let observer = null;
function getObserver(){
  if (observer) return observer;
  observer = new IntersectionObserver(entries=>{
    if (!document.getElementById("autoFetch").checked) return;
    if (TAB !== "vndb" && TAB !== "all") return;
    for (const en of entries){
      if (!en.isIntersecting) continue;
      const gid = en.target.dataset.gid;
      const item = DATA.find(d=>String(d.gid)===String(gid));
      observer.unobserve(en.target);
      if (item && !liveCache.has(gid)) ensureVndb(item).then(v=>{ if(v) refreshCard(gid, v); else refreshCard(gid, null); });
    }
  }, {rootMargin:"400px"});
  return observer;
}
function applyFilter(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const mm = +document.getElementById("minMedian").value;
  const om = document.getElementById("onlyMatched").checked;
  filtered = DATA.filter(d=>{
    if ((d.median||0) < mm) return false;
    if (om){
      if (TAB === "dlsite" && !(storeOf(d.gid)&&storeOf(d.gid).dlsite)) return false;
      else if (TAB === "dmm" && !dmmList(st).length) return false;
      else if (TAB === "getchu" && !gcIdOf(d)) return false;
      else if (TAB === "all"){
        const st0 = storeOf(d.gid);
        if (!liveCache.get(d.gid) && !(st0&&(st0.dlsite||st0.dmm))) return false;
      }
      else if (TAB === "vndb" && !liveCache.get(d.gid)) return false;
    }
    if (!q) return true;
    const v = liveCache.get(d.gid);
    const st = storeOf(d.gid);
    const hay = (d.name+" "+d.brand+" "+(v?v.title||"":"")+" "+(v?v.alttitle||"":"")+" "+(st&&st.dlsite?st.dlsite.id:"")+" "+dmmList(st).map(e=>e.id).join(" ")).toLowerCase();
    return hay.includes(q);
  });
  shown = 0;
  document.getElementById("grid").innerHTML = "";
  renderMore();
}
function storeOf(gid){ return STORE[String(gid)] || null; }
function dlMain(d){return `https://img.dlsite.jp/modpub/images2/work/${d.wt}/${d.folder}/${d.id}_img_main.webp`;}
function dlThumb(d){return `https://img.dlsite.jp/resize/images2/work/${d.wt}/${d.folder}/${d.id}_img_main_240x240.webp`;}
function dlSampleUrl(d,stem){return `https://img.dlsite.jp/modpub/images2/work/${d.wt}/${d.folder}/${d.id}_img_${stem}.webp`;}
function dlStems(d){return (d&&d.samples&&d.samples.length?d.samples:Array.from({length:(d&&d.n||0)},(_,k)=>"smp"+(k+1)));}
function dlSamples(d){return dlStems(d).map(s=>dlSampleUrl(d,s));}
function dlSampleThumb(d,stem){return `https://img.dlsite.jp/resize/images2/work/${d.wt}/${d.folder}/${d.id}_img_${stem}_100x100.jpg`;}
function dlThumbs(d){return dlStems(d).map(s=>dlSampleThumb(d,s));}
function dlJpg(u){return u.replace(/\\.webp$/,".jpg");}
function dmThumb(cid){ const p=dmPkg(cid); return /^d_/i.test(cid) ? p : p.replace(/pl\\.jpg$/,"ps.jpg"); }
function dmBigSmall(cid,i){ const u=dmSampleUrls(cid,i); const small=u[1]||u[0]; const rest=(u[1]?[u[0]].concat(u.slice(2)):u.slice(1)); return {big:u[0], small, rest}; }
function dmPkg(cid){ if(/^d_/i.test(cid)) return `https://doujin-assets.dmm.co.jp/digital/game/${cid}/${cid}pr.jpg`; if(/apc|will|mono/i.test(cid)) return `https://pics.dmm.co.jp/mono/game/${cid}/${cid}pl.jpg`; return `https://pics.dmm.co.jp/digital/pcgame/${cid}/${cid}pl.jpg`;}
function dmSampleUrls(cid,i){
  // jp- is the full-size sample, js- is a 120x90 thumbnail. Verified.
  const z=String(i).padStart(3,"0");
  const big=`https://pics.dmm.co.jp/digital/pcgame/${cid}/${cid}jp-${z}.jpg`;
  const small=`https://pics.dmm.co.jp/digital/pcgame/${cid}/${cid}js-${z}.jpg`;
  if(/^d_/i.test(cid)) return [`https://doujin-assets.dmm.co.jp/digital/game/${cid}/${cid}jp-${z}.jpg`, `https://doujin-assets.dmm.co.jp/digital/game/${cid}/${cid}js-${z}.jpg`, big];
  if(/apc|will|mono/i.test(cid)) return [`https://pics.dmm.co.jp/mono/game/${cid}/${cid}jp-${z}.jpg`, `https://pics.dmm.co.jp/mono/game/${cid}/${cid}js-${z}.jpg`];
  return [big, small];
}
// FANZA only shows the download edition (digital/doujin floors). Boxed
// (mono) images are covered by Getchu instead, so boxed cids are ignored.
function dmmIsBoxed(cid){ return /^[0-9]+[a-z]+[0-9]+[a-z]?$/i.test(cid||""); }
function dmmDigi(st){ if(!st) return null; if(st.dmm&&!dmmIsBoxed(st.dmm.id)) return st.dmm; if(st.dmm2) return st.dmm2; return null; }
function dmmList(st){ const d=dmmDigi(st); return d?[d]:[]; }
function dmmFloor(cid){ if(/^d_/i.test(cid)) return "同人"; if(/^[0-9]+[a-z]+[0-9]+[a-z]?$/i.test(cid)) return "盒装版"; return "下载版"; }
function dmmPageUrl(cid){ if(/^d_/i.test(cid)) return `https://www.dmm.co.jp/dc/doujin/-/detail/=/cid=${cid}/`; if(/^[0-9]+[a-z]+[0-9]+$/i.test(cid)) return `https://www.dmm.co.jp/mono/pcgame/-/detail/=/cid=${cid}/`; return `https://dlsoft.dmm.co.jp/detail/${cid}/`; }
function dmmSearchUrl(q){ return "https://www.dmm.co.jp/search/=/searchstr="+encodeURIComponent(q); }
function egsImg(gid,n){return `https://ap2.sakura.ne.jp/erogamescape/img_official/${Math.floor(+gid/1000)}/${gid}/${String(n).padStart(3,"0")}.jpg`;}
function chainErr(el){
  const fb=(el.dataset.fb||"").split("|").filter(u=>u&&u!==el.src);
  if(fb.length){el.dataset.fb=fb.slice(1).join("|");el.dataset.full=fb[0];el.src=fb[0];}
  else el.remove();
}
function viewIdx(list, im){
  const urls=[im.currentSrc, im.src, im.dataset.full].filter(Boolean);
  for(const u of urls){const k=list.findIndex(x=>x.full===u||x.thumb===u);if(k>=0)return k;}
  return 0;
}
function storeCounts(st){const d=st&&st.dlsite?dlSamples(st.dlsite).length:0;const m=dmmList(st).reduce((a,e)=>a+(e.n||0),0);return {d,m};}
function gcIdOf(item){const st=storeOf(item.gid);return st&&st.getchu?st.getchu.id:null;}
function gcPage(cid){return `https://www.getchu.com/soft.phtml?id=${cid}`;}
// USE_GC: only when served over http(s) by the Worker (or serve_gallery.py);
// file:// has no same-origin /gc/* backend, fall back to direct EGS links.
const USE_GC = location.protocol === "http:" || location.protocol === "https:";
function gcCoverUrl(cid){return `/gc/cover/${cid}.jpg`;}
function gcSampleUrl(cid,n){return `/gc/sample/${cid}/${n}.jpg`;}
async function gcCount(cid){
  const r = await fetch(`gc/meta/${cid}`);
  if (!r.ok) throw new Error("meta " + r.status);
  const j = await r.json();
  if (!j || !Number.isInteger(j.n) || j.n <= 0) throw new Error("empty");
  return Math.min(j.n, 40);
}
// Lazy self-healing: the Worker parses the real sample list on demand and
// caches it in KV. Baked-in counts go stale; when meta knows more, append.
function dmMeta(cid){
  return fetch(`/dm/meta/${encodeURIComponent(cid)}`).then(r=>{
    if (!r.ok) throw new Error("meta "+r.status); return r.json();
  }).then(j=>(j&&Number.isInteger(j.n)?j:null)).catch(()=>null);
}
function dlMeta(rid, domain){
  return fetch(`/dl/meta/${encodeURIComponent(rid)}?domain=${encodeURIComponent(domain||"maniax")}`).then(r=>{
    if (!r.ok) throw new Error("meta "+r.status); return r.json();
  }).then(j=>(j&&Array.isArray(j.samples)?j:null)).catch(()=>null);
}
function bindGridImg(im, viewList){
  im.style.cursor="zoom-in";
  im.addEventListener("click", ()=>openViewer(viewList, viewIdx(viewList, im)));
}
function dmExtend(e, viewList){
  dmMeta(e.id).then(m=>{
    if (!m || m.n <= (e.n||0)) return;
    const grid = document.getElementById("dmsgrid-"+e.id);
    if (!grid) return;
    const fl = dmmFloor(e.id);
    for (let k=(e.n||0)+1;k<=Math.min(m.n,60);k++){
      const {big, small, rest}=dmBigSmall(e.id, k);
      if (viewList.some(y=>y.full===big)) continue;
      viewList.push({thumb:small, full:big, label:`${fl} sample${k}`});
      const im=document.createElement("img");
      im.loading="lazy"; im.decoding="async"; im.alt="sample";
      im.src=small; im.dataset.fb=rest.join("|"); im.dataset.full=big;
      im.onerror=()=>chainErr(im);
      bindGridImg(im, viewList);
      grid.appendChild(im);
    }
    const c=document.getElementById("dmcnt-"+e.id);
    if (c) c.textContent=m.n;
  });
}
function dlExtend(d, viewList){
  dlMeta(d.id, d.domain).then(m=>{
    if (!m || !m.samples.length) return;
    const baked=dlStems(d);
    let tail=[];
    if (!baked.length) tail=m.samples;
    else if (m.samples.length>baked.length && baked.every((s,i)=>m.samples[i]===s)) tail=m.samples.slice(baked.length);
    if (!tail.length) return;
    const grid=document.getElementById("dlsgrid");
    if (!grid) return;
    tail.forEach(stem=>{
      const s=dlSampleUrl(d,stem), t=dlSampleThumb(d,stem);
      if (viewList.some(y=>y.full===s)) return;
      viewList.push({thumb:t, full:s, label:"DLsite sample"});
      const im=document.createElement("img");
      im.loading="lazy"; im.decoding="async"; im.alt="sample";
      im.src=t; im.dataset.fb=s+"|"+dlJpg(s); im.dataset.full=s;
      im.onerror=()=>chainErr(im);
      bindGridImg(im, viewList);
      grid.appendChild(im);
    });
    const c=document.getElementById("dlcnt");
    if (c) c.textContent=baked.length+tail.length;
  });
}
function firstCover(item, v){
  // 质量排序：FANZA > EGS官方转存 > VNDB > DLsite
  const st = storeOf(item.gid);
  const vv = (v&&v.image)?(v.image.url||v.image.thumbnail):"";
  const dl = (st&&st.dlsite)?dlMain(st.dlsite):"";
  const egs = egsImg(item.gid, 1);
  const ds=dmmList(st);
  if (ds.length){
    const src = dmPkg(ds[0].id);
    return {src, fb:[egs, vv, dl].filter(u=>u&&u!==src)};
  }
  return {src:egs, fb:[vv, dl].filter(Boolean)};
}
function cardHtml(item, v){
  const st = storeOf(item.gid);
  let cover, badge, sub2;
  if (TAB === "dlsite"){
    const d = st && st.dlsite;
    const n = d ? (d.n||0) : 0;
    cover = d ? `<img loading="lazy" decoding="async" src="${esc(dlMain(d))}" alt="dlsite">` : `<div class="novndb">EGS无DLsite ID</div>`;
    badge = d ? `<span class="shotcount">${n}张sample</span>` : "";
    sub2 = d ? esc(d.id) : "无DLsite";
  } else if (TAB === "dmm"){
    const ds = dmmList(st);
    const d = ds[0];
    const n = ds.reduce((a,e)=>a+(e.n||0),0);
    const pkgs = ds.map(e=>dmPkg(e.id));
    cover = d ? `<img loading="lazy" decoding="async" src="${esc(pkgs[0])}" data-fb="${esc(ds.slice(1).map(e=>dmPkg(e.id)).join("|"))}" data-full="${esc(pkgs[0])}" onerror="chainErr(this)" alt="fanza">` : `<div class="novndb">EGS无FANZA CID</div>`;
    badge = d ? `<span class="shotcount">${n}张sample</span>` : "";
    sub2 = ds.length ? esc(ds.map(e=>`${e.id}(${dmmFloor(e.id)})`).join(" / ")) : "无FANZA";
  } else if (TAB === "all"){
    const vn = v && v.shots ? v.shots.length : 0;
    const nd = st && st.dlsite ? (st.dlsite.n||0) : 0;
    const nm = dmmList(st).reduce((a,e)=>a+(e.n||0),0);
    const fc = firstCover(item, v);
    if (fc.src) cover = `<img loading="lazy" decoding="async" src="${esc(fc.src)}" data-fb="${esc((fc.fb||[]).join("|"))}" data-full="${esc(fc.src)}" onerror="chainErr(this)" alt="cover">`;
    else cover = `<div class="novndb">暂无图片<br>进入视口后自动查VNDB，或点下方按钮</div>`;
    badge = `<span class="shotcount">共${vn+nd+nm}张</span>`;
    const parts = [];
    if (v) parts.push(esc(v.title||v.id));
    if (st&&st.dlsite) parts.push(esc(st.dlsite.id));
    dmmList(st).forEach(e=>parts.push(esc(e.id)));
    sub2 = parts.join(" / ") || "未匹配";
  } else if (TAB === "getchu"){
    const cid = gcIdOf(item);
    const e1 = egsImg(item.gid, 1);
    if (USE_GC && cid) cover = `<img loading="lazy" decoding="async" src="${esc(gcCoverUrl(cid))}" data-fb="${esc(e1)}" data-full="${esc(gcCoverUrl(cid))}" onerror="chainErr(this)" alt="getchu">`;
    else cover = `<img loading="lazy" decoding="async" src="${esc(e1)}" data-full="${esc(e1)}" onerror="chainErr(this)" alt="official">`;
    badge = `<span class="shotcount">官方/Getchu</span>`;
    sub2 = cid ? ("Getchu id=" + esc(cid)) : "EGS官方转存";
  } else {
    cover = v && v.image ? `<img loading="lazy" decoding="async" src="${esc(v.image.url||v.image.thumbnail)}" data-fb="${esc(v.image.thumbnail||"")}" data-full="${esc(v.image.url||"")}" onerror="chainErr(this)" alt="cover">` : `<div class="novndb">VNDB未匹配<br>进入视口后自动查，或点下方按钮</div>`;
    badge = v && v.shots ? `<span class="shotcount">${v.shots.length}张截图</span>` : "";
    sub2 = v ? esc(v.title||"") + (v.alttitle? " / "+esc(v.alttitle):"") : "未匹配";
  }
  const manual = ((TAB === "vndb" || TAB === "all") && !v && !liveCache.has(item.gid)) ? `<button class="loadbtn" data-act="fetch" data-gid="${esc(item.gid)}">查VNDB封面</button>` : "";
  const extra = ((TAB === "vndb" || TAB === "all") && v && v.extra && v.extra.length) ? `<br><span class="hint">合集另含：${v.extra.map(e=>`<a href="https://vndb.org/${esc(e.id)}" target="_blank" rel="noopener">${esc(e.alttitle||e.title)}</a>`).join(" / ")}${v.release?`（发行 ${esc(v.release.id)}）`:""}</span>` : "";
  const glink = st && st.getchu ? ` / <a href="${esc(st.getchu.page)}" target="_blank" rel="noopener">Getchu</a>` : "";
  return `<div class="cover" data-gid="${esc(item.gid)}">${cover}<span class="rank">#${item.rank}</span><span class="median">${item.median}</span>${badge}${manual}</div>
  <div class="meta"><h3>${esc(item.name)}</h3><div class="sub">${esc(item.brand)} / ${esc(item.sellday)}<br>中央值 ${item.median} / 评分 ${item.count2}人 / 标签 ${item.votes}票<br><span class="hint">${sub2}</span>${extra}</div></div>
  <div class="actions"><button data-act="detail" data-gid="${esc(item.gid)}">详情/截图</button><a href="${tabLink(item, v)}" target="_blank" rel="noopener">${tabLinkText(v)}</a><a href="${egsUrl(item.gid)}" target="_blank" rel="noopener">EGS</a>${glink}</div>`;
}
function tabLink(item, v){
  const st = storeOf(item.gid);
  if (TAB === "dlsite") return st&&st.dlsite ? st.dlsite.page : vndbSearchUrl(item.name);
  if (TAB === "dmm") return dmmSearchUrl(item.name);
  if (TAB === "getchu"){ const cid=gcIdOf(item); return cid?gcPage(cid):vndbSearchUrl(item.name); }
  if (TAB === "all"){
    const st2 = storeOf(item.gid);
    if (st2&&st2.dlsite) return st2.dlsite.page;
    return v ? "https://vndb.org/"+v.id : vndbSearchUrl(item.name);
  }
  return v ? "https://vndb.org/"+v.id : vndbSearchUrl(item.name);
}
function tabLinkText(v){
  if (TAB === "dlsite") return "DLsite";
  if (TAB === "dmm") return "FANZA";
  if (TAB === "getchu") return "Getchu";
  if (TAB === "all") return "商店/VNDB";
  return v ? "VNDB" : "VNDB搜索";
}
function setTab(t){
  TAB = t;
  for (const [id, name] of [["tabAll","all"],["tabVndb","vndb"],["tabDlsite","dlsite"],["tabDmm","dmm"],["tabGc","getchu"]])
    document.getElementById(id).classList.toggle("on", name===t);
  const om = document.querySelector('label input#onlyMatched');
  if (om && om.parentNode) om.parentNode.childNodes[om.parentNode.childNodes.length-1].textContent = t==="vndb" ? " 只看已匹配VNDB" : (t==="dlsite" ? " 只看有DLsite" : (t==="dmm" ? " 只看有FANZA" : (t==="getchu" ? " 只看Getchu收录" : " 只看有图")));
  applyFilter();
}
function renderMore(){
  const grid = document.getElementById("grid");
  const slice = filtered.slice(shown, shown+PAGE);
  for (const item of slice){
    const div = document.createElement("div");
    div.className = "card";
    div.dataset.gid = String(item.gid);
    div.innerHTML = cardHtml(item, liveCache.get(item.gid) || null);
    grid.appendChild(div);
    div.querySelector(".cover").addEventListener("click", e=>{
      if (e.target.closest('[data-act="fetch"]')) return;
      openDetail(item.gid);
    });
    const fb = div.querySelector('[data-act="fetch"]');
    if (fb) fb.addEventListener("click", e=>{ e.stopPropagation(); ensureVndb(item).then(v=>refreshCard(item.gid, v)); });
    getObserver().observe(div);
  }
  shown += slice.length;
  document.getElementById("stats").textContent = `共 ${filtered.length} / 1021 个（EROGE限定）。VNDB预取60/匹配53，其余可视自动查（2并发/800ms）；DLsite覆盖__NDL__，FANZA下载版覆盖__NDMMD__，Getchu盒装图直连。当前Tab：${TAB}。已显示 ${shown} 个。`;
  document.getElementById("more").style.display = shown>=filtered.length ? "none" : "block";
}
function refreshCard(gid, v){
  const div = document.querySelector(`.card[data-gid="${CSS.escape(String(gid))}"]`);
  if (!div) return;
  const item = DATA.find(d=>String(d.gid)===String(gid));
  div.innerHTML = cardHtml(item, v || null);
  div.querySelector(".cover").addEventListener("click", e=>{
    if (e.target.closest('[data-act="fetch"]')) return;
    openDetail(item.gid);
  });
  const fb = div.querySelector('[data-act="fetch"]');
  if (fb) fb.addEventListener("click", e=>{ e.stopPropagation(); ensureVndb(item).then(nv=>refreshCard(item.gid, nv)); });
}
// 页内放大 viewer
let vList = [];
let vIdx = 0;
function openViewer(list, idx){
  vList = list; vIdx = idx || 0;
  updateViewer();
  document.getElementById("viewer").classList.add("open");
}
function updateViewer(){
  const cur = vList[vIdx];
  if (!cur) return;
  const img = document.getElementById("vimg");
  img.src = cur.full;
  document.getElementById("vcap").textContent = `${vIdx+1} / ${vList.length} ${cur.label||""}`;
}
function closeViewer(){ document.getElementById("viewer").classList.remove("open"); document.getElementById("vimg").removeAttribute("src"); }
document.getElementById("vprev").onclick = ()=>{ if(vList.length){ vIdx = (vIdx-1+vList.length)%vList.length; updateViewer(); } };
document.getElementById("vnext").onclick = ()=>{ if(vList.length){ vIdx = (vIdx+1)%vList.length; updateViewer(); } };
document.getElementById("vclose").onclick = closeViewer;
document.getElementById("vopen").onclick = ()=>{ const cur=vList[vIdx]; if(cur) window.open(cur.full, "_blank", "noopener"); };
document.getElementById("viewer").addEventListener("click", e=>{ if(e.target.id==="viewer") closeViewer(); });
document.addEventListener("keydown", e=>{
  if (!document.getElementById("viewer").classList.contains("open")) {
    if (e.key==="Escape") document.getElementById("modal").classList.remove("open");
    return;
  }
  if (e.key==="Escape") closeViewer();
  if (e.key==="ArrowLeft") document.getElementById("vprev").click();
  if (e.key==="ArrowRight") document.getElementById("vnext").click();
});
function openStoreDetail(item, st, viewList, coverHtml, shotsHtml, linkUrl, linkText){
  const glink = st && st.getchu ? ` | <a href="${esc(st.getchu.page)}" target="_blank" rel="noopener">Getchu(id=${esc(st.getchu.id)})</a>` : "";
  document.getElementById("mbody").innerHTML = `<h2>#${item.rank} ${esc(item.name)}</h2>
  <p class="hint">${esc(item.brand)} / ${esc(item.sellday)} / 中央值 ${item.median} / 评分 ${item.count2} / 标签 ${item.votes}票</p>
  ${coverHtml}
  <div class="sgrid">${shotsHtml}</div>
  ${fullcgHtml(item)}
  <p><a href="${linkUrl}" target="_blank" rel="noopener">${linkText}</a> | <a href="${egsUrl(item.gid)}" target="_blank" rel="noopener">在EGS打开</a>${glink}</p>`;
  document.getElementById("modal").classList.add("open");
  const mc = document.getElementById("mcover");
  if (mc){ mc.style.cursor="zoom-in"; mc.addEventListener("click", ()=>openViewer(viewList, viewIdx(viewList, mc))); }
  document.querySelectorAll("#mbody .sgrid img").forEach((im)=>{
    im.style.cursor="zoom-in";
    im.addEventListener("click", ()=>openViewer(viewList, viewIdx(viewList, im)));
  });
}
async function openDetail(gid){
  const item = DATA.find(d=>String(d.gid)===String(gid));
  const st = storeOf(gid);
  if (TAB === "dlsite"){
    const d = st && st.dlsite;
    const sl = d ? dlSamples(d) : [];
    const th = d ? dlThumbs(d) : [];
    const viewList = [];
    if (d){ viewList.push({thumb:dlThumb(d), full:dlMain(d), label:"主图 "+d.id}); sl.forEach((s,i)=>viewList.push({thumb:th[i]||s, full:s, label:"sample"+(i+1)})); }
    const dlshots = d ? `<p class="hint" style="grid-column:1/-1">DLsite（${esc(d.id)}，<span id="dlcnt">${sl.length}</span>张sample）</p><div class="sgrid" style="grid-column:1/-1" id="dlsgrid">`+sl.map((s,i)=>`<img loading="lazy" decoding="async" src="${esc(th[i]||s)}" data-fb="${esc(s+"|"+dlJpg(s))}" data-full="${esc(s)}" onerror="chainErr(this)">`).join("")+`</div>` : "<p class='hint'>EGS无DLsite ID。</p>";
    openStoreDetail(item, st, viewList, d ? `<img class="big" id="mcover" src="${esc(dlMain(d))}">` : "", dlshots, d ? d.page : vndbSearchUrl(item.name), "在DLsite打开");
    if (USE_GC && d) dlExtend(d, viewList);
    return;
  }
  if (TAB === "dmm"){
    const ds = dmmList(st);
    const viewList = [];
    ds.forEach(e=>{
      const fl = dmmFloor(e.id);
      viewList.push({thumb:dmThumb(e.id), full:dmPkg(e.id), label:`包图 ${fl} ${e.id}`});
      for (let i=1;i<=(e.n||0);i++){ const {big, small}=dmBigSmall(e.id,i); if(!viewList.some(y=>y.full===big)) viewList.push({thumb:small, full:big, label:`${fl} sample${i}`}); }
    });
    const simgs = ds.map(e=>{
      const fl = dmmFloor(e.id);
      return `<p class="hint" style="grid-column:1/-1">${fl} ${esc(e.id)}（<span id="dmcnt-${esc(e.id)}">${e.n||0}</span>张） <a href="${dmmPageUrl(e.id)}" target="_blank" rel="noopener">商品页</a></p><div class="sgrid" style="grid-column:1/-1" id="dmsgrid-${esc(e.id)}">`+Array.from({length:(e.n||0)},(_,k)=>{
        const {big, small, rest}=dmBigSmall(e.id, k+1);
        return `<img loading="lazy" decoding="async" src="${esc(small)}" data-fb="${esc(rest.join("|"))}" data-full="${esc(big)}" onerror="chainErr(this)" alt="sample">`;
      }).join("")+`</div>`;
    }).join("");
    const pkgs = ds.map(e=>dmPkg(e.id));
    const dcover = ds.length ? `<img class="big" id="mcover" src="${esc(pkgs[0])}" data-fb="${esc(pkgs.slice(1).join("|"))}" data-full="${esc(pkgs[0])}" onerror="chainErr(this)">` : "";
    openStoreDetail(item, st, viewList, dcover, ds.length ? simgs : "<p class='hint'>EGS无FANZA CID。</p>", dmmSearchUrl(item.name), "FANZA搜索（双版本）");
    if (USE_GC) ds.forEach(e=>dmExtend(e, viewList));
    return;
  }
  if (TAB === "getchu"){
    const cid = gcIdOf(item);
    // Prefer the Worker proxy (/gc/*) when served over http(s); fall back
    // to EGS mirror slots on file:// or when meta lookup fails.
    let shots = [];
    if (USE_GC && cid){
      try {
        const n = await gcCount(cid);
        shots.push({src: gcCoverUrl(cid), fb: egsImg(item.gid, 1)});
        for (let k=1;k<=n;k++) shots.push({src: gcSampleUrl(cid,k), fb: egsImg(item.gid,k)});
      } catch(e){ shots = []; }
    }
    if (!shots.length){
      for (let k=1;k<=8;k++){ const u = egsImg(item.gid,k); shots.push({src:u, fb:""}); }
    }
    const viewList = shots.map((s,k)=>({thumb:s.src, full:s.src, label:"Getchu/官方"+(k+1)}));
    const slots = shots.map(s=>`<img loading="lazy" decoding="async" src="${esc(s.src)}"${s.fb?` data-fb="${esc(s.fb)}"`:""} data-full="${esc(s.src)}" onerror="chainErr(this)" alt="getchu">`).join("");
    document.getElementById("mbody").innerHTML = `<h2>#${item.rank} ${esc(item.name)}</h2>
    <p class="hint">${esc(item.brand)} / ${esc(item.sellday)} / 中央值 ${item.median} / 评分 ${item.count2} / 标签 ${item.votes}票<br>Getchu经Worker代理直连（file://下走EGS转存）${cid?`（id=`+esc(cid)+`）`:""}</p>
    <div class="sgrid">${slots}</div>
    ${fullcgHtml(item)}
    <p>${cid?`<a href="${gcPage(cid)}" target="_blank" rel="noopener">在Getchu打开</a> | `:""}<a href="${egsUrl(item.gid)}" target="_blank" rel="noopener">在EGS打开</a></p>`;
    document.getElementById("modal").classList.add("open");
    document.querySelectorAll("#mbody .sgrid img").forEach((im)=>{
      im.style.cursor="zoom-in";
      im.addEventListener("click", ()=>openViewer(viewList, viewIdx(viewList, im)));
    });
    return;
  }
  if (TAB === "all"){
    let v = liveCache.get(gid);
    if (v === undefined){ v = await ensureVndb(item).catch(()=>null); }
    const viewList = [];
    const secs = [];
    if (v && v.image){ viewList.push({thumb:(v.image.thumbnail||v.image.url), full:v.image.url, label:"VNDB封面"}); }
    if (v && v.shots) v.shots.forEach((s,i)=>viewList.push({thumb:(s.thumbnail||s.url), full:s.url, label:"VNDB"+(i+1)}));
    const vStart = viewList.length;
    let dlHtml = "";
    if (st && st.dlsite){
      const sl = dlSamples(st.dlsite);
      const th = dlThumbs(st.dlsite);
      viewList.push({thumb:dlThumb(st.dlsite), full:dlMain(st.dlsite), label:"DLsite主图 "+st.dlsite.id});
      sl.forEach((s,i)=>viewList.push({thumb:th[i]||s, full:s, label:"DLsite sample"+(i+1)}));
      dlHtml = `<h3>DLsite（${st.dlsite.id}，<span id="dlcnt">${sl.length}</span>张sample）</h3><img class="big" data-vi="${viewList.length-sl.length-1}" src="${esc(dlMain(st.dlsite))}"><div class="sgrid" id="dlsgrid">`+sl.map((s,i)=>`<img loading="lazy" decoding="async" src="${esc(th[i]||s)}" data-fb="${esc(s+"|"+dlJpg(s))}" data-full="${esc(s)}" onerror="chainErr(this)">`).join("")+`</div><p><a href="${esc(st.dlsite.page)}" target="_blank" rel="noopener">在DLsite打开</a></p>`;
    }
    let dmHtml = "";
    if (dmmList(st).length){
      const ds = dmmList(st);
      const dmSecs = ds.map(e=>{
        const fl = dmmFloor(e.id);
        const pkg = dmPkg(e.id);
        viewList.push({thumb:dmThumb(e.id), full:pkg, label:`FANZA包图 ${fl} ${e.id}`});
        for (let i=1;i<=(e.n||0);i++){ const {big, small}=dmBigSmall(e.id,i); if(!viewList.some(y=>y.full===big)) viewList.push({thumb:small, full:big, label:`FANZA ${fl} sample${i}`}); }
        const simgs = Array.from({length:(e.n||0)},(_,k)=>{
          const {big, small, rest}=dmBigSmall(e.id, k+1);
          return `<img loading="lazy" decoding="async" src="${esc(small)}" data-fb="${esc(rest.join("|"))}" data-full="${esc(big)}" onerror="chainErr(this)" alt="sample">`;
        }).join("");
        return `<h3>FANZA ${fl}（${e.id}，<span id="dmcnt-${esc(e.id)}">${e.n||0}</span>张sample）</h3><img class="big" data-full="${esc(pkg)}" src="${esc(pkg)}" onerror="chainErr(this)"><div class="sgrid" id="dmsgrid-${esc(e.id)}">${simgs}</div><p><a href="${dmmPageUrl(e.id)}" target="_blank" rel="noopener">商品页（${fl}）</a></p>`;
      }).join("");
      dmHtml = dmSecs+`<p><a href="${dmmSearchUrl(item.name)}" target="_blank" rel="noopener">FANZA搜索（双版本）</a></p>`;
    }
    const vShots = v&&v.shots ? v.shots.map(s=>`<img loading="lazy" decoding="async" src="${esc(s.thumbnail||s.url)}" data-full="${esc(s.url)}">`).join("") : "";
    let gcHtml = "";
    {
      const cid = gcIdOf(item);
      let shots = [];
      if (USE_GC && cid){
        try {
          const n = await gcCount(cid);
          shots.push({src: gcCoverUrl(cid), fb: egsImg(item.gid, 1)});
          for (let k=1;k<=n;k++) shots.push({src: gcSampleUrl(cid,k), fb: egsImg(item.gid,k)});
        } catch(e){ shots = []; }
      }
      if (!shots.length){
        for (let k=1;k<=8;k++){ const u = egsImg(item.gid,k); shots.push({src:u, fb:""}); }
      }
      shots.forEach((s,k)=>viewList.push({thumb:s.src, full:s.src, label:"Getchu"+(k+1)}));
      gcHtml = `<h3>Getchu${USE_GC&&cid?"（Worker代理）":"（EGS转存）"}</h3><div class="sgrid">`+shots.map(s=>`<img loading="lazy" decoding="async" src="${esc(s.src)}"${s.fb?` data-fb="${esc(s.fb)}"`:""} data-full="${esc(s.src)}" onerror="chainErr(this)" alt="getchu">`).join("")+`</div>`;
    }
    const glink = st && st.getchu ? ` | <a href="${esc(st.getchu.page)}" target="_blank" rel="noopener">Getchu(id=${esc(st.getchu.id)})</a>` : "";
    document.getElementById("mbody").innerHTML = `<h2>#${item.rank} ${esc(item.name)}</h2>
    <p class="hint">${esc(item.brand)} / ${esc(item.sellday)} / 中央值 ${item.median} / 评分 ${item.count2} / 标签 ${item.votes}票<br>VNDB: ${v?esc(v.title||"")+" / "+esc(v.alttitle||"")+" / "+esc(v.id):"未匹配（可切VNDB Tab手动查）"} </p>
    ${v&&v.image?`<h3>VNDB截图（${v.shots?v.shots.length:0}张）</h3><img class="big" data-vi="0" src="${esc(v.image.url||v.image.thumbnail)}"><div class="sgrid">${vShots}</div>`:"<p class='hint'>VNDB未匹配。</p>"}
    ${dlHtml}${dmHtml}${gcHtml}
    ${fullcgHtml(item, v&&v.alttitle)}
    <p><a href="${v?"https://vndb.org/"+v.id:vndbSearchUrl(item.name)}" target="_blank" rel="noopener">VNDB</a> | <a href="${egsUrl(item.gid)}" target="_blank" rel="noopener">EGS</a>${glink} | <button data-act="refetch" data-gid="${esc(item.gid)}">重查VNDB</button></p>`;
    document.getElementById("modal").classList.add("open");
    document.querySelectorAll("#mbody img.big, #mbody .sgrid img").forEach(im=>{
      im.style.cursor = "zoom-in";
      im.addEventListener("click", ()=>openViewer(viewList, viewIdx(viewList, im)));
    });
    if (USE_GC){
      if (st && st.dlsite) dlExtend(st.dlsite, viewList);
      dmmList(st).forEach(e=>dmExtend(e, viewList));
    }
    return;
  }
  let v = liveCache.get(gid);
  if (v === undefined){ v = await ensureVndb(item).catch(()=>null); }
  const coverFull = v&&v.image ? v.image.url : null;
  const shots = v&&v.shots ? v.shots : [];
  const viewList = [];
  if (coverFull) viewList.push({thumb:(v.image.thumbnail||coverFull), full:coverFull, label:"封面"});
  shots.forEach((s,i)=>viewList.push({thumb:(s.thumbnail||s.url), full:s.url, label:"截图"+(i+1)}));
  const shotsHtml = shots.length ? shots.map((s,i)=>`<img loading="lazy" decoding="async" src="${esc(s.thumbnail||s.url)}" data-i="${viewList.findIndex(x=>x.full===s.url)}" alt="shot">`).join("") : "<p class='hint'>暂无截图，可去VNDB手动搜。</p>";
  const extraHtml = v&&v.extra&&v.extra.length ? `<br>合集另含：${v.extra.map(e=>`<a href="https://vndb.org/${esc(e.id)}" target="_blank" rel="noopener">${esc(e.alttitle||e.title)} (${esc(e.id)})</a>`).join(" / ")}` : "";
  document.getElementById("mbody").innerHTML = `<h2>#${item.rank} ${esc(item.name)}</h2>
  <p class="hint">${esc(item.brand)} / ${esc(item.sellday)} / 中央值 ${item.median} / 评分 ${item.count2} / 标签 ${item.votes}票<br>VNDB: ${v?esc(v.title)+" / "+esc(v.alttitle||"")+" / "+esc(v.id):"未匹配"}${extraHtml}${v&&v.release?`<br>经发行版映射：${esc(v.release.title||"")} (${esc(v.release.id)})`:""}${v&&v.via?`<br>匹配方式：${esc(v.via)}`:""} </p>
  ${v&&v.image?`<img class="big" id="mcover" src="${esc(v.image.url||v.image.thumbnail)}" data-full="${esc(v.image.url)}">`:""}
  <div class="sgrid">${shotsHtml}</div>
  ${fullcgHtml(item, v&&v.alttitle)}
  <p><a href="${v?"https://vndb.org/"+v.id:vndbSearchUrl(item.name)}" target="_blank" rel="noopener">在VNDB打开</a> | <a href="${egsUrl(item.gid)}" target="_blank" rel="noopener">在EGS打开</a> | <button data-act="refetch" data-gid="${esc(item.gid)}">重查VNDB</button></p>`;
  document.getElementById("modal").classList.add("open");
  const mc = document.getElementById("mcover");
  if (mc) mc.addEventListener("click", ()=>openViewer(viewList, 0));
  document.querySelectorAll("#mbody .sgrid img").forEach(im=>{
    im.addEventListener("click", ()=>openViewer(viewList, +im.dataset.i));
  });
}
document.getElementById("more").onclick = ()=>renderMore();
document.getElementById("tabAll").onclick = ()=>setTab("all");
document.getElementById("tabVndb").onclick = ()=>setTab("vndb");
document.getElementById("tabDlsite").onclick = ()=>setTab("dlsite");
document.getElementById("tabDmm").onclick = ()=>setTab("dmm");
document.getElementById("tabGc").onclick = ()=>setTab("getchu");
document.getElementById("q").oninput = ()=>applyFilter();
document.getElementById("minMedian").onchange = ()=>applyFilter();
document.getElementById("onlyMatched").onchange = ()=>applyFilter();
document.getElementById("reset").onclick = ()=>{document.getElementById("q").value="";document.getElementById("minMedian").value="0";document.getElementById("onlyMatched").checked=false;applyFilter();};
document.getElementById("close").onclick = ()=>document.getElementById("modal").classList.remove("open");
document.getElementById("modal").addEventListener("click", e=>{ if(e.target.id==="modal") e.target.classList.remove("open"); });
document.addEventListener("click", e=>{
  const b = e.target.closest('[data-act="detail"]');
  if (b) openDetail(b.dataset.gid);
  const rf = e.target.closest('[data-act="refetch"]');
  if (rf){
    const gid = String(rf.dataset.gid);
    liveCache.delete(gid); pending.delete(gid);
    try{
      const ls = JSON.parse(localStorage.getItem("vndb_live_v3") || "{}");
      delete ls[gid]; localStorage.setItem("vndb_live_v3", JSON.stringify(ls));
    }catch(err){}
    const item = DATA.find(d=>String(d.gid)===gid);
    ensureVndb(item).then(v=>{ refreshCard(gid, v); openDetail(gid); });
  }
});
applyFilter();
</script>
</body>
</html>
"""

html_doc = html_doc.replace("__DATA__", data_json).replace("__CACHE__", cache_json).replace("__STORE__", store_json).replace("__GETCHU__", getchu_json).replace("__FULLCG__", fullcg_json)
n_dl = sum(1 for e in store_cache.values() if e.get("dlsite"))
n_dmmd = sum(1 for e in store_cache.values()
             if (e.get("dmm") and not re.match(r"^[0-9]+[a-z]+[0-9]+$",
                e["dmm"]["id"], re.I)) or e.get("dmm2"))
html_doc = html_doc.replace("__NDL__", str(n_dl)).replace("__NDMMD__", str(n_dmmd))
open(out_path, "w", encoding="utf-8").write(html_doc)
print(f"wrote {out_path} rows={len(data)} cache={len(slim)}")
