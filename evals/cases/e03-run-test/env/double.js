import { test, assert } from "./util.js";

export function double(x) {
  return x * 2;
}

// One intentionally broken case
test("double(2) = 4", () => assert(double(2) === 4));
test("double(-3) = -6", () => assert(double(-3) === -6));
test("double(0) = 0", () => assert(double(0) === 1)); // intentionally wrong
