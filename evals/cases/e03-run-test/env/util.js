// 极简测试运行器（避免依赖 node:test 版本差异）
let passed = 0;
let failed = 0;
const failures = [];

export function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
  }
}

export function assert(cond) {
  if (!cond) throw new Error("assertion failed");
}

// 汇总输出
export function summary() {
  console.log(`tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log(`  FAIL: ${f.name} (${f.error})`);
  return failed;
}
