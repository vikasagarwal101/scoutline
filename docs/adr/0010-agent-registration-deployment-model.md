# Agent Registration Deployment Model

`scoutline init` deploys two layers into each detected agent tool's native
homes: a thin always-loaded rules file (identity + capability surface +
`--help` + skill pointer) and the full 41KB agent skill (real copies, no
symlinks). Every shared-file mutation is idempotent, atomic, backed up, and
byte-preserving outside the managed region. `init --unregister` reverses
everything byte-identically.

## Why dedicated files + per-tool pointers, not a single mechanism?

- **Claude Code** reads `~/.claude/CLAUDE.md` (shared file) but discovers rules
  through `@rules/` mention lines — a dedicated rule file plus one pointer
  line is the native idiom.
- **opencode** loads rules from an `instructions` array in `opencode.json` —
  a JSON file that cannot carry HTML comment markers. The pointer is a
  surgical array-entry insert with `JSON.parse` validation and rollback.
- **codex** has no include mechanism — the rule content lives inside a marker
  block directly in `AGENTS.md`.
- **copilot** auto-discovers modular instruction files (`*.instructions.md`)
  with zero pointer wiring needed.
- **gemini/Antigrativity/qwen** have import/include grammars — dedicated file
  plus one marker-wrapped import line.

One mechanism cannot serve these surfaces; five per-tool wirings can.

## Why real copies, not symlinks?

Claude Code breaks on symlinks. Real copies are uniform across all six tools,
survive source-directory moves, and cost ~41KB per tool — negligible.

## Why lazy version-stamped refresh?

No npm postinstall (allow-scripts trap); the stamp file records the deployed
version; any CLI run notices staleness and refreshes both layers honoring the
persisted `agentRules` config choices. Registration is best-effort — a broken
refresh never breaks the invoked command.

## Rejected alternatives

- Single marker-block in every shared file — impossible: JSON cannot carry
  HTML comments (opencode).
- Unlinked dedicated files only — agents don't discover files their configs
  never reference.
- MCP server registration — deferred (seed 12); would require a server mode.
- npm postinstall — fragile under allow-scripts policies.
