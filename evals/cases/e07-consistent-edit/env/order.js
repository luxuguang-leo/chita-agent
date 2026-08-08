import { cart } from "./cart.js";
// 单价字段这里用了 cost，与 cart.js 的 price 不一致
export function orderTotal() {
  return cart.reduce((sum, item) => sum + item.cost, 0);
}
