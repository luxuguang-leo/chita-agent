# e05-git-log: investigate the commit history

## Task

`env/` is a git repository (running `bun env/build-env.ts` creates its commits).
First run `bun env/build-env.ts` to build the repo, then use `git log` / `git show` to find out:
1. The message of the most recent commit
2. How many commits have touched `src/app.js`

## Constraints

- Read-only task: do not create, modify, or commit anything
- The build command only generates git history (idempotent, safe to re-run)

## Answer location

Write the outcome to `env/answer.json`:

```json
{
  "lastCommitMessage": "<full message of the most recent commit>",
  "appJsCommitCount": <number of commits touching src/app.js>
}
```

The numbers must come from the git commands you actually ran.
