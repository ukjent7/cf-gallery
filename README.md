# cf-gallery

POV559 寝取り・EROGE 限定排名画廊：按中央值排序，集中看各家封面与截图。

线上是一个静态站：打开即用，Getchu 的图由同项目的小代理解决防盗链，
代理 miss 会自动降级，不影响其它图。

## 部署（Cloudflare Workers）

```bash
cd cf-gallery
bun run deploy
```

第一次部署会自动建好 KV 并导入数据，不用手动填 id。

网页版 Dashboard：构建命令留空，部署命令填
`node scripts/setup-kv.cjs && npx wrangler deploy`，点一下部署就行。

本地预览：`bun run dev`，打开提示的本机地址即可。
