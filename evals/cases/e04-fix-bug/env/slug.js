// 故意有 bug：空格转下划线 + 不合并连续空格
export function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_"); // bug: 应为 "-"，且未合并连续空格
}

if (import.meta.main) {
  console.log(slugify("Hello World"));
}
