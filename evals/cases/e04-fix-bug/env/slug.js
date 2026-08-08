// Fixed: spaces become hyphens, consecutive spaces merged
export function slugify(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-"); // fixed: should be "-", merging consecutive spaces
}

if (import.meta.main) {
  console.log(slugify("Hello World"));
}
