# Historical: Initial MCP-Native CLI Design

> Status: Completed historical design. It describes the initial MCP-native refactor and may not match the current command surface or roadmap. See [Architecture](../architecture.md) for the current design and [Roadmap](../roadmap.md) for planned work.

# Scoutline MCP CLI v2 - Design + Implementation Plan

## Executive Summary

This document defines the refactor of `scoutline` into a **fully MCP‑native**, LLM‑optimized CLI. The new CLI:

- Uses **UTCP + MCP** for all services, including Vision (stdio).
- Supports **Code Mode** for tool‑chaining via TypeScript.
- Provides **tool discovery, schemas, and raw tool calls** for perfect LLM alignment.
- Outputs **data‑only by default** for token efficiency, with optional JSON wrappers.

The goal is to make every MCP tool discoverable, debuggable, and safe for agent usage while preserving simple human UX.

---

## Goals

1. **Full MCP coverage** for Vision, Search, Reader, and ZRead.
2. **LLM‑first ergonomics**: data‑only output, tool schemas, and chainable execution.
3. **Zero guesswork**: explicit help, tool discovery, and a `doctor` command.
4. **Minimal surface area**: one CLI that is both human‑friendly and agent‑friendly.

---

## Architecture

### High‑Level Flow

```
scoutline
├── MCP Client (UTCP + MCP plugin)
│   ├── Vision (stdio via @z_ai/mcp-server)
│   ├── Search (HTTP)
│   ├── Reader (HTTP)
│   └── ZRead (HTTP)
└── Code Mode (UTCP Code Mode)
    └── Executes TypeScript with tool calls
```

### Why UTCP + MCP?

- Native MCP interoperability.
- Tool discovery (`listTools`) for schema introspection.
- Unified tool naming (`manual.server.tool`).
- Reliable session handling for both stdio and HTTP.

### Why Code Mode?

- Best tool‑chaining workflow for LLMs.
- TypeScript interface generation for all tools.
- Tool discovery + runtime introspection (`__interfaces`).

---

## MCP Servers

### MCP Manual Name

All tools are registered under a single manual name:

```
scoutline.zai.<server>.<tool>
```

Servers:
- `vision`
- `search`
- `reader`
- `zread`

### Vision (stdio)

Command: `npx -y @z_ai/mcp-server@latest`

Tools:
- `analyze_image`
- `ui_to_artifact`
- `extract_text_from_screenshot`
- `diagnose_error_screenshot`
- `understand_technical_diagram`
- `analyze_data_visualization`
- `ui_diff_check`
- `analyze_video`

### Search / Reader / ZRead (HTTP)

Endpoints:

```
https://api.z.ai/api/mcp/web_search_prime/mcp
https://api.z.ai/api/mcp/web_reader/mcp
https://api.z.ai/api/mcp/zread/mcp
```

---

## CLI Surface

### Core Commands

```
scoutline vision <cmd> <source> [prompt] [options]
scoutline search <query> [options]
scoutline read <url> [options]
scoutline repo <cmd> <owner/repo> [args]
```

### LLM‑Focused Meta Commands

```
scoutline tools [--full|--typescript]
scoutline tool <name>
scoutline call <tool> --json <payload>
scoutline doctor
scoutline code <run|eval|interfaces|prompt>
```

---

## Output Contract

### Default (data‑only)

All commands emit the raw tool data to **stdout**, optimized for LLM consumption.

### Optional JSON Wrapper

Use `--output-format json` or `--output-format pretty`:

```json
{
  "success": true,
  "data": "...",
  "timestamp": 1234567890
}
```

Errors are JSON on stderr and include actionable help.

---

## Configuration

### Required

```
Z_AI_API_KEY
```

### Vision MCP Overrides (stdio)

```
Z_AI_VISION_MCP_COMMAND
Z_AI_VISION_MCP_ARGS
Z_AI_VISION_MCP_CWD
Z_AI_VISION_MCP=0   # disable vision MCP
```

### Output

```
ZAI_OUTPUT_MODE=data|json|pretty
```

---

## Implementation Steps (Completed)

1. **Central MCP configuration**
   - Single call template shared by UTCP + Code Mode.

2. **Vision moved to MCP**
   - All 8 tools mapped directly to MCP tool calls.

3. **Tool discovery + raw calls**
   - `tools`, `tool`, and `call` commands.

4. **Code Mode support**
   - `code run`, `code eval`, `code interfaces`, `code prompt`.

5. **Output overhaul**
   - Data‑only output by default, JSON wrapper optional.

6. **Diagnostics**
   - `doctor` command validates env + tool discovery.

---

## Testing Plan

### Required Smoke Tests (per tool)

1. Vision tools:
   - `analyze`, `ui-to-code`, `extract-text`, `diagnose-error`, `diagram`, `chart`, `diff`, `video`
2. Search:
   - `search` with domain + recency
3. Reader:
   - `read` with markdown + text
4. ZRead:
   - `repo tree`, `repo read`, `repo search`

### Optional Integration

- `tools` + `tool` (schema discovery)
- `call` with explicit JSON payload
- `code eval` (tool chaining)
- `doctor` (env + tools)

---

## Open Questions (Optional Future Work)

- Add `--stream` option for streaming responses if MCP servers support it.
- Add caching layer for search/read.
- Add “batch” mode for tool calls.

---

## Summary

This refactor makes `scoutline` **fully MCP‑native**, **LLM‑optimized**, and **discoverable**. All tool schemas are accessible, every endpoint is reachable through a stable interface, and the CLI now supports both direct tool calls and tool‑chaining via Code Mode.
