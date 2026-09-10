// Cross-validation between the three layers that must agree: the Python data
// scripts, src/urls.js, and the shipped public/index.html.
//
// These rules used to be copy-pasted into all three and had silently diverged.
// Instead of trusting each copy, these tests reconstruct what the old payloads
// contained from the new lean ones and compare against the original source data,
// so "the diet lost information" fails loudly.
import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import {
  dlFolder,
  dlMainUrl,
  dlProductUrl,
  dlStems,
  dlWorkType,
  dmmDetailUrl,
  dmmFloor,
  isBoxed,
  parseDlStems,
  parseDmmMax,
  parseSampleMax,
  vnThumb,
} from "../src/urls.js";

const REPO = path.join(import.meta.dir, "..");
const WORKSPACE = path.join(REPO, "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// The full-fidelity source of truth, still in the workspace. If it is absent
// (fresh clone), the repo snapshot in data/ is the same file.
function source(name) {
  for (const dir of [path.join(REPO, "data"), WORKSPACE]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return readJson(p);
  }
  return null;
}

const sourceStore = source("store_cache.json");
const built = readJson(path.join(REPO, "build", "data.json"));

describe("urls.js agrees with the Python derivations", () => {
  test("dlFolder / dlWorkType reproduce build_store_cache.py exactly", () => {
    if (!sourceStore) return;
    let checked = 0;
    for (const v of Object.values(sourceStore)) {
      const d = v?.dlsite;
      if (!d) continue;
      expect(dlWorkType(d.id)).toBe(d.wt);
      expect(dlFolder(d.id)).toBe(d.folder);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("dlProductUrl reproduces the baked page URLs", () => {
    if (!sourceStore) return;
    for (const v of Object.values(sourceStore)) {
      const d = v?.dlsite;
      if (!d?.page) continue;
      expect(dlProductUrl(d.id, d.domain)).toBe(d.page);
    }
  });

  test("getchu product URLs match the baked page field", () => {
    if (!sourceStore) return;
    for (const v of Object.values(sourceStore)) {
      const g = v?.getchu;
      if (!g?.page) continue;
      expect(`https://www.getchu.com/soft.phtml?id=${g.id}`).toBe(g.page);
    }
  });

  test("the one boxed-cid rule matches what the Python counters classified", () => {
    if (!sourceStore) return;
    // n_dmmd in build_gallery.py counted download-edition entries; dmmFloor
    // must classify the same set of cids.
    let download = 0;
    for (const v of Object.values(sourceStore)) {
      for (const key of ["dmm", "dmm2"]) {
        const e = v?.[key];
        if (!e) continue;
        if (dmmFloor(e.id) !== "boxed") download++;
      }
    }
    expect(download).toBeGreaterThan(800);
    // No real cid ends with a trailing letter after the digit run, so the
    // tolerant and strict forms must classify identically here.
    const strict = /^[0-9]+[a-z]+[0-9]+$/i;
    for (const v of Object.values(sourceStore)) {
      for (const key of ["dmm", "dmm2"]) {
        const e = v?.[key];
        if (!e || /^d_/i.test(e.id)) continue;
        expect(isBoxed(e.id)).toBe(strict.test(e.id));
      }
    }
  });
});

describe("the lean payload loses nothing", () => {
  test("STORE can be expanded back to the original facts", () => {
    if (!sourceStore) return;
    const lean = built.STORE;
    const originals = Object.entries(sourceStore).filter(([, v]) =>
      v && (v.dlsite || v.dmm || v.dmm2 || v.getchu));

    expect(Object.keys(lean).length).toBe(originals.length);

    for (const [gid, orig] of originals) {
      const e = lean[gid];
      expect(e, `gid ${gid} dropped from STORE`).toBeTruthy();

      if (orig.dlsite) {
        const d = e.l;
        expect(d.id).toBe(orig.dlsite.id);
        expect(d.n).toBe(orig.dlsite.n || 0);
        expect(d.d).toBe(orig.dlsite.domain || "maniax");
        // The dropped fields are reconstructible, so verify that.
        expect(dlMainUrl({ id: d.id })).toContain(orig.dlsite.id);
        expect(dlProductUrl(d.id, d.d)).toBe(orig.dlsite.page);
        const wantStems = orig.dlsite.samples || [];
        const gotStems = dlStems({ id: d.id, n: d.n, sm: d.sm, un: d.un });
        if (wantStems.length) {
          // A real stem list must survive verbatim.
          expect(gotStems, `dlsite stems for ${gid}`).toEqual(wantStems.slice(0, 40));
          expect(d.un).toBeUndefined();
        } else if (d.n) {
          // The build recorded a count but never harvested stems (11 products),
          // so these names are a guess. Probed against the CDN: plain smp1..N
          // resolves for 10 of 11, so guessing stays, flagged so the gallery
          // verifies it once against live meta and swaps the grid if wrong.
          expect(d.un, `gid ${gid} lost its unharvested-stems flag`).toBe(1);
          expect(gotStems).toEqual(Array.from({ length: Math.min(d.n, 40) }, (_, i) => "smp" + (i + 1)));
        } else {
          expect(gotStems).toEqual([]);
        }
      } else {
        expect(e.l).toBeUndefined();
      }

      for (const [key, short] of [["dmm", "m"], ["dmm2", "m2"]]) {
        if (orig[key]) {
          expect(e[short]?.id).toBe(orig[key].id);
          expect(e[short]?.n).toBe(orig[key].n || 0);
        } else {
          expect(e[short]).toBeUndefined();
        }
      }

      if (orig.getchu) expect(e.g.id).toBe(String(orig.getchu.id));
    }
  });

  test("CACHE thumbnails are derivable from the stored urls", () => {
    const full = source("vndb_cache_top60.json");
    if (!full) return;
    let shotsChecked = 0;
    for (const [gid, entry] of Object.entries(built.CACHE)) {
      if (!entry) continue;
      const pick = full[gid]?.pick;
      if (!pick) continue;
      const check = (orig, kept) => {
        if (!orig?.url) return;
        expect(kept).toBe(orig.url);
        const t = vnThumb(kept);
        expect(t, "no thumbnail was produced").toBeTruthy();
        // For normal rows the derived thumb equals the source thumb; for the 5
        // degenerate rows (thumbnail === url) .t still resolves on VNDB, so a
        // derived thumb is acceptable and even an identity mapping is safe.
        if (orig.thumbnail && orig.thumbnail !== orig.url) {
          expect(t).toBe(orig.thumbnail);
        }
      };
      check(pick.image, entry.img);
      shotsChecked++;
      const shots = (pick.screenshots || []).slice(0, 30);
      expect(entry.shots.length).toBe(shots.length);
      shots.forEach((s, i) => check(s, entry.shots[i]));
      shotsChecked += shots.length;
    }
    expect(shotsChecked).toBeGreaterThan(100);
  });

  test("GETCHU payload is gone and its only consumer is served by STORE.g.n", () => {
    expect("GETCHU" in built).toBe(false);
    const withCount = Object.values(built.STORE).filter((e) => typeof e.g?.n === "number");
    expect(withCount.length).toBeGreaterThan(100);
  });
});

describe("tag payload", () => {
  test("TAGS is the union of the tag and POV crawls intersected with DATA", () => {
    // egs_tags.json (user tags) and egs_povs.json (POV 属性) both hold every
    // game carrying the name (rows with id/name/sellday/n); a same-named key
    // merges as the union. The payload keeps only the ids the 寝取 gallery
    // renders, numerically sorted. Anything else would make chips filter on
    // games that can never be shown.
    const rawTags = source("egs_tags.json");
    if (!rawTags) return;
    const rawPovs = source("egs_povs.json");
    if (!rawPovs) return;
    const gids = new Set(built.DATA.map((d) => String(d.gid)));
    for (const [tag, payload] of Object.entries(built.TAGS)) {
      const rawIds = new Set();
      for (const raw of [rawTags, rawPovs]) {
        for (const e of raw[tag] || []) {
          const id = String(e.id);
          if (gids.has(id)) rawIds.add(id);
        }
      }
      const merged = [...rawIds].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      expect(payload, `TAGS["${tag}"] diverged from the raw crawls`).toEqual(merged);
      for (const gid of payload) {
        expect(gids.has(gid), `tag "${tag}": gid ${gid} is not in DATA`).toBe(true);
      }
    }
    for (const tag of Object.keys(built.TAGS)) {
      expect(tag in rawTags || tag in rawPovs, `tag "${tag}" is not in either raw crawl`).toBe(true);
    }
  });

  test("親子丼 is shipped with a useful count", () => {
    const list = built.TAGS["親子丼"];
    expect(list, "親子丼 missing from TAGS").toBeTruthy();
    expect(list.length, "親子丼 count collapsed").toBeGreaterThan(10);
  });

  test("堕ちる過程 POV is shipped with a useful count", () => {
    const list = built.TAGS["堕ちる過程"];
    expect(list, "堕ちる過程 missing from TAGS").toBeTruthy();
    expect(list.length, "堕ちる過程 count collapsed").toBeGreaterThan(100);
  });

  test("the base POV itself never becomes a chip", () => {
    // 寝取り IS the dataset (POV559 unions the whole 寝取 universe into DATA),
    // so its intersection covers every listed game and a chip for it could
    // never filter anything.
    expect("寝取り" in built.TAGS, "寝取り must stay excluded from TAGS").toBe(false);
  });
});

describe("DATA covers the 寝取 universe", () => {
  test("every universe row and CSV game lands in DATA, ranked 1..N", () => {
    // prep_data.py unions pov559_universe.json (POV559 straight from the DB)
    // into the 寝取 CSV and renumbers the ranks, so DATA is exactly the
    // distinct union of both sources.
    const universe = source("pov559_universe.json");
    if (!universe) return;
    // game_id is the second column; quoted commas only occur later (names),
    // so the plain split reads it safely.
    const csvIds = fs.readFileSync(
      path.join(REPO, "data", "pov559_netori_eroge_only_by_median.csv"), "utf8")
      .split(/\r?\n/).slice(1)
      .map((line) => (line.split(",")[1] || "").trim())
      .filter(Boolean);
    const universeIds = universe.map((r) => String(r.id));
    const gidSet = new Set(built.DATA.map((d) => String(d.gid)));
    const notInData = (ids) => ids.filter((id) => !gidSet.has(id));
    expect(notInData(universeIds), "universe rows missing from DATA").toEqual([]);
    expect(notInData(csvIds), "CSV games missing from DATA").toEqual([]);
    expect(built.DATA.length, "DATA must be exactly the distinct union of CSV + universe")
      .toBe(new Set([...csvIds, ...universeIds]).size);
    const ranks = built.DATA.map((d) => d.rank).sort((a, b) => a - b);
    expect(ranks, "ranks must be exactly 1..N, contiguous and unique")
      .toEqual(Array.from({ length: built.DATA.length }, (_, i) => i + 1));
  });
});

describe("build outputs", () => {
  test("generated artifacts use LF, so a clone matches the deployed bytes", () => {
    // .gitattributes pins eol=lf, but the writers must agree or git reports the
    // working tree as dirty immediately after a checkout.
    for (const f of ["public/index.html", "build/data.json", "kv-bulk.json"]) {
      const buf = fs.readFileSync(path.join(REPO, f));
      expect(buf.includes(0x0d), `${f} contains CR`).toBe(false);
    }
  });

  test("the shipped document is newer than every input to the build", () => {
    const doc = path.join(REPO, "public", "index.html");
    const mtime = fs.statSync(doc).mtimeMs;
    for (const f of ["src/urls.js", "src/gallery/app.js", "src/gallery/style.css",
      "src/gallery/index.src.html", "build/data.json"]) {
      expect(fs.statSync(path.join(REPO, f)).mtimeMs, `${f} changed after the build`).toBeLessThanOrEqual(mtime);
    }
  });

  test("document contains no leftover template tokens", () => {
    const doc = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
    expect(doc).not.toMatch(/__PLACEHOLDER__|__DATA__|__STORE__|__CACHE__|__NDL__/);
    expect(doc).not.toMatch(/\/\*__(STYLE|PAYLOAD|URLS|APP)__\*\//);
  });

  test("scripts are ported to TypeScript: no .py left, none embeds HTML", () => {
    // The old Python generator kept the whole front end inside one string, which
    // is why nothing about it was lintable or testable. The Bun port replaced
    // it, so a leftover .py would build the site from stale logic.
    const scripts = fs.readdirSync(path.join(REPO, "scripts"));
    expect(scripts.filter((f) => f.endsWith(".py")), "Python scripts still present in scripts/").toEqual([]);
    for (const s of scripts.filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(REPO, "scripts", s), "utf8");
      // fetch_tags.ts legitimately carries the generated 2231-entry HTML5
      // entity table (/*@HTML5@*/, ~45KB) for html.unescape parity, so the
      // cap sits above it; anything approaching this size is still a smell.
      expect(src.length, `${s} is suspiciously large`).toBeLessThan(80000);
      expect(src, `${s} still embeds a full HTML document`).not.toMatch(/<!DOCTYPE html>[\s\S]{2000,}/);
    }
  });

  test("the retired single-file generator is no longer the build path", () => {
    const pkg = readJson(path.join(REPO, "package.json"));
    // The build runs the Bun port of the data scripts, not the Python originals.
    expect(pkg.scripts.build).toContain("prep_data.ts");
    expect(pkg.scripts.build).toContain("bundle.ts");
    expect(pkg.scripts.deploy).toContain("wrangler deploy");
    // setup-kv must not run unconditionally on deploy any more: it used to
    // rewrite every seed key per deploy.
    expect(pkg.scripts.deploy).toMatch(/--no-seed/);
  });
});

describe("KV seed contract", () => {
  test("every seeded value carries the boolean hit the worker requires", () => {
    const seed = readJson(path.join(REPO, "kv-bulk.json"));
    expect(seed.length).toBeGreaterThan(50);
    for (const e of seed) {
      expect(e.key).toMatch(/^meta:\d+$/);
      const v = JSON.parse(e.value);
      expect(typeof v.hit, `${e.key} has no boolean hit -> worker ignores it`).toBe("boolean");
      expect(typeof v.ts).toBe("number");
      if (v.hit) expect(v.data).toBeGreaterThan(0);
      else expect(v.data).toBe(0);
    }
  });

  test("seeded hits agree with getchu_meta.json", () => {
    const meta = source("getchu_meta.json");
    if (!meta) return;
    const seed = readJson(path.join(REPO, "kv-bulk.json"));
    for (const e of seed) {
      const cid = e.key.slice("meta:".length);
      const v = JSON.parse(e.value);
      expect(meta[cid]).toBeTruthy();
      expect(v.hit).toBe((meta[cid].n || 0) > 0);
      if (v.hit) expect(v.data).toBe(meta[cid].n);
    }
  });
});

describe("worker config", () => {
  test("run_worker_first covers every proxy prefix the app calls", () => {
    // /dm/meta and /dl/meta were added to the Worker but not to wrangler.json,
    // so the asset layer answered those paths and the meta endpoints silently
    // 404'd in production while working in unit tests.
    const cfg = readJson(path.join(REPO, "wrangler.json"));
    const prefixes = (cfg.assets && cfg.assets.run_worker_first) || [];
    for (const p of ["/gc/*", "/dm/*", "/dl/*"]) {
      expect(prefixes, `${p} missing from assets.run_worker_first`).toContain(p);
    }
    // Every rooted proxy path built in urls.js must have a matching prefix.
    const urls = fs.readFileSync(path.join(REPO, "src", "urls.js"), "utf8");
    const used = new Set(
      [...urls.matchAll(/"\/(gc|dm|dl)\//g)].map((m) => "/" + m[1] + "/*")
    );
    for (const u of used) expect(prefixes, `${u} used by the app but not routed`).toContain(u);
    expect([...used].sort()).toEqual(["/dl/*", "/dm/*", "/gc/*"]);
  });

  test("the KV binding name matches between config and code", () => {
    const cfg = readJson(path.join(REPO, "wrangler.json"));
    const bindings = (cfg.kv_namespaces || []).map((ns) => ns.binding);
    expect(bindings).toContain("GC_META");
    const code = fs.readFileSync(path.join(REPO, "src", "index.js"), "utf8");
    expect(code).toContain("env.GC_META");
  });
});

describe("python/js parser parity", () => {
  // The crawl scripts run the same regexes in Python. Pin the shapes so a
  // change on one side has to be made on the other.
  test("fixture pages parse identically to hand-computed expectations", () => {
    expect(parseSampleMax("877358", "c877358sample1.jpg c877358sample12.jpg")).toBe(12);
    expect(parseDmmMax("a_1", "a_1js-002.jpg a_1jp-009.jpg")).toBe(9);
    expect(parseDlStems("RJ1", "RJ1_img_smpa1.webp RJ1_img_smpa2.jpg")).toEqual(["smpa1", "smpa2"]);
  });

  test("detail URLs stay on their own hosts", () => {
    expect(new URL(dmmDetailUrl("alice_0053")).hostname).toBe("dlsoft.dmm.co.jp");
    expect(new URL(dmmDetailUrl("d_054457")).hostname).toBe("www.dmm.co.jp");
    expect(new URL(dmmDetailUrl("505apc13729")).hostname).toBe("www.dmm.co.jp");
  });
});
