# Configuration

Scoutline reads configuration from environment variables. Set the API key
before using any network-backed command:

```bash
export Z_AI_API_KEY="your-api-key"
```

`ZAI_API_KEY` remains accepted for compatibility, but new setups should use
`Z_AI_API_KEY`.

## Provider Selection

Shared commands (`search`, `vision`, `quota`, `doctor`) and **`repo`**
accept the global `--provider <zai|minimax>` flag. When the flag is omitted
the value of the `SCOUTLINE_PROVIDER` environment variable is consulted; when
neither is supplied Scoutline falls back to the compatibility default `zai`.

Resolution precedence (highest first):

1. `--provider <zai|minimax>` on the command line
2. `SCOUTLINE_PROVIDER`
3. `zai` (default)

Provider selection is never inferred from which credentials happen to be
present. Unknown or empty values fail fast with `VALIDATION_ERROR` before any
Provider invocation.

`scoutline read`, `scoutline tools`, `scoutline tool`, `scoutline call`, and
`scoutline code` accept the flag but ignore it; they continue to use Z.AI and
do not validate the supplied value. MiniMax does not currently advertise the
`repository-exploration` Capability — selecting MiniMax (explicitly or via
`SCOUTLINE_PROVIDER`) for any `repo` subcommand returns `UNSUPPORTED_CAPABILITY`
before descriptor configuration, Adapter creation, credential resolution for
use, cache identity, or transport construction, with no fallback to Z.AI.

```bash
# 1. Flag wins
scoutline --provider minimax search "React 19 features"

# 2. Environment variable when no flag is supplied
export SCOUTLINE_PROVIDER=minimax
scoutline quota

# 3. Default Z.AI when nothing is supplied
scoutline search "TypeScript best practices"

# repo participates in selection; MiniMax returns UNSUPPORTED_CAPABILITY
scoutline repo search facebook/react "server components"
scoutline --provider minimax repo search owner/repo query  # exits 1, UNSUPPORTED_CAPABILITY
```

## Core Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AI_API_KEY` | Required for Z.AI | Z.AI API key. |
| `ZAI_API_KEY` | Alias for `Z_AI_API_KEY` | Compatibility alias. |
| `Z_AI_MODE` or `PLATFORM_MODE` | `ZAI` | Selects `ZAI` or `ZHIPU` base URLs. |
| `Z_AI_BASE_URL` | Mode-specific URL | Overrides the API base URL. |
| `Z_AI_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `Z_AI_VISION_MODEL` | `glm-4.6v` | Vision model name. |
| `Z_AI_TEMPERATURE` | `0.8` | Vision generation temperature. |
| `Z_AI_TOP_P` | `0.6` | Vision generation top-p value. |
| `Z_AI_MAX_TOKENS` | `32768` | Vision response token limit. |
| `SCOUTLINE_PROVIDER` | (none) | Selects the effective Provider (`zai` or `minimax`) for shared capabilities. |

## MiniMax Token Plan Settings

The MiniMax Adapter is configured through three MiniMax-specific environment
variables. Scoutline does not read `~/.mmx/config.json`, reuse `mmx` OAuth
state, or persist MiniMax credentials anywhere on disk.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINIMAX_API_KEY` | Required for MiniMax | MiniMax Token Plan API key. |
| `MINIMAX_REGION` | `global` | Selects the MiniMax region. Accepted values: `global`, `cn`. |
| `MINIMAX_BASE_URL` | Region URL | Absolute HTTPS override for the MiniMax endpoint. Overrides the region URL for every MiniMax operation. |

Region base URLs:

| Region | Base URL |
| --- | --- |
| `global` | `https://api.minimax.io` |
| `cn` | `https://api.minimaxi.com` |

Rules:

- `MINIMAX_API_KEY` is required and non-empty. Whitespace-only is invalid.
- `MINIMAX_REGION` defaults to `global` when unset. Empty or unknown values
  are invalid, not absent.
- `MINIMAX_BASE_URL` must be an absolute HTTPS URL. Exactly one trailing slash
  is removed.
- An explicit `MINIMAX_BASE_URL` overrides the region URL for Search,
  Vision, quota, and diagnostics.
- MiniMax environment names do not appear in shared `lib/config.ts`. They
  live exclusively under `providers/minimax/`.
- Scoutline does not invoke the `mmx` executable or require a global
  installation.

```bash
export MINIMAX_API_KEY="your-minimax-key"
export MINIMAX_REGION=cn             # optional: defaults to "global"
export MINIMAX_BASE_URL=https://api.example.test   # optional: HTTPS override

scoutline --provider minimax search "AI policy"
scoutline --provider minimax quota
scoutline doctor --provider minimax
```

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

## Specialized MiniMax Vision Mappings

The five specialized MiniMax Vision operations are implemented as
operation-specific prompt-composition Modules under
`packages/scoutline/src/providers/minimax/vision-mappings/`:

| Operation | CLI subcommand | Module |
| --- | --- | --- |
| `ui-artifact` | `scoutline vision ui-to-code` | `ui-artifact.ts` |
| `extract-text` | `scoutline vision extract-text` | `extract-text.ts` |
| `diagnose-error` | `scoutline vision diagnose-error` | `diagnose-error.ts` |
| `diagram` | `scoutline vision diagram` | `diagram.ts` |
| `chart` | `scoutline vision chart` | `chart.ts` |

Each Module routes through `sdk.vision.describe` with one image — there
is no dedicated MiniMax operation. The shared prompt composition helpers
live in `vision-mappings/common.ts`; changing that file intentionally
invalidates every mapping's revision.

### Conformance gating

Runtime support for a specialized operation is decided by the compiled
conformance registry (`src/providers/minimax/vision-conformance.ts`). A
mapping becomes routable through MiniMax only when **every** condition
holds:

- offline conformance state is `pass`,
- live conformance state is `pass`,
- a sanitized compiled attestation matches the operation, fixture
  version, Implementation identity (`mmx-cli-sdk@1.0.16`), and
  generated mapping revision.

In the current release, `ui-artifact` and `diagnose-error` are
live-attested and supported at runtime. The remaining three operations
(`extract-text`, `diagram`, `chart`) have offline `pass` and live
`pending`. An explicit MiniMax selection for any of those three pending
operations fails closed with `UNSUPPORTED_CAPABILITY` before credentials,
media, transport, cache, or any other Provider is touched (FR-023,
FR-024). There is **no automatic Z.AI fallback** for an explicit MiniMax
selection — drop `--provider minimax` (or `unset SCOUTLINE_PROVIDER`)
to route through Z.AI, which supports every specialized operation.

**No environment variable, flag, or configuration value can promote a
mapping to supported.** Support is driven exclusively by the compiled
registry state. Re-running `npm run build` does not change support on
its own — a live attestation must be recorded first.

### Live attestation

Live attestation requires explicit opt-in and a real `MINIMAX_API_KEY`:

```bash
SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs --operation chart
```

Replace `chart` with one of the other specialized operations. The script:

1. Loads the operation's fixture image and the matching Module.
2. Calls the live Provider with the composed prompt.
3. Evaluates the fixture's semantic assertions in memory against the
   returned text (the text itself is never written to disk).
4. On success, appends a sanitized attestation entry to
   `src/providers/minimax/vision-attestations.ts`, flips the registry's
   `live` state to `pass`, and verifies that
   `isMiniMaxVisionOperationSupported(op)` returns `true`.
5. On failure, sets the registry's `live` state to `fail`. No
   attestation is committed and the mapping remains unsupported.

Re-run `npm run build` after a successful attestation so the registry
is recompiled with the new attestation and the operation becomes
routable at runtime.

The diff (`vision.diff`) and video (`vision.video`) operations are
intentionally **not** registry entries and remain Z.AI-only in the base
release.

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

On Linux, the default response cache directory is
`~/.cache/zai-cli/responses` (or `$XDG_CACHE_HOME/zai-cli/responses`
when `XDG_CACHE_HOME` is set). The same directory holds both
provider-partitioned entries written by the current release and legacy
Z.AI-only entries written by earlier versions; legacy entries are read
through the Adapter-supplied legacy candidate keys and never migrated
or deleted. Set `ZAI_CACHE_DIR` to override the location entirely.

Cache keys are partitioned by Provider: new keys have the shape
`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`. The
credential hash is supplied by the Adapter (a SHA-256 fingerprint); it is
never re-hashed by cache code. Z.AI entries written before the Provider
partitioning remain readable as Adapter-owned candidates; their decoder is
Provider-owned because the old entries contain Provider response fields.

### Repository Cache

Repository results share the partitioned namespace and use a composite
operation suffix to prevent File and Directory listings from colliding:

```text
v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json
```

The Adapter resolves its credential once. That single credential drives both
the fingerprint and the legacy-key reconstruction; no ambient environment
is reread. A valid legacy v0.2 hit is written through to the new key; legacy
files are never migrated, rewritten, or deleted. `--no-cache` performs no
reads or writes — the operation validates, computes the identity, invokes
the Adapter, projects the result, and returns.

## Security

Keep credentials in your shell profile, secret manager, or CI secret store.
Do not put them in command arguments, committed files, generated reports, or
bug reports. Scoutline applies recursive, case-insensitive redaction of every
configured credential (`Z_AI_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`,
Bearer / `x-api-key` values, embedded credential strings) at every outward
boundary: output, errors, diagnostics, quota failures, cached metadata, and
fatal shell errors.