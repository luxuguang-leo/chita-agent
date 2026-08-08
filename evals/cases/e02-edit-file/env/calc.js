// 故意有 bug：负数相加处理错误
export function add(a, b) {
  return a + Math.abs(b);
}

// 自测入口
if (import.meta.main) {
  console.log("add(-1, 2) =", add(-1, 2));
}
