# cf-gallery

POV559 寝取り・EROGE 限定排名画廊：按中央值排序，集中看各家封面与截图。

线上是一个静态站：打开即用，Getchu 的图由同项目的小代理解决防盗链，
代理 miss 会自动降级，不影响其它图。

## 部署（Cloudflare Workers）

```bash
cd cf-gallery
bunx wrangler kv namespace create GC_META   # 把返回 id 填进 wrangler.json
cp ../vndb_gallery.html public/index.html
python3 scripts/make-kv-bulk.py
bunx wrangler kv bulk put kv-bulk.json --binding=GC_META --remote
bun run deploy
```

本地预览：`bun run dev`，打开提示的本机地址即可。
