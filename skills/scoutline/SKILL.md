---
name: scoutline
description: |
  Z.AI and MiniMax CLI providing:
  - Vision: image/video analysis, OCR, UI-to-code, error diagnosis (GLM-4.6V)
  - Search: real-time web search with domain/recency filtering
  - Reader: web page to markdown extraction
  - Repo: GitHub code search and reading via ZRead
  - Tools: MCP tool discovery, schemas, and raw calls (Z.AI)
  - Code: TypeScript tool chaining (Z.AI)
  - Provider selection: --provider <zai|minimax> for shared capabilities
  Use for visual content analysis, web search, page reading, or GitHub
  exploration. Requires Z_AI_API_KEY (default) or MINIMAX_API_KEY (with
  --provider minimax).
---

# Scoutline

Access Z.AI and MiniMax capabilities via `npx scoutline`. The CLI is
self-documenting — use `--help` at any level.

## Setup

```bash
# Z.AI (default Provider)
export Z_AI_API_KEY="your-api-key"

# OR MiniMax Token Plan
export MINIMAX_API_KEY="your-minimax-key"
export MINIMAX_REGION=global  # optional: defaults to "global"; alternative is "cn"
```

Get a Z.AI key at: https://z.ai/manage-apikey/apikey-list

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`) accept the
global `--provider <zai|minimax>` flag. Precedence is the flag, then the
`SCOUTLINE_PROVIDER` environment variable, then the default `zai`. Provider
selection is never inferred from credentials. Unknown values fail fast with
`VALIDATION_ERROR`.

`read`, `repo`, `tools`, `tool`, `call`, and `code` accept the flag but ignore
it; they remain Z.AI-only in the base release.

## Capability Matrix

| Capability | Z.AI | MiniMax | Command |
| --- | --- | --- | --- |
| Search | Yes | Yes (no domain/recency/content-size/location) | `scoutline search` |
| General single-image interpretation | Yes | Yes (JPG/JPEG/PNG/WebP ≤50 MiB) | `scoutline vision analyze` |
| Specialized Vision (UI-to-code, OCR, error diagnosis, diagram, chart) | Yes | No | `scoutline vision ui-to-code` etc. |
| Two-image diff, video | Yes | No | `scoutline vision diff`, `vision video` |
| Quota (normalized) | Yes | Yes | `scoutline quota [--all-providers]` |
| Diagnostics | Yes | Yes | `scoutline doctor [--no-tools]` |
| Reader | Yes | No | `scoutline read` |
| Repo (GitHub via ZRead) | Yes | No | `scoutline repo` |
| Raw tools | Yes | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | `scoutline code` |

Vision results are never cached. Z.AI image limits are JPG/JPEG/PNG ≤5 MiB.
Search result count is applied locally after normalization and is never sent
to either Provider.

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| vision | Analyze images, screenshots, videos | `--help` for 8 subcommands |
| search | Real-time web search | `--help` for filtering options |
| read | Fetch web pages as markdown | `--help` for format options |
| repo | GitHub code search and reading | `--help` for tree/search/read |
| quota | Provider-normalized plan usage dashboard | `--help` for `--all-providers` |
| tools | List available MCP tools (Z.AI) | |
| tool | Show tool schema | |
| call | Raw MCP tool invocation | |
| doctor | Provider-aware diagnostics | `--help` for `--no-tools` |
| code | TypeScript tool chaining (Z.AI) | |

## Quick Start

```bash
# Z.AI (default)
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
npx scoutline search "React 19 new features" --count 5
npx scoutline read https://docs.example.com/api
npx scoutline read https://docs.example.com/api --with-images-summary --no-gfm
npx scoutline repo search facebook/react "server components"
npx scoutline repo search openai/codex "config" --language en
npx scoutline repo tree openai/codex --path codex-rs --depth 2
npx scoutline quota
npx scoutline doctor

# MiniMax Token Plan
npx scoutline --provider minimax search "AI policy news"
npx scoutline --provider minimax vision analyze ./diagram.png "Explain this"
npx scoutline --provider minimax quota
npx scoutline doctor --provider minimax

# All-Provider quota
npx scoutline quota --all-providers
```

## Output

Default: **data-only** (raw output for token efficiency).
Use `--output-format json` for `{ success, data, timestamp }` wrapping.

`quota` returns a schema-version-1 `QuotaDashboard` (ADR-0001); `doctor`
returns a schema-version-1 `DiagnosticsReport`. Both are Provider-neutral.

## Advanced

For raw MCP tool calls (`tools`, `tool`, `call`), Code Mode, package and
publication gates, MiniMax environment variables, and legacy `zai-cli` cache
fallback, see `references/advanced.md`.