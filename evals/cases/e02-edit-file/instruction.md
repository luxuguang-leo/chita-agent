# e02-edit-file: fix a specific bug

## Task

`env/calc.js` contains a function `add(a, b)` whose implementation is buggy:
it mishandles negative numbers (e.g. `add(-1, 2)` returns 3 instead of 1).
Fix it so that every input matches the mathematical definition of "sum of two numbers".

## Constraints

- Only modify `env/calc.js`; do not touch other files
- You may run `node env/calc.js` to self-test after fixing

## Expected output

The fixed `add` function. No lengthy explanation needed.
