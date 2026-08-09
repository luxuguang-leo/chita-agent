# pi-tui vendor 记录

本目录为 `earendil-works/pi` 的 `packages/tui` 源码 vendor（TUI 架构设计 §6）。

## 来源

- 仓库：https://github.com/earendil-works/pi
- 包：`packages/tui`（@earendil-works/pi-tui）
- **commit：`7bdb16c28d794a5ff8e7485479c8e37eccd9a8d8`**（2026-08-08）
- 许可：MIT（副本见下方）

## vendor 内容

- `src/` → 37 个 .ts 文件（纯 JS 核心，排除 `native-modifiers.ts`）
- **排除**：`native/`（darwin/win32 原生 .node 修饰键检测）——降级为常规按键检测，功能不受影响（设计 §6 决策）
- 依赖：`get-east-asian-width` / `marked`（chita workspace 已有）

## 供应链 pinning

- commit + hash 记录于本文件（不可变来源）
- `SessionMeta.pinnedResources` 记录 vendor 版本（v2.1 N2 机制）
- 升级流程：更新 source commit → 重新 vendor → 更新本文件 → 更新 pinnedResources

## 修改记录

| 日期 | 修改 |
|---|---|
| 2026-08-09 | vendor 初始拷贝；terminal.ts 移除 native-modifiers import（Shift+Enter native 检测降级为 false） |


## LICENSE（MIT，来自 pi repo）

MIT License

Copyright (c) 2024 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
| 2026-08-09 | components/editor.ts：newLine 分支移除裸 `\n` 兜底——配合 TUI setKeybindings 覆盖，Enter 提交、Shift+Enter 换行（chita 设计 §8） |
