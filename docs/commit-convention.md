# chita Commit Message Convention

> Effective 2026-08-25. Style reference: Hermes agent repo (conventional commits, `type(scope): subject`).
> This file is the single source of truth for commit messages in this repository.

## Format

```
type(scope): subject

body (what / why / evidence)
```

### Type

Lowercase, one of:

| type | meaning |
|---|---|
| `feat` | new user-visible capability |
| `fix` | bug fix (crashes, wrong behavior, data loss) |
| `refactor` | behavior-preserving code change |
| `perf` | performance improvement |
| `test` | tests only |
| `docs` | documentation (README, docs/, comments) |
| `ci` | CI / release pipeline |
| `chore` | maintenance (deps, lockfile, license, redaction) |
| `build` | build system / compilation |

Project-specific capability types are allowed when a change is confined to one surface
and none of the above fit exactly (historical precedent: `banner`). Prefer a standard
type + scope over inventing a new one.

### Scope (optional)

Lowercase package/surface: `agent`, `cli`, `tools`, `session`, `tui`, `evals`, `docs`, `ci`.
`fix(agent): ...`, `feat(tui): ...`.

### Subject

- Imperative mood, ≤ 72 characters, no trailing period: `fix(session): resume restores token counters`.
- **English only** — no Chinese in the subject (or body).
- **No personal names** — no "Leo", "per user", or tool names in parens. Context like
  "which option was picked" or "what the symptom was" is welcome as a factual
  parenthetical: `tui: show startup banner (was missing on launch)` — never
  `tui: show startup banner (Leo: missing on launch)`.
- No emoji.

### Body

Explain what changed and why when the subject alone is not enough. Include evidence:
test counts (`tests: 182 pass, tsc clean`), design/review references (`cur-102`,
`v2.1 §9 P1-1`), milestone markers (`M1.5`, `M-next`). Keep review round-trips in the
history — they are the audit trail (eval-driven, supply-chain-auditable project).

## Examples

```
# bad
TUI: show startup banner (Leo: missing on launch)
persist token usage; resume restores counters (Leo: restart showed 0)

# good
tui: show startup banner on launch
fix(session): persist token usage; resume restores counters (restart showed 0)
```

## History rewrite policy

Rewriting published history requires explicit approval (force-push is destructive).
Amending the *most recent* unpushed commit is fine; anything already on `main` needs
`--force-with-lease` + maintainer sign-off.

## Workflow

1. `git commit` with a compliant message.
2. PR title mirrors the commit subject.
3. CI (`bun test` + `bun run build`) must be green before merge.
