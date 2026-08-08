# e03-run-test: run the tests and report

## Task

`env/` is a minimal project with tests. Please:
1. Run the project's tests (`npm test`)
2. Record the outcome

## Constraints

- Do not modify any files (read-only task; ignore temporary artifacts from `npm test`)
- Test failure is intentionally part of the fixture; record it as-is

## Answer location

Write the outcome to `env/answer.json`:

```json
{
  "passed": <number of passed tests>,
  "failed": <number of failed tests>
}
```

The numbers must come from the actual test output you ran, not from guessing.
