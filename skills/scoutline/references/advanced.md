# Advanced Usage

This reference covers advanced commands and performance tuning for `scoutline`.

## Raw MCP Tools

Use these when you need schemas or direct tool invocation.

- `scoutline tools [--filter <text>] [--full] [--typescript] [--no-vision]`
- `scoutline tool <name> [--no-vision]`
- `scoutline call <tool> [--json <json> | --file <path> | --stdin] [--dry-run] [--no-vision]`

### Examples

```bash
scoutline tools --filter vision --full
scoutline tool scoutline.zai.zread.search_doc --no-vision
scoutline call scoutline.zai.search.webSearchPrime --json '{"search_query":"LLM tools"}'
```

## Code Mode (TypeScript tool chains)

```bash
scoutline code run ./chain.ts
scoutline code eval "await call('scoutline.zai.search.webSearchPrime', { search_query: 'Z.AI' })"
scoutline code interfaces
```

## Performance Tuning

### Skip vision MCP startup

```bash
scoutline tools --no-vision
scoutline doctor --no-vision
```

### Tool discovery cache (speeds `tools`/`tool`/`doctor`)

Defaults: enabled, 24 hour TTL.

```bash
export ZAI_MCP_TOOL_CACHE=1
export ZAI_MCP_TOOL_CACHE_TTL_MS=300000
export ZAI_MCP_CACHE_DIR="$HOME/.cache/scoutline"
```

### Retries for transient MCP failures

```bash
# Vision-only retries (default 2)
export ZAI_MCP_VISION_RETRY_COUNT=2

# Global retries for all tools
export ZAI_MCP_RETRY_COUNT=1
```

### Timeout

```bash
export Z_AI_TIMEOUT=300000  # milliseconds
```
