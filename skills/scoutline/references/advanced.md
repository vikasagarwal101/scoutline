# Advanced Usage

This reference covers advanced commands and performance tuning for
`scoutline`, plus Provider-specific configuration and the package publication
gate.

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`) and
**`repo`** accept the global `--provider <zai|minimax>` flag. Precedence:

1. `--provider <zai|minimax>` on the command line
2. `SCOUTLINE_PROVIDER` environment variable
3. Default `zai`

Unknown or empty values fail with `VALIDATION_ERROR` before any Provider
invocation. Provider selection is never inferred from credentials.

`read`, `tools`, `tool`, `call`, and `code` accept the flag but ignore it;
they remain Z.AI-only and do not validate the supplied value. `repo`
participates in selection but only Z.AI currently supplies the
`repository-exploration` Capability — selecting MiniMax returns
`UNSUPPORTED_CAPABILITY` before descriptor configuration, Adapter creation,
credential resolution for use, cache identity, or transport construction,
with no fallback.

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

### Repository Cache

Repository results share the partitioned namespace and use a composite
operation suffix so File and Directory listings cannot collide:

```
v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json
```

`<operation>` is one of `repository-search`, `repository-read-file`, or
`repository-list-directory`. The Adapter resolves its credential once; that
same credential drives both the new fingerprint and the legacy-key
reconstruction. No ambient environment is reread. A valid legacy v0.2 hit is
written through to the new key; the legacy file is never rewritten,
migrated, or deleted. `--no-cache` performs no reads or writes — the
operation validates, computes the identity, invokes the Adapter, projects
the result, and returns.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZAI_CACHE` | `1` | Set to `0` or `false` to disable the response cache. |
| `ZAI_CACHE_DIR` | Platform cache directory | Overrides the response-cache directory. |
| `ZAI_CACHE_TTL_MS` | 24 hours | Response freshness window. |
| `ZAI_CACHE_SIZE_MB` | `100` | Maximum cache size before LRU eviction. |

On Linux, the default cache directory is `~/.cache/zai-cli/responses`
(or `$XDG_CACHE_HOME/zai-cli/responses` when `XDG_CACHE_HOME` is set).
The same directory holds both provider-partitioned entries written by
the current release and legacy Z.AI-only entries written by earlier
versions; legacy entries are read through Adapter-supplied legacy
candidate keys and never migrated or deleted.

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

Inventory derivation is descriptor-driven: `sharedCapabilities` is the
intersection across built-in Provider descriptors; `zaiOnlyCapabilities` is
Z.AI support minus the union of every other built-in descriptor.
`repository-exploration` is therefore reported under Z.AI-only while still
participating in Provider selection. Doctor help explicitly names MiniMax
as unsupported for `repo`.

### Repository Pipeline

```text
repo argv
  -> parse-level grammar validation
  -> --provider / SCOUTLINE_PROVIDER / default zai
  -> descriptor capability check (repository-exploration)
  -> descriptor.isConfigured (effective Provider)
  -> descriptor.create -> Adapter
  -> Provider-neutral Explorer (canonical paths, BFS, projection)
       -> executeRepositoryOperation
            -> validate -> Adapter cache identity -> partitioned cache
            -> legacy candidate decode
            -> Adapter invoke (Z.AI: resolved public/internal ZRead name),
               wrapped through one retry (single-retry non-Vision policy)
            -> normalized cache write
  -> schema-version-1 CommandResult
```

The Explorer owns canonical repository paths, deterministic breadth-first
traversal, deduplication, request-bound directory safety, schema-v1
projection, and local `--max-chars` projection. The Z.AI Adapter owns
credential resolution, legacy-key reconstruction, encoded MCP error
parsing, and best-effort per-attempt close.

### Encoded MCP Error Taxonomy

Encoded `MCP error -<status>` strings and malformed ZRead wrappers are
recognized before success parsing. Raw Provider body, reset metadata, error
code text, and message strings are discarded:

| Provider condition | Public code | Status | Retry |
| --- | --- | --- | --- |
| Exhausted quota (`1310` or explicit exhausted limit) | `QUOTA_ERROR` | 429 | terminal |
| Transient 429 / "rate limited" | `API_ERROR` | 429 | one retry |
| Auth 401 / 403 | `AUTH_ERROR` | matching | terminal |
| Provider 5xx | `API_ERROR` | matching | one retry |
| Other 4xx (including 404) | `API_ERROR` | matching | terminal |
| Malformed envelope or success wrapper | `API_ERROR` | 502 | one retry |

Each repository operation receives the current single-retry non-Vision
policy. A retry creates a fresh Adapter transport attempt with one
best-effort close; cache hits construct and close no transport. A successful
operation does not become a failure when close rejects or times out, and a
primary failure remains the outward failure when close also fails.

### Repository Path Conventions

- Tree aliases omitted, empty, `/`, or `.` normalize to root `""`.
- File paths must be non-root; the root is invalid for `repo read`.
- Leading `./` and leading `/` are accepted on File; leading and trailing
  `/` are stripped and repeated `/` collapses on both.
- Actual `.`/`..` segments, backslashes, and ASCII control characters are
  rejected.
- Percent escapes (`%XX`) are never decoded — they remain literal.

BFS expands only while `level < depth`, enqueues a canonical directory once,
preserves Provider sibling order, and snapshots in breadth-first order.
Canonical-but-outside child paths fail the whole tree rather than redirect
traversal; a mid-tree failure rejects the whole operation with no partial
result.

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