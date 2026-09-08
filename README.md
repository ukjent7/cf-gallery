# cf-gallery

POV559 寝取り・EROGE 限定排名画廊：按中央值排序，集中看各家封面与截图。

线上是一个自包含单文件页面（`public/index.html`），图片和数据都能直接用；
Getchu 的防盗链图由同项目的小代理转发（详情只走 Worker 代理，不再垫 EGS 转存图）。
单文件是刻意的：双击本地文件也要能用，而 `file://` 下 fetch 同目录 JSON 会被浏览器拦掉。

## 目录

```
src/urls.js              商店 ID / URL / 图片路径的唯一事实来源
src/index.js             Worker：静态资源 + Getchu 图代理 + 惰性元数据缓存
src/gallery/
  index.src.html         页面骨架
  style.css              样式
  app.js                 前端逻辑（商店适配器表 + 卡片 + 详情弹窗）
data/                    构建输入快照（CSV + 各爬虫 JSON）
build/data.json          prep_data.py 的产物（前端内联用的精简载荷）
scripts/
  prep_data.py           data/ -> build/data.json，纯数据转换
  bundle.py              把上面几个文件拼成 public/index.html
  make-kv-bulk.py        data/getchu_meta.json -> kv-bulk.json
  setup-kv.cjs           建 KV、写 wrangler.json、按需导入种子
test/
  urls.test.js           Getchu URL 与解析
  routes.test.js         路由与入参校验
  meta.test.js           元数据处理器 + KV 写入配额回归
  build.test.js          Python/JS/产物三方交叉校验
  gallery.smoke.test.js  载入构建产物，真跑 5 个 Tab
```

`src/urls.js` 会被 Worker `import`，也会被 `bundle.py` 去掉 export 块后原样内联进
页面。Python 侧的推导规则（`dlFolder`、`dlWorkType`、boxed cid、各爬虫正则）由
`test/build.test.js` 拿真实数据集逐条比对，改一处不同步就会红。

## 构建与测试

```bash
bun run build     # prep_data.py + bundle.py -> public/index.html
bun test          # 52 个测试，不需要 Python（读已提交的 build/data.json）
bun run check     # 先构建再测试
```

`public/index.html` 和 `build/data.json` 都提交进仓库：前者是部署产物，后者让
`bun test` 在干净 clone 上无需 Python 就能跑。改完前端或 `data/` 记得 `bun run build`
再提交，`test/build.test.js` 会检查产物是否比所有输入新。

## 部署

```bash
bun run deploy        # 不碰 KV 数据（推荐）
bun run deploy:seed   # 只在需要（重新）导入种子时用
```

`deploy` 跑 `setup-kv.cjs --no-seed`，只做「确保 namespace 存在 + wrangler.json 里
id 正确」，然后 `wrangler deploy`。`--force-seed` 才会覆盖写入全部种子键。

## KV 写入预算（免费档 1000 次/天）

读很便宜（100k/天），写才是瓶颈，而且 bulk put 和运行时写入同一个池子。
之前几小时就把额度用光，四个原因叠在一起，现在各自堵上了：

| 写入来源 | 之前 | 现在 |
|---|---|---|
| 未命中哨兵（7 天 TTL） | 每次未命中写一条，约 2400 键每 7 天重来 ≈ 341 次/天 | 0：未命中只靠 CDN `s-maxage=86400` 负缓存 |
| 已命中键被重复覆盖 | 每次回源都 put | 只在键为空时 put |
| 并发重复请求 | 同键多次回源 | `singleFlight` 合并，1 次回源 1 次写 |
| 每次部署重传种子 | 123 次/部署，还会用旧 ts 盖掉新数据 | 默认 0；只补远端缺失的键 |
| 前端重复问已有数据 | 每次开详情都问三家 | Getchu/DLsite 用构建期数据；FANZA 每产品每会话最多问 1 次 |

按真实数据集，冷启一遍全部产品：可写键从 2393 降到 1538，未命中相关的 341 次/天
归零，稳态续期约 51 次/天（免费档 5%）。

种子文件格式必须是 `{"data":N,"hit":true|false,"ts":0}`。Worker 只认 `hit` 是布尔的
条目；旧的 `{"n":16,"ts":...}` 会被完全忽略，等于种子白传。`setup-kv.cjs` 现在会在
上传前校验并拒绝不合格式的文件。

想再省，可以把 `data/getchu_meta.json` 和 `dlsite_samples.json` 重新爬全（现在分别只
覆盖 128/723 和 466/744），冷启可写键能降到 926（仅 FANZA）。

## 本地预览

```bash
bun run dev         # wrangler dev，带本地 KV
```

直接双击 `public/index.html` 也行：此时没有同源 `/gc|/dm|/dl` 后端，Getchu 段
提示需部署后在线查看，其余商店是官方直链。
