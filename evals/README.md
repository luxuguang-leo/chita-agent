# chita Eval Cases (v1, frozen at M0)

> Based on the `agent-eval-engineering` skill (LangChain methodology).
> Each case = three parts: `instruction.md` + `env/` (fixture repo) + `verifier/` (deterministic check).
> One case tests exactly one capability. The first verifier version is always gameable —
> verify the final Environment state, never the agent's self-report.

## Layout

```
evals/cases/<id>/
├── instruction.md      # task instructions for the agent (must NOT contain the answer or pass criteria)
├── env/                # environment: fixture repo (resettable)
└── verifier/
    └── check.<ext>     # deterministic check; exit 0 = pass, non-zero = fail
```

## Running (M0-M1)

- M0: verifier runs manually (`bun evals/cases/<id>/verifier/check.ts`), not inside the agent loop
- M1: cases hook into the evals runner (not part of M1 acceptance)
- Isolation: tmpdir + fixture repo (one dir per case, resettable); Docker sandbox is M4+
- fault-side: attribute failures (env→tool→harness→model) back into traces
- **Read-only case artifact contract**: the task requires the agent to write its conclusion
  to `env/answer.json` (structure per case instruction); the verifier asserts on that file —
  in read-only tasks the environment never changes, so the answer must be persisted as an
  artifact before the agent's work can be verified; otherwise it is only a fixture self-check

## Three parts

| Part | Requirement |
|---|---|
| instruction.md | task goal + environment constraints + **answer location (answer.json shape)**; must NOT contain the answer or pass criteria (anti-shortcut) |
| env/ | fixture: minimal compilable project with a bug/pending change; read-only + resettable; **answer.json is an agent artifact, not preset in the fixture** |
| verifier/ | deterministic check: asserts the final Environment state (file exists / content correct / command output); read-only cases assert on answer.json fields, never on the agent's self-report |

## Naming

`e<NN>-<verb>-<object>`: e01-read-project, e02-edit-file, ...
