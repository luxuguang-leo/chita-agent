# e07-consistent-edit：跨文件一致改名

## 任务

`env/` 的 `cart.js` 把商品单价字段叫 `price`，但 `order.js` 用的是 `cost`。请统一为 `price`：
1. 修改 `order.js` 中引用单价的地方，改用 `price`
2. 确保 `cart.js` 不变
3. 不要破坏现有逻辑

## 环境约束

- 只修改需要改的文件
- 改完可以跑 `node env/verify-usage.js` 自测

## 期望输出

一句话说明改了哪些文件。
