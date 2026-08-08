import { cart } from "./cart.js";
// Price field uses price, consistent with cart.js which uses price
export function orderTotal() {
  return cart.reduce((sum, item) => sum + item.price, 0);
}
