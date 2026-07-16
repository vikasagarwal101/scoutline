---
name: scoutline
description: |
  Z.AI CLI providing:
  - Vision: image/video analysis, OCR, UI-to-code, error diagnosis (GLM-4.6V)
  - Search: real-time web search with domain/recency filtering
  - Reader: web page to markdown extraction
  - Repo: GitHub code search and reading via ZRead
  - Tools: MCP tool discovery and raw calls
  - Code: TypeScript tool chaining
  Use for visual content analysis, web search, page reading, or GitHub exploration. Requires Z_AI_API_KEY.
---

# Scoutline

Access Z.AI capabilities via `npx scoutline`. The CLI is self-documenting - use `--help` at any level.

## Setup

```bash
export Z_AI_API_KEY="your-api-key"
```

Get a key at: https://z.ai/manage-apikey/apikey-list

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| vision | Analyze images, screenshots, videos | `--help` for 8 subcommands |
| search | Real-time web search | `--help` for filtering options |
| read | Fetch web pages as markdown | `--help` for format options |
| repo | GitHub code search and reading | `--help` for tree/search/read |
| tools | List available MCP tools | |
| tool | Show tool schema | |
| call | Raw MCP tool invocation | |
| code | TypeScript tool chaining | |
| doctor | Check setup and connectivity | |

## Quick Start

```bash
# Analyze an image
npx scoutline vision analyze ./screenshot.png "What errors do you see?"

# Search the web
npx scoutline search "React 19 new features" --count 5

# Read a web page
npx scoutline read https://docs.example.com/api
npx scoutline read https://docs.example.com/api --with-images-summary --no-gfm

# Explore a GitHub repo
npx scoutline repo search facebook/react "server components"
npx scoutline repo search openai/codex "config" --language en
npx scoutline repo tree openai/codex --path codex-rs --depth 2

# Check setup
npx scoutline doctor
```

## Output

Default: **data-only** (raw output for token efficiency).
Use `--output-format json` for `{ success, data, timestamp }` wrapping.

## Advanced

For raw MCP tool calls (`tools`, `tool`, `call`), Code Mode, and performance tuning (cache/retries),
see `references/advanced.md`.
