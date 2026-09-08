# cf-gallery 文档核对笔记

核对方式：2026-09-08 用 curl 拉取 developers.cloudflare.com 官方文档（HTML + `index.md` 交替源）后 grep 关键段。
每条结论格式：文档 URL + 生效行为一句话。

## 1. Workers Static Assets

- https://developers.cloudflare.com/workers/static-assets/ —— Wrangler 配置中 `assets.directory` 指定静态目录，部署时 Wrangler 自动上传，Worker 代码与静态资源作为一个单元一次部署。
- https://developers.cloudflare.com/workers/static-assets/ —— 默认路由优先级：请求命中静态文件则直接返回、不进 Worker；未命中且存在 Worker 则走 Worker（Worker 可用 `env.ASSETS.fetch(request)` 再回落到静态资源）；无 Worker 则返回 404。
- https://developers.cloudflare.com/workers/static-assets/ —— `run_worker_first`（`true` 或路径数组如 `["/api/*", "!/api/docs/*"]`）让 Worker 先于静态资源执行，用于 API 路由优先。
- https://developers.cloudflare.com/workers/static-assets/ —— `not_found_handling = "single-page-application"` 使未命中返回 200 + `index.html`；`"404-page"` 返回最近的 `404.html`。

## 2. Workers KV

- https://developers.cloudflare.com/kv/api/read-key-value-pairs/ —— 读：`await env.NAMESPACE.get(key)` 返回值，不存在返回 `null`；也支持传 key 数组批量读回 `Map`。
- https://developers.cloudflare.com/kv/api/write-key-value-pairs/ —— 写：`await env.NAMESPACE.put(key, value)` 新建或覆盖同一 key。
- https://developers.cloudflare.com/kv/get-started/ —— 绑定写法：`"kv_namespaces": [{ "binding": "GC_META", "id": "<BINDING_ID>" }]`，`binding` 是 Worker 内 `env` 变量名，须为合法 JS 变量名。
- https://developers.cloudflare.com/kv/reference/kv-commands/ —— 建命名空间：`npx wrangler kv namespace create <NAME>`（Wrangler ≥3.60 用 `kv ...` 空格语法，旧版为 `kv:...`），返回的 id 填回配置文件。
- https://developers.cloudflare.com/kv/reference/kv-commands/ —— 批量导入：`npx wrangler kv bulk put [FILENAME] --binding=<NAME>`（或 `--namespace-id`），文件为 `[{key, value}]` 数组，`value` 必须是字符串；另有 `--remote`（写线上）、`--preview`、`--local`、`--ttl`、`--expiration` 开关。
- https://developers.cloudflare.com/kv/get-started/ —— 本地开发注意：`wrangler dev` 默认用本地 KV，不连线上数据（未在本地写过的 key 读到 `null`），需连线上则给绑定加 remote 配置或相应 flag。

## 3. Caches API（`caches.default`）

- https://developers.cloudflare.com/workers/runtime-apis/cache/ —— `caches.default` 是全局唯一的单例缓存对象；内容不跨数据中心复制；与「Workers Caching（fetch 缓存）」相互独立；`cache.put` 与分层缓存（tiered caching）不兼容。
- https://developers.cloudflare.com/workers/runtime-apis/cache/ —— `cache.put` 非法参数会抛错：request 非 GET、response 状态为 206、含 `Vary: *` 头；`Cache-Control` 指示不缓存或响应过大返回 413；不支持 `stale-while-revalidate` / `stale-if-error`。
- https://developers.cloudflare.com/workers/runtime-apis/cache/ —— 带 `Set-Cookie` 的响应默认永不缓存，删掉该头或加 `Cache-Control: private=Set-Cookie` 后才可存。

## 4. 免费版限制

- https://developers.cloudflare.com/workers/platform/limits/ —— Workers Free：10 万请求/天、CPU 10ms/请求、内存 128MB/isolate、subrequest 50 次/请求、单 Worker 64MiB、Cache API 单对象 512MB 且调用次数并入 subrequest 配额。
- https://developers.cloudflare.com/workers/platform/limits/ —— Static Assets：每版本文件数 Free 2 万（Paid 10 万），单文件 25MiB。
- https://developers.cloudflare.com/kv/platform/limits/ —— KV Free：读 10 万/天、写不同 key 1000/天、同 key 1 次/秒、value ≤ 25MiB、key ≤ 512B、单次 Worker 调用最多 1000 次外部服务操作。

## 5. 画廊 `vndb_gallery.html` 检查结论（无需为 Workers 版改代码）

检查方法：对工作区根 `vndb_gallery.html`（573 行）做全文件 grep。

- `gc/cover`、`gc/sample`、`gc/meta`、`/gc/` 出现次数均为 0（`grep -c` 返回 0），即当前画廊**没有任何同源 `gc/` 相对路径引用**，任务背景中「画廊请求同源相对路径」的前提在现有文件中不成立。
- 现有图片全部是绝对 `https://` URL 的模板表达式（EGS `egsImg()`、DLsite、FANZA/DMM、VNDB），无任何相对路径 `src`，因此原文件原样拷贝为 `public/index.html` 后在 Workers Static Assets 下可直接 serving，无兼容性改动需求。
- `file://` 直连降级成立：`chainErr(el)` 按 `data-fb` 链换源，全部失败则 `el.remove()`，从不抛错；VNDB 相关 `fetch` 全包在 `try/catch`（失败返回 `null`），页面只显示「暂无图片 / 未匹配」提示、不炸页；Getchu 相关展示走 EGS 转存直连，失败同样只隐藏图片。
- 结论：**画廊无需改动**，直接复制部署即可；若将来要真正走 Worker 的 `gc/` 代理（享 Referer/缓存），才需另给画廊加相对路径引用，那属于新功能而非本次联调必需。
