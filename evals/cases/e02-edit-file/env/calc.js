export function add(a, b) {
  return a + b;
}

// Self-test entry
if (import.meta.main) {
  console.log("add(-1, 2) =", add(-1, 2));
}
