// Intentionally buggy: negative-number handling is wrong
export function add(a, b) {
  return a + Math.abs(b);
}

// Self-test entry
if (import.meta.main) {
  console.log("add(-1, 2) =", add(-1, 2));
}
