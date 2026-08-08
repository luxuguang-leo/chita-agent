# e01-read-project: understand the project entry

## Task

This repository is a minimal Node project. Find out:
1. Which file is the project entry (as pointed to by package.json `main`)
2. What the first line of the entry file exports

## Constraints

- Read-only task: do not modify any file
- Working directory: `env/` (fixture repo)

## Answer location

Write your conclusion to `env/answer.json`:

```json
{
  "entryFile": "<relative path, e.g. src/main.js>",
  "firstExport": "<identifier exported on line 1>"
}
```

Do not write any other file.
