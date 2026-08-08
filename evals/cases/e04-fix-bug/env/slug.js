// Intentionally buggy: spaces become underscores, consecutive spaces not merged
export function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_"); // bug: should be "-", and consecutive spaces are not merged
}

if (import.meta.main) {
  console.log(slugify("Hello World"));
}
