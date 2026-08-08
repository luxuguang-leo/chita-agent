# e04-fix-bug: fix and verify

## Task

`env/` contains a string-processing function `slugify(s)` that should turn a
string into a URL-friendly slug, but the implementation has a bug:
- Input `"Hello World"` should output `"hello-world"`, but currently outputs `"hello_world"` (underscore instead of hyphen)

Fix `env/slug.js` so the behavior is correct, and verify your fix (you can run `node env/slug.js`).

## Constraints

- Only modify `env/slug.js`
- The fix must ensure: spaces become hyphens, text becomes lowercase, surrounding spaces are trimmed

## Expected output

One sentence stating the fix and the verification result.
