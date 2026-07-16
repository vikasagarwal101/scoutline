# Configuration

Scoutline reads configuration from environment variables. Set the API key before using any network-backed command:

```bash
export Z_AI_API_KEY="your-api-key"
```

`ZAI_API_KEY` remains accepted for compatibility, but new setups should use `Z_AI_API_KEY`.

Scoutline currently uses the Z.AI provider adapter. Raw tool calls are qualified as `scoutline.zai.<service>.<tool>` so future providers can receive their own namespace without changing the Scoutline command surface.

## Core Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AI_API_KEY` | Required | Z.AI API key. |
| `Z_AI_MODE` or `PLATFORM_MODE` | `ZAI` | Selects `ZAI` or `ZHIPU` base URLs. |
| `Z_AI_BASE_URL` | Mode-specific URL | Overrides the API base URL. |
| `Z_AI_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `Z_AI_VISION_MODEL` | `glm-4.6v` | Vision model name. |
| `Z_AI_TEMPERATURE` | `0.8` | Vision generation temperature. |
| `Z_AI_TOP_P` | `0.6` | Vision generation top-p value. |
| `Z_AI_MAX_TOKENS` | `32768` | Vision response token limit. |

## Output Modes

The default is data-only output for pipelines and agents. When stdout is interactive, the CLI automatically uses a TTY-oriented presentation unless an explicit mode is supplied.

```bash
scoutline --output-format json search "MCP protocol"
scoutline -O markdown search "MCP protocol"
scoutline --pretty-output read https://example.com
```

Use `scoutline --help` for the complete list of output aliases and command-specific format support.

## Vision MCP

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AI_VISION_MCP` | enabled | Set to `0` or `false` to disable the vision server. |
| `Z_AI_VISION_MCP_COMMAND` | `npx` | Command used to start the vision MCP server. |
| `Z_AI_VISION_MCP_ARGS` | `-y @z_ai/mcp-server@latest` | Arguments passed to the vision server command. |
| `Z_AI_VISION_MCP_CWD` | Current directory | Working directory for the vision server. |
| `ZAI_MCP_VISION_RETRY_COUNT` | `2` | Retries for vision tool calls. |
| `ZAI_MCP_RETRY_COUNT` | `1` | Retries for other MCP tool calls. |

## Response Cache

Search, reader, and ZRead responses are cached locally unless a command receives `--no-cache`. The cache is best-effort, keyed by API-key hash plus request-affecting arguments, and stores no cleartext API key.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZAI_CACHE` | `1` | Set to `0` or `false` to disable the response cache. |
| `ZAI_CACHE_DIR` | Platform cache directory | Overrides the response-cache directory. |
| `ZAI_CACHE_TTL_MS` | 24 hours | Response freshness window. |
| `ZAI_CACHE_SIZE_MB` | `100` | Maximum cache size before LRU eviction. |
| `ZAI_MCP_TOOL_CACHE` | enabled | Enables the separate MCP tool-discovery cache. |
| `ZAI_MCP_TOOL_CACHE_TTL_MS` | 24 hours | Tool-discovery cache freshness window. |
| `ZAI_MCP_CACHE_DIR` | Platform cache directory | Overrides the tool-discovery cache directory. |

On Linux, the default response cache location is `~/.cache/scoutline/responses` unless `XDG_CACHE_HOME` is defined.

## Security

Keep `Z_AI_API_KEY` in your shell profile, secret manager, or CI secret store. Do not put it in command arguments, committed files, generated reports, or bug reports.
