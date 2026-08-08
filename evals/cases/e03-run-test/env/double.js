import { test, assert } from "./util.js";

export function double(x) {
  return x * 2;
}

// 故意埋 1 个失败用例
test("double(2) = 4", () => assert(double(2) === 4));
test("double(-3) = -6", () => assert(double(-3) === -6));
test("double(0) = 0", () => assert(double(0) === 1)); // 故意错
