# Architecture

Scoutline is a Node.js command-line client that presents several shared
Capabilities through one consistent interface. It supports Z.AI and a
MiniMax Token Plan Provider through a common Adapter boundary.

## Runtime Flow

```text
scoutline executable
  -> dist/index.js command dispatcher
  -> command handler
  -> Provider selection (--provider / SCOUTLINE_PROVIDER / default "zai")
  -> Provider Adapter (zai or minimax)
  -> shared execution (cache + retry)
  -> Provider transport (Z.AI MCP / mmx-cli transitional SDK / MiniMax direct quota)
  -> Provider service (Z.AI, ZRead, or MiniMax)
```

`packages/scoutline/bin/scoutline.js` is the published executable. It dynamically loads the compiled `dist/index.js` entry point and emits a structured load error if the package was not built.

`packages/scoutline/src/index.ts` owns global option parsing, output-mode selection, help/version output, Provider selection for shared capabilities, and dispatch for each top-level command. Command-specific validation and presentation live in `src/commands/`.

## Provider Boundary

A **Provider Descriptor** is a static, pure metadata object: it advertises its
ID, declares whether it is configured for an environment, lists its
Capabilities, and constructs an Adapter bound to a Provider context. It does
not touch credentials, transports, or I/O.

A **Provider Adapter** is the runtime object a Capability talks to. It owns
credentials, transport lifecycle, Provider field mapping, and failure
normalization. It never imports command presentation, output mode, or another
Provider's Adapter.

The production registry at `src/providers/registry.ts` is a static, two-entry
list `[zai, minimax]`. There is no dynamic loading, no package-name lookup,
no Adapter file paths, and no externally supplied factories. Tests inject
descriptor lists explicitly through optional parameters.

### Built-in Providers

| ID | Required credential | Region / endpoint | Notes |
| --- | --- | --- | --- |
| `zai` | `Z_AI_API_KEY` | `Z_AI_BASE_URL` / `Z_AI_MODE` | Default Provider |
| `minimax` | `MINIMAX_API_KEY` | `MINIMAX_REGION` (`global` / `cn`) or `MINIMAX_BASE_URL` | Transitional `mmx-cli/sdk@1.0.16` for Search and Vision; direct quota transport |

Each Adapter exposes only the Capabilities the base release actually supports.
The Descriptor advertises the same Capability set so support can be checked
without constructing the Adapter.

### MiniMax transitional SDK

The initial MiniMax Adapter uses `mmx-cli/sdk` (pinned to `1.0.16`) as a
replaceable transport for Search and Vision. Only
`src/providers/minimax/sdk-client.ts` imports the SDK directly. Quota uses a
narrow Adapter-local transport against
`<baseUrl>/v1/api/openplatform/coding_plan/remains` because the pinned SDK
does not preserve an arbitrary configured quota host. Replacing the SDK
transport with a direct MiniMax endpoint implementation requires no change
outside the MiniMax Adapter and its transport tests.

## Shared Capabilities

Provider selection applies only to Search, Vision, quota, and diagnostics.
Reader, repository exploration, raw tools, and Code Mode are Z.AI-only and
ignore both the explicit flag and the environment variable.

| Capability | Z.AI | MiniMax | Command |
| --- | --- | --- | --- |
| `search` | Yes | Yes | `scoutline search` |
| `vision.interpret-image` | Yes | Yes | `scoutline vision analyze` |
| Specialized Vision operations | Yes | No | `scoutline vision ui-to-code`, `extract-text`, `diagnose-error`, `diagram`, `chart` |
| Image diff / video | Yes | No | `scoutline vision diff`, `vision video` |
| `quota` | Yes | Yes | `scoutline quota` |
| `diagnostics` | Yes | Yes | `scoutline doctor` |
| Reader | Yes | No | `scoutline read` |
| Repository exploration | Yes | No | `scoutline repo ...` |
| Raw tools | Yes | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | `scoutline code ...` |

Specialized MiniMax Vision mappings remain conformance-gated and only move
into the shared matrix once their offline and live attestation passes.

### Capability contracts

Every Capability is a deep module: the Capability contract lives under
`src/capabilities/`, the Provider mapping lives under
`src/providers/<provider>/`, and the shared execution and retry policy live
under `src/lib/execution.ts`. Commands consume Capability interfaces and
inject Adapters — they never read Provider fields directly.

### Search

Both Adapters return `SearchSource[]` (`title`, `url`, `summary`, optional
`source`, optional `date`). Shared command meaning — query splitting, parallel
scheduling, dedupe, ranking, summary truncation, field projection, and
presentation — is identical for both Providers. Result count is applied
locally after normalization and never enters an Adapter request or cache key.

Z.AI accepts domain, recency, content-size, and location controls. MiniMax
rejects every one of those controls with `UNSUPPORTED_OPTION` before SDK
access.

### Vision

General single-image interpretation maps to `vision.interpret-image` on both
Providers. Provider media Modules own every Provider-specific fact: format,
size limit, existence, and conversion.

| Provider | Formats | Maximum |
| --- | --- | --- |
| Z.AI | JPG, JPEG, PNG | 5 MiB |
| MiniMax | JPG, JPEG, PNG, WebP | 50 MiB |

Vision results never use the response cache. Shared execution owns the retry
policy; each Vision attempt is uncached and uncacheable.

### Quota

Both Providers expose a normalized `QuotaDashboard` (ADR-0001). Provider-only
fields do not cross the Interface. Percentages are remaining percentages
clamped to `0..100`. Each Adapter maps its Provider response into named
quota categories (`requests`, `tokens`, or per-model names) with current and
optional weekly windows, optional counts, remaining percentage, and reset
time.

`quota` reports the effective Provider by default. `quota --all-providers`
queries every configured Provider in registry order using settled
collection: a single Provider failure preserves the successful entries and
yields exit 1.

### Diagnostics

`doctor` always lists every built-in Provider with its configured state,
declared Capabilities, and probe status. It probes every configured Provider
unless `--no-tools` is supplied. Missing non-effective credentials are
skipped; a missing effective Provider credential fails the report.

Under `--no-tools` the report contains metadata only. Configured entries are
`skipped` with reason `tools-disabled`; unconfigured entries are `skipped`
with reason `not-configured`. No Adapter or transport is constructed.

Z.AI connectivity uses MCP tool discovery. MiniMax connectivity uses a raw
single-attempt quota probe that authenticates without a generative request.

## Command Layer

| Module | Responsibility |
| --- | --- |
| `commands/vision.ts` | Eight vision operations with shared client lifecycle management. |
| `commands/search.ts` | Search filtering, formatting, and multi-query result merging. |
| `commands/read.ts` | URL validation, gist raw-URL rewriting, extraction, and truncation. |
| `commands/repo.ts` | ZRead search, tree, and file operations. |
| `commands/tools.ts` | MCP tool discovery, schema lookup, and raw calls. |
| `commands/code.ts` | TypeScript tool chaining through UTCP Code Mode. |
| `commands/doctor.ts`, `commands/quota.ts` | Provider-aware diagnostics and quota dashboard. |

Each command is responsible for input validation, silencing dependency logs,
producing the final response, and closing its client in a `finally` block.

## Shared Runtime Behavior

`src/lib/mcp-client.ts` is the main Z.AI integration boundary. It initializes UTCP once per client, registers MCP services, resolves tool names, normalizes failures into CLI error classes, and closes transports.

- Retriable failures use bounded exponential backoff with jitter. Retrying closes the current client before trying again.
- Search/read/ZRead calls use the response cache unless `--no-cache` is supplied. Vision calls are never cached.
- Multi-query search creates one client per concurrent query because UTCP clients are not concurrency-safe for parallel calls.
- Tool discovery has a separate cache from normal response caching.

`src/lib/cache.ts` exposes a provider-partitioned cache key
(`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`) used by
shared execution. Legacy `zai-cli` cache keys remain readable for Z.AI as
Adapter-owned candidates; old entries are never migrated or deleted.

`src/lib/output.ts` owns the output contract. Commands should send successful values through `outputSuccess`; failures are serialized by `formatErrorOutput` from `src/lib/errors.ts`.

## Boundaries

- The CLI does not own the web-search, reader, ZRead, vision, or quota implementations; it adapts their transport contracts.
- The disk cache stores raw upstream responses before truncation, extraction, or output formatting. Presentation flags therefore do not produce separate response-cache entries.
- Code Mode is an explicit advanced execution path. Normal commands should remain predictable wrappers around named operations.
- Provider field names never appear in public output. Raw quota fields do not cross the normalized Interface; raw Search fields are mapped to `SearchSource` before any command code observes them.