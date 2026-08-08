import { cart } from "./cart.js";
// Price field uses cost here, inconsistent with cart.js which uses price
export function orderTotal() {
  return cart.reduce((sum, item) => sum + item.cost, 0);
}
