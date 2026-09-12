// Bundle-provided globals: the JSON payload consts and src/urls.js are
// inlined ahead of these modules by scripts/bundle.ts, so they exist at
// runtime without being imported. Declared any: shapes are asserted by tests.
declare var DATA: any;
declare var STORE: any;
declare var CACHE: any;
declare var TAGS: any;
declare var FULLCG: any;
declare var BRANDG: any;
declare var DMM_SAMPLE_CAP: number;
declare var GETCHU_SAMPLE_CAP: number;
declare function dlApiMeta(rid: any, domain: any): any;
declare function dlJpg(u: any): any;
declare function dlMainUrl(d: any): any;
declare function dlProductUrl(rid: any, domain: any): any;
declare function dlSampleThumbUrl(d: any, stem: any): any;
declare function dlSampleUrl(d: any, stem: any): any;
declare function dlSamples(d: any): any;
declare function dlStems(d: any): any;
declare function dmApiMeta(cid: any): any;
declare function dmmDetailUrl(cid: any): any;
declare function dmmFloorLabel(cid: any): any;
declare function dmmPkgFallbacks(cid: any): any;
declare function dmmPkgUrl(cid: any): any;
declare function dmmSampleBig(cid: any, i: any): any;
declare function dmmSampleSmall(cid: any, i: any): any;
declare function egsImg(gid: any, n: any): any;
declare function egsUrl(gid: any): any;
declare function gcApiCover(cid: any): any;
declare function gcApiMeta(cid: any): any;
declare function gcApiSample(cid: any, n: any): any;
declare function gcProductUrl(cid: any): any;
declare function vnSearchUrl(name: any): any;
declare function vnThumb(url: any): any;
declare function vnUrl(vid: any): any;
