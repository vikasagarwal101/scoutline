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

Provider selection applies to Search, Vision, quota, diagnostics,
**repository exploration**, and **Reader**. Raw tools and Code Mode are
Z.AI-only and ignore both the explicit flag and the environment variable.

| Capability | Z.AI | MiniMax | Command |
| --- | --- | --- | --- |
| `search` | Yes | Yes | `scoutline search` |
| `vision.interpret-image` | Yes | Yes | `scoutline vision analyze` |
| Specialized Vision operations | Yes | No | `scoutline vision ui-to-code`, `extract-text`, `diagnose-error`, `diagram`, `chart` |
| Image diff / video | Yes | No | `scoutline vision diff`, `vision video` |
| `quota` | Yes | Yes | `scoutline quota` |
| `diagnostics` | Yes | Yes | `scoutline doctor` |
| Reader | Yes | No (UNSUPPORTED_CAPABILITY, no fallback) | `scoutline read` |
| Repository exploration | Yes | No (UNSUPPORTED_CAPABILITY, no fallback) | `scoutline repo ...` |
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

## Repository Exploration (P6)

`scoutline repo search`, `scoutline repo read`, and `scoutline repo tree`
participate in Provider selection. The runtime shape mirrors the Search
pipeline with a Provider-neutral Explorer:

```text
repo argv + global flags
  -> dispatch-level grammar validation
  -> --provider / SCOUTLINE_PROVIDER / default zai
  -> descriptor capability check (repository-exploration)
  -> descriptor.isConfigured (effective Provider)
  -> descriptor.create -> Adapter
  -> Provider-neutral Explorer (canonical paths, BFS, projection)
       -> executeRepositoryOperation (validate, identity, cache,
          legacy decode, retry, write, project)
            -> Z.AI Repository Adapter
            -> raw ZRead operation through resolved public/internal name
  -> schema-version-1 CommandResult
```

Key boundaries:

- **Selection happens before configuration.** Descriptor metadata is the
  support truth. MiniMax does not advertise `repository-exploration`; an
  explicit or environment-selected MiniMax returns `UNSUPPORTED_CAPABILITY`
  before `descriptor.isConfigured`, `descriptor.create`, credential
  resolution for use, cache identity, or transport construction.
- **Descriptor/Adapter agreement is mandatory.** The Z.AI descriptor
  advertises `repository-exploration` and the created Adapter supplies
  `adapter.repository`; the MiniMax descriptor advertises neither and the
  Adapter supplies none. A future Provider that disagrees in either
  direction fails closed.
- **Repository Explorer is Provider-neutral.** It imports only the
  normalized Repository Capability, shared execution, and normalized
  errors. It owns canonical paths, deterministic breadth-first traversal,
  deduplication, request-bound directory safety, and local `--max-chars`
  projection over the normalized result.
- **Adapter owns the transport.** The Z.AI Repository Adapter resolves its
  credential once, builds legacy keys from that same credential, invokes
  through resolved raw tool names, recognizes encoded MCP error envelopes
  before success parsing, and best-effort closes one constructed transport
  per attempt.
- **Shared execution owns ordering.** `executeRepositoryOperation` is
  generic over request and result but its ordering is fixed:
  `validate -> Adapter cache identity -> provider-partitioned cache read
  -> legacy candidate decode -> retry-wrapped invoke -> normalized cache
  write`. Each of the three operation kinds gets one retry (matching the
  current single-retry non-Vision policy). Cache hits construct and
  close no transport.
- **Explorer owns projection.** `executeRepositoryOperation` returns the
  full normalized result and performs no projection. The Explorer
  applies max-character projection afterward, in
  `commands/repository-explorer.ts`, before constructing the final
  `CommandResult`.

### Cache continuity

The repository namespace reuses `v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`
with a composite operation suffix composed at runtime as
`${identity.capability}-${identity.operation}` — namely
`repository-exploration-repository-search`,
`repository-exploration-repository-read-file`, and
`repository-exploration-repository-list-directory` — so identical
`{repository, path}` File and Directory requests cannot collide. Legacy
v0.2 Z.AI keys are reconstructed from the same Adapter-resolved
credential using the exact v0.2 algorithm; a valid hit is written
through to the new key and the legacy file is never migrated, rewritten,
or deleted. `--no-cache` performs no reads or writes.

### Encoded error taxonomy

Encoded MCP error strings and malformed ZRead wrappers are mapped
deterministically before success parsing:

| Provider condition | Public code | Status | Retry |
| --- | --- | --- | --- |
| Exhausted quota (`1310` or explicit exhausted limit) | `QUOTA_ERROR` | 429 | terminal |
| Transient 429 / "rate limited" | `API_ERROR` | 429 | one retry |
| Auth 401 / 403 | `AUTH_ERROR` | matching | terminal |
| Provider 5xx | `API_ERROR` | matching | one retry |
| Other 4xx (including 404) | `API_ERROR` | matching | terminal |
| Malformed envelope or success wrapper | `API_ERROR` | 502 | one retry |

The Adapter discards raw Provider bodies, reset metadata, error code text,
and message strings before any normalized result or error crosses the
public Interface.

### Diagnostics inventory

`sharedCapabilities` is the intersection across built-in descriptor
metadata (in first-descriptor declared order); `zaiOnlyCapabilities` is
Z.AI support minus the union of every other descriptor (in Z.AI declared
order). `repository-exploration` is therefore `zaiOnlyCapabilities` while
still participating in Provider selection. Doctor help explicitly names
MiniMax as unsupported for `repo`, reports the effective Provider for
shared capabilities, and never widens to M3 transport.

## Reader (P7)

`scoutline read` participates in Provider selection. The runtime shape
mirrors the shared pipeline with one intentional asymmetry from `repo`:
**there is no Explorer module.** Reader is a single URL fetch; projection
lives in the thin command handler (`commands/read.ts`) rather than in a
Provider-neutral Explorer.

```text
read argv + global flags
  -> parse-level grammar validation (URL scheme, --extract mode)
  -> --provider / SCOUTLINE_PROVIDER / default zai
  -> descriptor capability check (reader)
  -> descriptor.isConfigured (effective Provider)
  -> descriptor.create -> Adapter
  -> thin read handler (commands/read.ts)
       -> executeReaderOperation (validate, identity, cache,
          legacy decode, retry, write)
            -> Z.AI Reader Adapter (URL rewrite, encoded MCP errors,
               per-attempt transport)
            -> raw WebReader operation through resolved public name
       -> projection: --max-chars (content read only) / --extract <mode>
  -> schema-version-1 CommandResult (content-read or extract-read envelope)
```

Key boundaries:

- **Selection happens before configuration.** Descriptor metadata is the
  support truth. MiniMax does not advertise `reader`; an explicit or
  environment-selected MiniMax returns `UNSUPPORTED_CAPABILITY` before
  `descriptor.isConfigured`, `descriptor.create`, credential resolution
  for use, cache identity, or transport construction.
- **Descriptor/Adapter agreement is mandatory.** The Z.AI descriptor
  advertises `reader` and the created Adapter supplies `adapter.reader`;
  the MiniMax descriptor advertises neither and the Adapter supplies none.
- **No Explorer for Reader.** A single fetch does not need BFS, depth
  semantics, or canonical paths. The thin handler owns projection; the
  Adapter owns transport. This is the intentional asymmetry from `repo`.
- **Adapter owns URL rewrite and transport.** The Z.AI Reader Adapter
  rewrites `gist.github.com/<id>` to its raw form (idempotent on URLs
  already ending in `/raw`, fragments preserved), records the rewritten
  URL as `finalUrl`, resolves its credential once, invokes through
  resolved raw tool names, recognizes encoded MCP error envelopes before
  success parsing, and best-effort closes one constructed transport per
  attempt.
- **Shared execution owns ordering.** `executeReaderOperation` is the
  typed wrapper that composes `executeProviderOperation` (which still
  owns retry) with cache lookup and legacy read-through. The ordering is
  fixed: `validate -> Adapter cache identity -> provider-partitioned cache
  read -> legacy candidate decode -> retry-wrapped invoke -> normalized
  cache write`. A reader operation gets one retry (matching the current
  single-retry non-Vision policy). Cache hits construct and close no
  transport.
- **Handler owns projection.** `executeReaderOperation` returns the full
  normalized `ReaderFetchResult`. The handler projects it into the v1
  content-read envelope (with optional `--max-chars` truncation) or the
  extract-read envelope (with `--extract <mode>` slicing); extract reads
  are never character-truncated. The `--full-envelope` flag is silently
  accepted and ignored (D3).

### Cache continuity

The reader namespace reuses `v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`
with the composite operation suffix `${identity.capability}-${identity.operation}`
— namely `reader-reader-fetch`:

```text
v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json
```

The canonical request URL is the **rewritten** URL so two requests that
normalize to the same fetched URL share one cache entry. Legacy v0.2 Z.AI
keys are reconstructed from the same Adapter-resolved credential using the
exact v0.2 args-order algorithm (the Adapter never sends `no_cache`, so
legacy entries written under `--no-cache` in v0.2 — if any — are
intentionally unreconstructible; the contract requires `--no-cache` to
perform no reads or writes, so this is correct). A valid hit is written
through to the new key and the legacy file is never migrated, rewritten, or
deleted. `--no-cache` performs no reads or writes.

### Encoded error taxonomy

Encoded MCP error strings and malformed WebReader responses are mapped
deterministically before success parsing. The taxonomy matches `repo` and
shares the same factored classifier (`src/providers/zai/encoded-error.ts`):

| Provider condition | Public code | Status | Retry |
| --- | --- | --- | --- |
| Exhausted quota (`1310` or explicit exhausted limit) | `QUOTA_ERROR` | 429 | terminal |
| Transient 429 / "rate limited" | `API_ERROR` | 429 | one retry |
| Auth 401 / 403 | `AUTH_ERROR` | matching | terminal |
| Provider 5xx | `API_ERROR` | matching | one retry |
| Other 4xx (including 404) | `API_ERROR` | matching | terminal |
| Malformed envelope or empty content | `API_ERROR` | 502 | one retry |

The Adapter discards raw Provider bodies, reset metadata, error code text,
and message strings before any normalized result or error crosses the
public Interface.

### Diagnostics inventory

`sharedCapabilities` is the intersection across built-in descriptor
metadata; `zaiOnlyCapabilities` is Z.AI support minus the union of every
other descriptor. `reader` is therefore `zaiOnlyCapabilities` while still
participating in Provider selection. Doctor help explicitly names MiniMax
as unsupported for `read`.

## Command Layer

| Module | Responsibility |
| --- | --- |
| `commands/vision.ts` | Eight vision operations with shared client lifecycle management. |
| `commands/search.ts` | Search filtering, formatting, and multi-query result merging. |
| `commands/read.ts` | Thin read handler: parse-level validation (URL scheme, `--extract`), `executeReaderOperation` invocation, schema-v1 envelope projection (`--max-chars` content truncation, `--extract` slicing), output-mode presentation. Provider selection lives in `src/index.ts`. No Explorer module — Reader is a single fetch. |
| `commands/repo.ts` | Thin command routing: parse, dispatch table, Explorer invocation, output mode. Provider selection lives in `src/index.ts`. |
| `commands/repository-explorer.ts` | Provider-neutral Explorer: canonical paths, deterministic BFS, schema-v1 projection, local max-chars. |
| `commands/tools.ts` | MCP tool discovery, schema lookup, and raw calls. |
| `commands/code.ts` | TypeScript tool chaining through UTCP Code Mode. |
| `commands/doctor.ts`, `commands/quota.ts` | Provider-aware diagnostics and quota dashboard. |

Each command is responsible for input validation, silencing dependency logs,
producing the final response, and closing its client in a `finally` block.
`commands/repo.ts` and `commands/read.ts` are both intentionally thin — they
own parse-level validation, request construction, and `CommandResult`
wrapping. Neither owns a concrete Provider client, raw MCP name, response
parser, BFS, cache or retry policy, transport construction, or close
lifecycle. Provider selection (explicit `--provider`, `SCOUTLINE_PROVIDER`,
default Z.AI), the capability support gate, the configured-but-unconfigured
check, and Adapter creation live in `src/index.ts` (`handleRepository` and
`handleRead`). The concerns themselves live under the Explorer
(`commands/repository-explorer.ts`), the read handler
(`commands/read.ts`), `lib/execution.ts`, and the Provider Adapter Modules.

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

`src/lib/output.ts` owns the output contract. Commands send successful values through `formatSuccessOutput`; failures are serialized by `formatErrorOutput` from `src/lib/output.ts` (with a legacy compat re-export from `src/lib/errors.ts`).

## Boundaries

- The CLI does not own the web-search, reader, ZRead, vision, or quota implementations; it adapts their transport contracts.
- The disk cache stores the normalized result of each operation (Search sources, File content, Directory listing, Reader content-read envelope, Quota dashboard, etc.). Repository and Reader entries are normalized before the cache write; raw upstream ZRead/WebReader responses never cross the Adapter boundary. Presentation flags therefore do not produce separate response-cache entries.
- Code Mode is an explicit advanced execution path. Normal commands should remain predictable wrappers around named operations.
- Provider field names never appear in public output. Raw quota fields do not cross the normalized Interface; raw Search fields are mapped to `SearchSource` before any command code observes them.