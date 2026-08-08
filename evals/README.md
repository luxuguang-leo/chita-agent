# chita Eval Case 格式（v1，M0 定稿）

> 依据：agent-eval-engineering skill（LangChain 方法论）
> 每个 case = 三件套：`instruction.md` + `env/`（fixture 仓库）+ `verifier/`（确定性检查）
> 一个 case 只测一个能力。Verifier 第一版必被钻空子——验证 Environment 最终状态，不信 agent 自述。

## 目录结构

```
evals/cases/<id>/
├── instruction.md      # 给 agent 的任务指令（不得含答案/验证标准）
├── env/                # environment：fixture 仓库（可重置）
└── verifier/
    └── check.<ext>     # 确定性检查脚本；退出码 0 = pass，非 0 = fail
```

## 运行约定（M0-M1）

- M0：verifier 手动跑（`bun evals/cases/<id>/verifier/check.ts`），不进 agent loop
- M1：case 挂进 evals runner（不进 M1 判定）
- 隔离：tmpdir + fixture 仓库（每个 case 独立目录，可重置）；Docker 沙箱是 M4 以后
- fault-side：case 失败时归因（env→tool→harness→model），写回 trace

## 三件套要点

| 件 | 要求 |
|---|---|
| instruction.md | 描述任务目标 + 环境约束；**不含答案、不含验证标准**（防 shortcut） |
| env/ | fixture：最小可编译项目，含 bug/待改点；只读+可重置 |
| verifier/ | 确定性检查：断言 Environment 最终状态（文件存在/内容正确/命令输出），非 agent 自述 |

## 命名

`e<NN>-<动词>-<对象>`：e01-read-project, e02-edit-file, ...
