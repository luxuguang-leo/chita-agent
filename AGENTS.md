# AGENTS.md — chita-agent 编码守则

给在此仓库工作的编码 agent（Pi / Cursor / Claude Code / chita 自身）的硬性约定。

## 设计文档先行（recon 类请求）

- 「看下如何加 / 如何实现 / 加个 xxx 功能」这类 recon 请求，**先落 `docs/design-*.md` 或 `docs/fix-plan-*.md`**（状态标注「方案已定，代码未改」），再动代码。
- 实施时严格按设计文档的「涉及文件清单」改 → `bun test` → `bun run build` → 汇报（改了哪些文件 / 测试结果 / 构建是否成功）。

## Commit message

- **英文 subject + body 四段**：`symptom → root cause → change → evidence`（evidence 写真实数字：`bun test N pass / 0 fail`、`tsc` clean）。
- 单行 subject 会被打回。详见 `docs/commit-convention.md`。
- author 沿用仓库既有惯例：`user.email <luxuguangno1@163.com>`。

## 测试

- 跑测试前**必须绕代理**（Clash 劫持 127.0.0.1 的 mock server 会让 `packages/ai` 用例假失败）：
  ```bash
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    NO_PROXY='*' no_proxy='*' bun test
  ```
- 先 `bun install`，否则报 `Could not resolve: "marked"` 等依赖缺失。

## 运行

- 构建产物 `dist/chita` 是 `bun build --target=bun` 产物，**必须 `bun ./dist/chita` 运行**（直接执行会失败 / 触发网关误拦）。

## 关键语义（易错）

- `AgentLoop.maxTokens` = 单次 run 的 API 消耗熔断，**不是**上下文长度。
- `contextWindow` = 模型硬上下文窗口（压缩上限 + 状态栏 ctx% 的参照）。
- `compactTokens` / `compactCeilingFor(cfg)` = **软压缩上限**（默认 256K），压缩在 `0.9×soft` 处触发——不要把它和硬窗 1M 混为一谈。
