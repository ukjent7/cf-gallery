# AGENTS.md

给在这个仓库工作的 AI 代理的规则。

## README 政策（重要）

- `README.md` 面向公开读者，刻意保持极简。**默认不要改它，能不改就不改。**
- 仅在两种情况下允许改：
  1. 用户明确要求；
  2. README 中写到的命令、路径或行为已经和现实不一致（构建方式、脚本名、部署入口变了），不改会误导读者。
- 即使要改，也只做最小修正，不要重写全文、不要加功能介绍、变更历史或长篇"为什么"。
  设计动机和实现细节写在代码注释里，给代理看的约定写在本文件。

## 项目速览

- 构建 + 测试：`bun run check`（`scripts/prep_data.py` + `scripts/bundle.py` + `bun test`）。
- 改了 `src/gallery/*` 或 `data/*` 之后必须 `bun run build`，并把
  `public/index.html`、`build/data.json` 与源文件一起提交
  （`test/build.test.js` 会校验产物比输入新）。
- 新增筛选条件（EGS 用户 tag 或 POV 属性）：
  `bun scripts/fetch_tags.ts --tag 标签名`（用户 tag）或
  `bun scripts/fetch_tags.ts --pov povlist的ID`（POV 属性，如 堕ちる過程=62），
  无参数运行则刷新两个文件里已有的全部条目；之后 `bun run build`。
  刷新寝取全集（并入缺失游戏）：`bun scripts/fetch_tags.ts --pov 559`。
  EGS 的网页统计/检索页会截断列表，一律以 SQL 接口为准。
- 部署：`bun run deploy`；本地预览：`bun run dev`。
- 这是公开仓库：不要提交抓取日志、临时文件或内部运维细节；`tmp/` 只作本地暂存。
