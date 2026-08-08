# e06-grep-search: locate code across files

## Task

`env/` is a multi-file project. Use grep/search to find out:
1. Which file defines the function `computeTotal`
2. Which files call this function (list the file names)

## Constraints

- Read-only task: do not modify files
- Answers are file paths

## Answer location

Write your conclusion to `env/answer.json`:

```json
{
  "definitionFile": "<relative path of the defining file>",
  "callerFiles": ["<relative path of a caller file>"]
}
```

Do not write any other file.
