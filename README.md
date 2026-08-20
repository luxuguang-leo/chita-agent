# chita

A local terminal coding agent. Single binary, eval-driven, audit-friendly.

- **Form**: a single-binary terminal CLI (`--print` first, TUI via pi-tui)
- **Positioning**: a harness layer — freeze the model, rewrite the surrounding harness, and let eval data drive harness improvement
- **Three goals**:
  1. **Session-recoverable** — no context loss on crash or terminal switch (tape-first storage + compaction)
  2. **Eval-driven** — write the eval before the code (EDD); traces anchor improvements
  3. **Audit-friendly** — text lockfile, `bun audit`, pinned MCP/Skills

## Install

Build the standalone binary (Bun compile, one-line install like codex):

```bash
bun build --compile --target=bun ./packages/cli/src/index.ts --outfile ./dist/chita
```

`bun run build` (without `--compile`) produces a plain JS outfile — that's the CI gate; `--compile` is what you install.

## Usage

```bash
export CHITA_API_KEY=...          # DeepSeek (OpenAI-compatible)

chita init                        # create ~/.chita/config.json
chita "explain this project"      # run a task (--print mode)
chita --plan "review this diff"   # read-only analysis (plan mode, no write tools)
chita --judge "fix this bug"      # run + /goal independent verification
chita --version

# Task instructions work in any natural language.
```

| Env var | Description |
|---|---|
| `CHITA_API_KEY` | Required. OpenAI-compatible provider key (DeepSeek / Kimi / GLM / Ollama) |
| `CHITA_JUDGE_MODEL` | Optional. Model for `/goal` verification (defaults to the other tier) |

## Architecture

```
UI layer       cli (--print) / tui (pi-tui)
Core           agent loop (state machine + done hard gate)
               ├─ tool registry (permission tiers + beforeToolCall hook)
               ├─ context-manager (compact / truncate / overflow)
               ├─ hook system (before/after tool call, session_end)
               ├─ subagent (TaskResult evidence contract)
               └─ judge (/goal independent anti-early-stop)
Capabilities   ai (OpenAI-compatible provider) · mcp · skills (prompt assembly)
Storage        session-backends (tape-first JSONL + SQLite index)
               memory (4 layers: MEMORY / checkpoint / notes / tasks)
```

Rendered diagram: [`docs/chita-architecture.html`](docs/chita-architecture.html) (self-contained, dark/light theme, PNG/SVG export).

## Evaluation

```bash
bun run evals              # verify-only baseline
bun run evals --run        # agent execution + verifier (needs CHITA_API_KEY)
bun run evals --only e01   # single case
```

8 eval cases (`evals/cases/`): read-project / edit-file / run-test / fix-bug / git-log / grep-search / consistent-edit / verify-output. Each case = instruction + env (fixture) + verifier (deterministic). `--run` isolates fixtures in tmpdir so they are never polluted.

## Development

```bash
bun test                   # 134 tests across packages
bun run build              # build CLI (CI gate)
bunx tsc --noEmit          # type check
```

Monorepo (bun workspaces): `packages/{ai, agent, tools, session, cli, tui, evals}`.

## Security

See [`SECURITY.md`](SECURITY.md). Report vulnerabilities privately via GitHub Security Advisories.

## License

MIT — see [`LICENSE`](LICENSE).
