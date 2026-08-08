# e07-consistent-edit: rename consistently across files

## Task

In `env/`, `cart.js` names the per-item price field `price`, but `order.js` uses `cost`.
Unify on `price`:
1. Modify `order.js` wherever it references the price field, switching to `price`
2. Keep `cart.js` unchanged
3. Do not break the existing logic

## Constraints

- Only modify the files that need changing
- After the edit you may run `node env/verify-usage.js` to self-check

## Expected output

One sentence stating which files were changed.
