# e04-fix-bug：修复并验证

## 任务

`env/` 有一个字符串处理函数 `slugify(s)`，本应把字符串转成 URL 友好的 slug，但实现有 bug：
- 输入 `"Hello World"` 应输出 `"hello-world"`，当前输出 `"hello_world"`（下划线错误）
- 输入 `"A  B  C"`（连续空格）应输出 `"a-b-c"`（合并空格），当前会输出 `"a--b--c"`

请修复 `env/slug.js` 使行为正确，并验证你的修复（可以跑 `node env/slug.js`）。

## 环境约束

- 只修改 `env/slug.js`
- 修复要同时覆盖上面两个场景

## 期望输出

一句话说明修复点 + 验证结果。
