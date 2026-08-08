/**
 * e07 verifier — 检查跨文件一致改名
 *
 * 判据：
 * - order.js 不再引用 cost，改用 price
 * - cart.js 未被修改（仍用 price）
 * - order.js 的 reduce 逻辑仍在（不能删光）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");
const orderSrc = readFileSync(join(envDir, "order.js"), "utf-8");
const cartSrc = readFileSync(join(envDir, "cart.js"), "utf-8");

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

if (orderSrc.includes("cost")) fail("order.js 仍引用 cost");
if (!orderSrc.includes("price")) fail("order.js 未改用 price");
if (!orderSrc.includes("reduce")) fail("order.js 的 reduce 逻辑被破坏");
if (!cartSrc.includes("price")) fail("cart.js 字段异常");
if (cartSrc.includes("cost")) fail("cart.js 被改坏（不应出现 cost）");

if (failed) process.exit(1);
console.log("PASS: e07-consistent-edit");
