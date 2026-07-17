# Advanced Usage

This reference covers advanced commands and performance tuning for
`scoutline`, plus Provider-specific configuration and the package publication
gate.

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`) accept the
global `--provider <zai|minimax>` flag. Precedence:

1. `--provider <zai|minimax>` on the command line
2. `SCOUTLINE_PROVIDER` environment variable
3. Default `zai`

Unknown or empty values fail with `VALIDATION_ERROR` before any Provider
invocation. Provider selection is never inferred from credentials.

`read`, `repo`, `tools`, `tool`, `call`, and `code` accept the flag but
ignore it; they remain Z.AI-only in the base release and do not validate the
supplied value.

```bash
# 1. Flag wins over everything
scoutline --provider minimax search "React 19 features"

# 2. Environment variable when no flag is supplied
export SCOUTLINE_PROVIDER=minimax
scoutline quota

# 3. Default Z.AI when nothing is supplied
scoutline search "TypeScript best practices"
```

## MiniMax Token Plan Configuration

The MiniMax Adapter is configured entirely through three environment
variables. Scoutline does not read `~/.mmx/config.json`, reuse `mmx` OAuth
state, or persist MiniMax credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINIMAX_API_KEY` | Required for MiniMax | MiniMax Token Plan API key. |
| `MINIMAX_REGION` | `global` | Selects the MiniMax region. Accepted values: `global`, `cn`. |
| `MINIMAX_BASE_URL` | Region URL | Absolute HTTPS override for the MiniMax endpoint. |

Region base URLs:

| Region | Base URL |
| --- | --- |
| `global` | `https://api.minimax.io` |
| `cn` | `https://api.minimaxi.com` |

Rules:

- `MINIMAX_API_KEY` is required and non-empty.
- `MINIMAX_REGION` defaults to `global`; empty or unknown values are invalid.
- `MINIMAX_BASE_URL` must be an absolute HTTPS URL. Exactly one trailing slash
  is removed. The override applies to every MiniMax operation (Search,
  Vision, quota, diagnostics).
- Scoutline does not invoke the `mmx` executable or require a global
  installation.

```bash
export MINIMAX_API_KEY="your-minimax-key"
export MINIMAX_REGION=cn
export MINIMAX_BASE_URL=https://api.example.test   # optional HTTPS override

scoutline --provider minimax search "AI policy"
scoutline --provider minimax quota
scoutline doctor --provider minimax
```

## Provider-Specific Image Limits

`scoutline vision analyze` enforces Provider-specific media rules before any
credential or transport access:

| Provider | Formats | Maximum |
| --- | --- | --- |
| Z.AI | JPG, JPEG, PNG | 5 MiB |
| MiniMax | JPG, JPEG, PNG, WebP | 50 MiB |

Vision results are never written to the local response cache.

## Raw MCP Tools (Z.AI)

Use these when you need schemas or direct tool invocation.

- `scoutline tools [--filter <text>] [--full] [--typescript] [--no-vision]`
- `scoutline tool <name> [--no-vision]`
- `scoutline call <tool> [--json <json> | --file <path> | --stdin] [--dry-run] [--no-vision]`

```bash
scoutline tools --filter vision --full
scoutline tool scoutline.zai.zread.search_doc --no-vision
scoutline call scoutline.zai.search.webSearchPrime --json '{"search_query":"LLM tools"}'
```

## Code Mode (Z.AI, TypeScript tool chains)

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

## Response Cache

Search, reader, and ZRead responses are cached locally unless a command
receives `--no-cache`. New cache keys are provider-partitioned:

```
v2.<capability>.<provider>.<credential-hash>.<request-hash>.json
```

The credential hash is a SHA-256 fingerprint supplied by the Adapter; cache
code never re-hashes it. Legacy `zai-cli` cache entries remain readable for
Z.AI as Adapter-owned candidates; their decoder is Provider-owned because the
old entries contain Provider response fields. Old entries are never migrated
or deleted.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZAI_CACHE` | `1` | Set to `0` or `false` to disable the response cache. |
| `ZAI_CACHE_DIR` | Platform cache directory | Overrides the response-cache directory. |
| `ZAI_CACHE_TTL_MS` | 24 hours | Response freshness window. |
| `ZAI_CACHE_SIZE_MB` | `100` | Maximum cache size before LRU eviction. |

On Linux, the default cache directory is `~/.cache/scoutline/responses`
unless `XDG_CACHE_HOME` is defined. The legacy `zai-cli` cache directory
(`~/.cache/zai-cli/responses`) is preserved as a read-only fallback; old
entries are never migrated.

## Normalized Quota and Diagnostics

`scoutline quota` returns a schema-version-1 `QuotaDashboard` (ADR-0001).
Percentages are remaining percentages clamped to `0..100`. Provider-specific
fields do not cross the Interface.

```bash
scoutline quota                       # effective Provider
scoutline quota --all-providers       # every configured Provider; exit 1 if any fails
```

`scoutline doctor` returns a schema-version-1 `DiagnosticsReport` listing
every built-in Provider with its configured state, declared Capabilities, and
probe status. It exits 1 when the effective Provider is unconfigured or any
configured probe fails.

```bash
scoutline doctor                # full diagnostics
scoutline doctor --no-tools     # metadata only, no transport
scoutline doctor --provider minimax
```

## Test Commands

```bash
# From packages/scoutline
npm run build
npm test                                # alias for npm run test:offline
npm run test:offline                    # full offline suite
npm run test:smoke                      # executable smoke suite
SCOUTLINE_LIVE_TESTS=1 npm run test:live               # both opt-in live files
SCOUTLINE_LIVE_TESTS=1 npm run test:live:release       # requires Z_AI_API_KEY + MINIMAX_API_KEY
```

`npm run prepublishOnly` is wired to the full offline suite, so publishing
without a green offline build fails fast.

## Transitional MiniMax SDK

The initial MiniMax Adapter uses `mmx-cli/sdk@1.0.16` as a replaceable
transport for Search and Vision. Only `src/providers/minimax/sdk-client.ts`
imports the SDK directly; everything else goes through an Adapter port. Quota
uses a narrow Adapter-local transport against
`<baseUrl>/v1/api/openplatform/coding_plan/remains` because the pinned SDK
does not preserve an arbitrary configured quota host.

Replacing the SDK transport with a direct MiniMax endpoint implementation
requires no change outside the MiniMax Adapter, its transport tests, the
package manifest, the lockfile, and the documentation. The same Search,
Vision, quota, diagnostics, media, error, and live conformance suite must
pass before the SDK pin is removed. No release date for the direct
replacement is currently planned.