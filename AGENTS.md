- NEVER write unit tests after you write code. 
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact. 
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

- `README.md` 面向公开读者，刻意保持极简。**默认不要改它，能不改就不改。**
- 这是公开仓库：不要提交抓取日志、临时文件或内部运维细节；`tmp/` 只作本地暂存。
- 未经用户允许禁止另开分支
- 对第三方接口使用应保持克制，细水长流、可持续性共赢
- 依赖和各种工具无脑使用最新稳定版