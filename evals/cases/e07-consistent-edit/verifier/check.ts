/**
 * e07 verifier — checks the cross-file consistent rename
 *
 * Ground truth:
 * - order.js no longer references cost; it uses price
 * - cart.js is untouched (still uses price)
 * - order.js keeps its reduce logic (not gutted)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const envDir = join(import.meta.dir, "..", "env");
const orderSrc = readFileSync(join(envDir, "order.js"), "utf-8");
const cartSrc = readFileSync(join(envDir, "cart.js"), "utf-8");

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

if (orderSrc.includes("cost")) fail("order.js still references cost");
if (!orderSrc.includes("price")) fail("order.js did not switch to price");
if (!orderSrc.includes("reduce")) fail("order.js reduce logic was broken");
if (!cartSrc.includes("price")) fail("cart.js field is abnormal");
if (cartSrc.includes("cost")) fail("cart.js was corrupted (should not contain cost)");

// Runtime check: verify-usage.js must still run (guard against "strings changed but logic dead")
try {
  execSync("node verify-usage.js", { cwd: envDir, timeout: 5000, stdio: "pipe" });
} catch (e) {
  fail(`verify-usage.js failed to run: ${String(e.stderr || e.message).slice(0, 200)}`);
}

if (failed) process.exit(1);
console.log("PASS: e07-consistent-edit");
