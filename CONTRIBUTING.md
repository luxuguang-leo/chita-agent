# Contributing to chita

Thanks for considering contributing to chita! This project is a local terminal coding agent — single binary, eval-driven, audit-friendly. We welcome issues, PRs, and design discussions.

## Ground rules

- **Harness layer, not model work.** chita's position: freeze the model, rewrite the surrounding harness, let eval data drive improvement. PRs should target the harness (storage, tools, session, eval, TUI, CLI) rather than prompt-tuning the model.
- **Eval first (EDD).** New agent capabilities should come with an eval case in `evals/cases/`. Write the eval before the code; traces anchor improvements.
- **Tests must pass.** `bun test` before pushing. CI runs `bun test` + `bun run build` on every PR.
- **No personal paths.** Keep machine-specific paths out of code, docs, and fixtures. Use relative paths or config in `~/.chita/`.

## Getting started

```bash
git clone https://github.com/luxuguang-leo/chita-agent.git
cd chita-agent
bun install
bun test          # 182 tests across packages
bun run build     # build CLI (CI gate)
bun run evals     # verify-only baseline (no API key needed)
```

Monorepo (bun workspaces): `packages/{ai, agent, tools, session, cli, tui, evals}`.

## Making changes

1. Create a branch: `git checkout -b feat/your-change`
2. Make the change; add/adjust tests.
3. If it touches agent behavior, add an eval case (`evals/cases/<id>/` with `instruction.md` + `env/` + `verifier/`).
4. Run `bun test` and `bunx tsc --noEmit`.
5. Commit with a clear message (conventional commits preferred, e.g. `fix(session): ...`, `feat(tools): ...`).
6. Open a PR against `main`. Describe the change, how it was verified, and any eval results.

## Reporting bugs

Open an issue with:

- What you ran (command, input)
- What happened (error output / trace)
- What you expected
- If it's a session/tape issue, the relevant portion of the trace

For security issues, follow [`SECURITY.md`](SECURITY.md) — report privately, never in a public issue.

## Development notes

- `bun run evals --run` executes agent runs against real models (needs `CHITA_API_KEY`); `--only <id>` runs a single case.
- Eval fixtures are isolated in tmpdir during `--run` so they are never polluted.
- Design documents live in `docs/` (architecture diagram, PDF).

## License

By contributing, you agree your contributions are licensed under the MIT License (see [`LICENSE`](LICENSE)).
