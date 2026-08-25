# Security Policy

## Supported Versions

No formal release yet; security fixes follow the `main` branch.

| Version | Supported |
| ------- | --------- |
| main (0.x) | ✅ |

## Reporting a Vulnerability

Please report privately — do **not** open a public issue.

- **Preferred**: GitHub Security Advisories → "Report a vulnerability" (private, visible only to maintainers)

We will acknowledge reports within 3 business days and ship a fix as soon as possible.

## Security design (built-in redaction)

- API keys are read only from the `CHITA_API_KEY` env var or `~/.chita/.env` — **never** written to `config.json`, sessions, or git.
- Tool output is redacted by `scrub.ts` (F4) before reaching the model or the tape in the main loop (CLI/TUI/evals), covering `sk-` / `Bearer` / PEM private keys / AWS `AKIA` / GitHub tokens.
- `bun.lock` is plain-text and auditable; MCP/skills are pinned.

## Known limitations

- `scrub.ts` is currently mounted on the main loop only (`afterToolCall`); the `subagent` / `workflow` / `debug-run` paths do not redact tool output before it reaches the model.
- User input (including pasted secrets) is not redacted and enters the session tape and compaction summaries.
- Both items are tracked in dev log cur-084 and are planned for a later release.

## Scope

- Key/redaction defects (scrub misses, keys accidentally persisted) are the highest priority.
- Supply-chain issues in dependencies, MCP servers, and skills.
