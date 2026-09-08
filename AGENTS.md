# AGENTS.md

Repository instructions for coding agents. **The full guide is
[CLAUDE.md](CLAUDE.md)** - read it before changing anything. It carries the
architecture, the entry points, the commands, and the traps that have each cost
real time.

Only one rule is repeated here, because it is the one whose consequences cannot
be undone.

## Commit identity

This repository is public, and commit authorship is published with it.

- Never commit with a work or employer address, or a machine-local one
  (`*.local`). Use `imperator28@users.noreply.github.com`.
- `.githooks/pre-commit` enforces this. Activate it once per clone:

```bash
sh scripts/setup-repo-hooks.sh
```

- Never pass `--no-verify` to work around it.

## Telemetry

There is none, and none should be added unasked. `api.openai.com` is the only
host the caption process contacts.
