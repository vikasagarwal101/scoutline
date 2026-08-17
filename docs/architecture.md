# Architecture

Scoutline is a Node.js command-line client that presents several shared
Capabilities through one consistent interface. It supports nine Providers —
Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, and
Jina AI — through a common Adapter boundary.

## Runtime Flow

```text
scoutline executable
  -> dist/index.js command dispatcher
  -> command handler
  -> Provider selection (--provider / SCOUTLINE_PROVIDER / default "zai")
  -> Provider Adapter (zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, or jina)
  -> shared execution (cache + retry)
  -> Provider transport (Z.AI MCP / MiniMax direct HTTP / Tavily direct HTTP / Exa direct HTTP / Brave direct HTTP / Firecrawl direct HTTP / Parallel direct HTTP / Perplexity direct HTTP / Jina direct HTTP)
  -> Provider service (Z.AI, ZRead, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, or Jina AI)
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

The production registry at `src/providers/registry.ts` is a static,
nine-entry list `[zai, minimax, tavily, exa, brave, firecrawl, parallel,
perplexity, jina]`. There is no dynamic loading, no package-name lookup,
no Adapter file paths, and no externally supplied factories. Tests
inject descriptor lists explicitly through optional parameters.

### Built-in Providers

| ID | Required credential | Region / endpoint | Notes |
| --- | --- | --- | --- |
| `zai` | `Z_AI_API_KEY` | `Z_AI_BASE_URL` / `Z_AI_MODE` | Default Provider; MCP-backed transport |
| `minimax` | `MINIMAX_API_KEY` | `MINIMAX_REGION` (`global` / `cn`) or `MINIMAX_BASE_URL` | Direct transport for Search, Vision, Quota; SDK removed in 0.6.0 |
| `tavily` | `TAVILY_API_KEY` | `https://api.tavily.com` | Direct-HTTP transport; Search, Reader, Crawl, Map, Research, Quota, Diagnostics |
| `exa` | `EXA_API_KEY` | `https://api.exa.ai` | Direct-HTTP transport; Search (web only), Reader (per-URL), Research (Exa Agent), Diagnostics. No Crawl/Map/Quota/Vision |
| `brave` | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com` | Direct-HTTP transport (`X-Subscription-Token`); Search (web/news/video + `--content-size high` → LLM Context), Quota, Diagnostics. No Reader/Crawl/Map/Research/Vision |
| `firecrawl` | `FIRECRAWL_API_KEY` | `https://api.firecrawl.dev` (v2) | Direct-HTTP transport; Search, Reader, Crawl (async), Map, Quota (credits), Diagnostics. Credit-based; no Research (`/deep-research` deprecated) |
| `parallel` | `PARALLEL_API_KEY` | `https://api.parallel.ai` | Direct-HTTP transport; Search, Research, Reader, Diagnostics |
| `perplexity` | `PERPLEXITY_API_KEY` | `https://api.perplexity.ai` | Direct-HTTP transport; Search (`/search`), Research (`/chat/completions` sonar-deep-research), Diagnostics |
| `jina` | `JINA_API_KEY` (optional, keyless supported) | `https://r.jina.ai`, `https://s.jina.ai`, `https://deepsearch.jina.ai` | Direct-HTTP transport; Search, Reader, Research, Quota (rate-limit telemetry), Diagnostics |

Each Adapter exposes only the Capabilities the base release actually supports.
The Descriptor advertises the same Capability set so support can be checked
without constructing the Adapter.

### MiniMax direct transport

The MiniMax Adapter uses a direct HTTP transport for Search, Vision, and
Quota. The transport implementation lives in
`src/providers/minimax/coding-plan-client.ts`. Quota probes a narrow
Adapter-local endpoint (`<baseUrl>/v1/api/openplatform/coding_plan/remains`)
to report plan usage. The earlier `mmx-cli/sdk` dependency was removed in
0.6.0 — the direct transport requires no SDK and is the sole runtime path
for every MiniMax capability.

## Shared Capabilities

Provider selection applies to Search, Vision, quota, diagnostics,
**repository exploration**, **Reader**, **Crawl**, **Map**, and
**Research**. Raw tools and Code Mode are Z.AI-only and ignore both
the explicit flag and the environment variable. Provider fallback
is **always-on** (0.11.0+): when the selected provider does not
supply the capability or fails at runtime, scoutline silently tries
the next eligible provider in registry order and emits a stderr
notice on every switch. `--no-fallback` (or
`SCOUTLINE_NO_FALLBACK=1`) restores the previous strict
single-provider behavior; see
[`docs/adr/0002-provider-fallback.md`](adr/0002-provider-fallback.md)
for the rationale and the accepted async double-charge risk.

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina AI | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `search` | Yes | Yes | Yes | Yes | Yes (web/news/video; `--content-size high` → LLM Context) | Yes | Yes | Yes | Yes | `scoutline search` |
| `vision.interpret-image` | Yes | Yes | No | No | No | No | No | No | No | `scoutline vision analyze` |
| Specialized Vision operations | Yes | 4 of 5 (`ui-to-code`, `extract-text`, `diagnose-error`, `diagram` live-attested; `chart` pending) | No | No | No | No | No | No | No | `scoutline vision ui-to-code`, `extract-text`, `diagnose-error`, `diagram`, `chart` |
| Image diff / video | Yes | No | No | No | No | No | No | No | No | `scoutline vision diff`, `vision video` |
| `quota` | Yes | Yes | Yes | No (deferred) | Yes (rate-limit window, not spend) | Yes (credits) | No | No | Yes (rate-limit telemetry, not spend) | `scoutline quota` |
| `diagnostics` | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | `scoutline doctor` |
| Reader | Yes | Falls back (zai/tavily/exa/firecrawl/parallel/jina) | Yes (Z.AI-only options are rejected) | Yes (rejects Z.AI-only options) | Falls back (zai/tavily/exa/firecrawl/parallel/jina) | Yes (returns page titles) | Yes | Falls back (zai/tavily/exa/firecrawl/parallel/jina) | Yes | `scoutline read` |
| Repository exploration | Yes | Falls back (zai) | Falls back (zai) | Falls back (zai) | Falls back (zai) | Falls back (zai) | Falls back (zai) | Falls back (zai) | Falls back (zai) | `scoutline repo ...` |
| Crawl | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Yes | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Yes (async; resumable after Ctrl-C) | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | `scoutline crawl` |
| Map | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Yes | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Yes | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | Falls back (tavily/firecrawl) | `scoutline map` |
| Research | Falls back (tavily/exa/parallel/perplexity/jina) | Falls back (tavily/exa/parallel/perplexity/jina) | Yes (4-250 credits per request) | Yes | Falls back (tavily/exa/parallel/perplexity/jina) | Falls back (tavily/exa/parallel/perplexity/jina) (`/deep-research` deprecated) | Yes | Yes | Yes | `scoutline research` |
| Raw tools | Yes | No | No | No | No | No | No | No | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | No | No | No | No | No | No | No | `scoutline code ...` |

Specialized MiniMax Vision mappings remain conformance-gated and only move
into the shared matrix once their offline and live attestation passes.

### Capability contracts

Every Capability is a deep module: the Capability contract lives under
`src/capabilities/`, the Provider mapping lives under
`src/providers/<provider>/`, and the shared execution and retry policy live
under `src/lib/execution.ts`. Commands consume Capability interfaces and
inject Adapters — they never read Provider fields directly.

### Search

Every search Adapter returns the same normalized `SearchSource[]`
(`title`, `url`, `summary`, optional `source`, optional `date`). Shared
command meaning — query splitting, parallel scheduling, dedupe, ranking,
summary truncation, field projection, and presentation — is identical
for every Provider. Result count is applied locally after normalization
and never enters an Adapter request or cache key.

`--topic <general|news|finance>` is the only search control every
Provider advertises. For Providers that lack a native topic parameter,
the Adapter appends a small keyword to the query string inside
`invoke()` (see `lib/search-topic.ts`); Tavily passes `topic` through to
its API unchanged, Exa maps it to a category, Firecrawl maps `news` to a
news source type, and Brave routes `news` to a dedicated endpoint. All
other controls are per-Adapter: an unsupported control is rejected with
`UNSUPPORTED_OPTION` before any transport access, which is also what
lets provider fallback retry the option on the next candidate. The
current control matrix:

- Z.AI — domain, recency, content-size (`high` → `content_size`),
  location, topic.
- MiniMax — topic only; every other control is rejected.
- Tavily — domain, recency, content-size (`high` →
  `search_depth=advanced`), topic; `location` is rejected.
- Exa — domain, recency, content-size, topic.
- Brave — domain (→ `site:`), recency (→ `freshness`), location
  (→ `country`), content-size (`high` → the LLM Context endpoint),
  topic; Brave is the only Provider that advertises `--type video`
  (mutually exclusive with `--topic`).
- Firecrawl — domain, recency, content-size (`high` returns scraped
  markdown summaries at +1 credit/result), topic.
- Parallel — domain, recency, location, content-size (forwarded through
  `advanced_settings`; location accepts `us` only); topic via keyword.
- Perplexity — domain, recency, content-size (`high` →
  `search_context_size`); topic via keyword; `location` is rejected.
- Jina — domain (→ `X-Site`) and location (→ `gl`); recency,
  content-size, and type are rejected; topic via keyword.

**Multi-provider fan-out** (ADR-0004, search only): one query may
execute in parallel across several providers — arms. Activation, in
precedence order: an explicit multi-pin (`--provider a,b` or
`--provider all`, which expands to every configured search provider in
registry order); an explicit single `--provider id` or
`SCOUTLINE_PROVIDER` pin (fan-out is ignored, with a stderr notice when
the switch is on); the `fanout` config key (`config set fanout
true|false`, default false — its arms are the `routing.search` list when
set, else every configured search provider); otherwise today's
single-provider selection. Each arm is pinned to its provider and owns
its transport (one client per arm; no per-arm fallback chain), reusing
the same parallel `executeSearch` pattern as `--merge` sub-queries and
the same provider-partitioned cache keys. Arm results are merged by
canonical URL identity (scheme/host lowercased, default ports,
fragments, trailing slashes, `utm_*`/`fbclid` stripped — identity only;
the emitted URL, title, and summary stay the first arm's originals),
ranked by occurrence count across all arms with arm-order tiebreak, and
sliced to `--count` after the merge; each result carries an additive
`mergedFrom` provenance list. An arm that rejects a search control drops
with a stderr notice naming the control; as long as one arm succeeds the
invocation exits 0 with the merged output. N arms = N billable calls,
stated in `config set fanout` and `--help`; the default is off. The
single-pin path is byte-identical to the pre-fan-out behavior (pinned by
golden tests).

**Local context derivation** (`--context <path>` / `--context-stdin`,
search only): the handler reads a local notes file (max 256 KiB,
NUL-byte binary detection) before dispatch and derives up to 8
sub-queries from its headings and questions (deterministic parser in
`lib/context-file.ts`). The user's positional query is always kept and
runs first; the joined stream is pipe-escaped and auto-enables the
`--merge` path, so the single-pin and fan-out plans both see one merged
query (`--merge` + a context flag is a `VALIDATION_ERROR` — both fight
over the same query string). Boundary: the derived sub-query strings are
what leaves the machine (they become the search queries); the file
itself never transmits. JSON data modes wrap the result array in a
`context` object of derived counts plus a SHA-256 — metadata only, never
content — while text modes stay unwrapped, and without the flag output
is byte-identical. Under fan-out every arm runs every sub-query; one
stderr notice states the N sub-queries × M arms billable math before
dispatch.

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

Each Provider exposes a normalized `QuotaDashboard` (ADR-0001). Provider-only
fields do not cross the Interface. Percentages are remaining percentages
clamped to `0..100`. Each Adapter maps its Provider response into named
quota categories (`requests`, `tokens`, or per-model names) with current and
optional weekly windows, optional counts, remaining percentage, and reset
time. Brave has no spend endpoint: its quota is read from
`X-RateLimit-*` response headers on a 1-query probe and surfaces the
monthly rate-limit window. A prominent caveat warns that this is a
rate-limit window, **not** spend or credits consumed — Brave uses metered
billing, so it is not a budget signal.

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
Tavily connectivity uses a raw single-attempt quota probe against the
Tavily account endpoint that authenticates without a generative request.
Brave connectivity uses a single-query web-search probe. Unconfigured
Providers (including Brave) are listed but skipped.

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

`scoutline repo brief` composes the same three operations — tree, search,
and read — into one schema-version-1 `RepositoryBrief` envelope with
focus-gated sections (`tree`/`docs`/`entryPoints`/`files`), an always-present
`coverage` probe record, and tree-derived `detected` signals.

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

The `DiagnosticsReport` (`schemaVersion: 2`) carries a
`capabilityMatrix` derived purely from descriptor metadata. For each
advertised capability, the matrix lists exactly which built-in
Providers supply it. Capabilities supplied by multiple Providers (every
capability except `repository-exploration`) are visible per-Provider,
not collapsed. Capabilities supplied by exactly one Provider
(`repository-exploration`, Z.AI only) are listed for that Provider
alone.

`sharedCapabilities` and `zaiOnlyCapabilities` are gone: their
two-array derivation silently hid any capability supplied by more than
one Provider. `deriveCapabilityMatrix` is the single inventory function;
its output is always strictly more informative than the previous
two-array view. Doctor help derives its unsupported-provider lists from
the same descriptor metadata (today: every Provider except Z.AI for
`repo`; every Provider except Tavily and Firecrawl for `crawl` and
`map`; Z.AI, MiniMax, Brave, and Firecrawl for `research`; MiniMax,
Brave, and Perplexity for `read`) — it reports
the effective Provider for shared capabilities and never widens to M3
transport.

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
  support truth. Six Providers advertise `reader` (Z.AI, Tavily, Exa,
  Firecrawl, Parallel, Jina); MiniMax, Brave, and Perplexity do not, and
  an explicit or environment-selected non-supplier returns
  `UNSUPPORTED_CAPABILITY` before
  `descriptor.isConfigured`, `descriptor.create`, credential resolution
  for use, cache identity, or transport construction. The Tavily, Exa,
  Firecrawl, and Parallel Adapters
  reject the Z.AI-only options (`--with-links`, `--no-gfm`,
  `--keep-img-data-url`, `--with-images-summary`) with
  `UNSUPPORTED_OPTION` when the user has explicitly set them to
  `true`; the Jina Adapter maps them to its native reader headers.
- **Descriptor/Adapter agreement is mandatory.** Every descriptor that
  advertises `reader` has an Adapter supplying `adapter.reader`; the
  MiniMax, Brave, and Perplexity descriptors advertise neither and
  their Adapters supply
  none. A future Provider that disagrees in either direction fails
  closed.
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

`capabilityMatrix` is derived purely from descriptor metadata. The
matrix lists the six `reader` suppliers (Z.AI, Tavily, Exa, Firecrawl,
Parallel, Jina); MiniMax, Brave, and Perplexity are absent because
their descriptors do not advertise it.

## Crawl, Map, Research Capabilities

`scoutline crawl`, `scoutline map`, and `scoutline research` participate
in Provider selection. Crawl and Map are supplied by Tavily and Firecrawl;
Research is supplied by Tavily, Exa, Parallel, Perplexity, and Jina
(Firecrawl's `/deep-research` is deprecated and Firecrawl does not
advertise Research). Provider fallback is **always-on** (0.11.0+):
selecting any non-supplier (explicitly or via `SCOUTLINE_PROVIDER`) for
any of the three emits a stderr notice and reroutes to the next
eligible provider in registry order. The descriptor's
`UNSUPPORTED_CAPABILITY` signal still surfaces under `--no-fallback`
before `descriptor.isConfigured`, `descriptor.create`, credential
resolution for use, cache identity, or transport construction —
matching the previous strict behavior. Firecrawl's crawl is
asynchronous (`/v2/crawl` create→poll→resume, with reclaim-on-miss for
cost-safety and a state file under `~/.scoutline/crawl/`); Tavily's is
synchronous. The flow below shows the Tavily (synchronous) path.

> **Accepted async risk:** for `crawl` / `map` / `research`, a runtime
> failure on the effective provider may fall back to another provider
> **even if the failed provider had already accepted or charged a job**.
> Providers (Firecrawl, Tavily, Exa) do not offer idempotency keys,
> pre-charge acknowledgements, or refunds for accepted-then-failed
> work. The double-charge risk is documented in
> [`docs/adr/0002-provider-fallback.md`](adr/0002-provider-fallback.md)
> and `docs/troubleshooting.md`. Pass `--no-fallback` (or set
> `SCOUTLINE_NO_FALLBACK=1`) to opt out and restore strict
> single-provider behavior.

```text
crawl argv + global flags
  -> parse-level validation (URL scheme)
  -> --provider / SCOUTLINE_PROVIDER / default zai
  -> descriptor capability check (crawl)
  -> descriptor.isConfigured (effective Provider)
  -> descriptor.create -> Tavily Adapter
       -> executeCrawlOperation (validate, identity, cache, retry, write)
            -> Tavily Crawl Adapter (depth/breadth/select-paths mapping)
            -> POST /crawl, normalized CrawlResult
       -> projection: per-page --max-chars truncation
  -> schema-version-1 CommandResult
```

Key boundaries:

- **Capability ownership.** Crawl and Map are advertised by the Tavily
  and Firecrawl descriptors; Research is advertised by Tavily, Exa,
  Parallel, Perplexity, and Jina (Firecrawl `/deep-research` is
  deprecated and Firecrawl does not advertise Research). The matching
  Adapter supplies the Capability implementation. The remaining
  descriptors (Z.AI, MiniMax, Brave — and Firecrawl for Research) do
  not advertise the capability; their Adapters supply nothing.
- **Map is the simplest of the three.** The Tavily `/map` endpoint
  returns a URL set with no per-page content, so the handler has no
  `--max-chars` projection. Crawl and Research are richer; the
  handler projects with `--max-chars` (Research: report text; Crawl:
  per-page content).
- **Research runs an async create→poll lifecycle server-side.** The
  Adapter's `invoke()` owns the full lifecycle, including
  resume-on-restart (see [Research state file](#research-state-file))
  and zero-retry on the cache-wrapped operation. The handler adds a
  polling timeout (default 300 s) and registers a SIGINT handler that
  prints the persisted `request_id` so the user can re-run the same
  command to resume. Tavily maps `--output-length`, `--citation-format`,
  and `--domain` natively; Exa Agent create accepts only `query` +
  `effort`, so those three options are warn-and-stripped before
  transport (so Provider fallback can still succeed via Exa).
- **Local context steering is handler-local by default.**
  `research --context <path> | --context-stdin
  [--context-mode organize|bias|both]` reads the source exactly once in
  the handler — before fallback dispatch, so a provider retry can never
  re-read a drained stdin — and parses it deterministically
  (`lib/context-file.ts`). The default `organize` mode re-presents the
  returned sections following the file's headings (exact-slug matching,
  provider order preserved, unmatched sections appended — never dropped)
  purely locally: the wire request and the provider-partitioned cache
  key are byte-identical to a no-context run (pinned by a golden).
  `bias`/`both` append a capped `(focus: ...)` term segment to the query
  before the request is built — the only context bytes that leave the
  machine — which intentionally fragments the cache key (a mode change
  is a new paid job) and is carried by the printed resume command
  (`--context-stdin` runs must re-pipe the same content unchanged).
  The envelope gains an optional `context` field (source, path, sha256,
  mode, derived counts) — metadata only, never content.

### Research state file

Research costs 4-250 credits per request. A research task runs
asynchronously server-side: `POST /research` creates the task and
returns a `request_id`; `GET /research/{id}` polls until completion.
If the CLI exits (Ctrl-C, crash) mid-poll, the task keeps running
and consuming credits. Without persistence, the next identical request
would POST a SECOND task — a double charge.

The Adapter persists `{ requestId, identityHash, createdAt, status }`
to `~/.scoutline/research/<state-hash>.json` so the next invocation
of the same request detects the in-flight task and polls it instead
of creating a new one. The state-hash is deterministic for a given
`{provider, capability, credentialFingerprint, request}` tuple (see
`lib/async-job-state.ts → computeAsyncJobStateHash`).

Resilience contract:

- `write()` uses `{ flag: "wx" }` for atomic creation. A concurrent
  invocation that finds the file already present gets EEXIST and
  polls the existing task instead of creating a new one.
- `read()` catches JSON parse errors, deletes the corrupt file, and
  returns `null` (treated as absent → new task created).
- `remove()` deletes the file and ignores ENOENT (already gone).
- Rotating the API key orphans old state files (correct — the old
  task belongs to the old key's billing). The hash never contains a
  raw credential.

## Command Layer

| Module | Responsibility |
| --- | --- |
| `commands/vision.ts` | Eight vision operations with shared client lifecycle management. |
| `commands/search.ts` | Search filtering, formatting, and multi-query result merging. Topic control is part of the shared search controls (`--topic <general\|news\|finance>`). |
| `commands/read.ts` | Thin read handler: parse-level validation (URL scheme, `--extract`), `executeReaderOperation` invocation, schema-v1 envelope projection (`--max-chars` content truncation, `--extract` slicing), output-mode presentation. Provider selection lives in `src/index.ts`. No Explorer module — Reader is a single fetch. |
| `commands/repo.ts` | Thin command routing: parse, dispatch table, Explorer invocation, output mode. Provider selection lives in `src/index.ts`. |
| `commands/repository-explorer.ts` | Provider-neutral Explorer: canonical paths, deterministic BFS, schema-v1 projection, local max-chars. |
| `commands/crawl.ts` | Thin crawl handler: parse-level URL validation, `executeCrawlOperation`, per-page `--max-chars` projection, schema-v1 envelope. |
| `commands/map.ts` | Thin map handler: parse-level URL validation, `executeMapOperation`, schema-v1 envelope (URLs only). |
| `commands/research.ts` | Research handler: SIGINT-registered polling loop, `--max-chars` projection on the report, resume-on-restart via `lib/async-job-state.ts`, schema-v1 envelope. |
| `commands/tools.ts` | MCP tool discovery, schema lookup, and raw calls. |
| `commands/code.ts` | TypeScript tool chaining through UTCP Code Mode. |
| `commands/doctor.ts`, `commands/quota.ts` | Provider-aware diagnostics and quota dashboard. |
| `commands/cache.ts` | Local cache inspection (`cache stats`) and clearing (`cache clear`). Presentation-only; I/O lives in `src/lib/cache.ts`. |

Each command is responsible for input validation, silencing dependency logs,
producing the final response, and closing its client in a `finally` block.
`commands/repo.ts`, `commands/read.ts`, `commands/crawl.ts`,
`commands/map.ts`, and `commands/research.ts` are all intentionally thin
— they own parse-level validation, request construction, and
`CommandResult` wrapping. None owns a concrete Provider client, raw MCP
name, response parser, BFS, cache or retry policy, transport
construction, or close lifecycle. Provider selection (explicit
`--provider`, `SCOUTLINE_PROVIDER`, default Z.AI), the capability
support gate, the configured-but-unconfigured check, and Adapter
creation live in `src/index.ts` (`handleRepository`, `handleRead`,
`handleCrawl`, `handleMap`, `handleResearch`). The concerns themselves
live under the Explorer (`commands/repository-explorer.ts`), the read
handler (`commands/read.ts`), the crawl/map/research handlers
(`commands/crawl.ts`, `commands/map.ts`, `commands/research.ts`),
`lib/execution.ts`, and the Provider Adapter Modules.

## Shared Runtime Behavior

`src/lib/mcp-client.ts` is the main Z.AI integration boundary. It initializes UTCP once per client, registers MCP services, resolves tool names, normalizes failures into CLI error classes, and closes transports.

- Retriable failures use bounded exponential backoff with jitter. Retrying closes the current client before trying again.
- Search/read/ZRead calls use the response cache unless `--no-cache` is supplied. Vision calls are never cached.
- Multi-query search creates one client per concurrent query because UTCP clients are not concurrency-safe for parallel calls.
- Tool discovery has a separate cache from normal response caching. Both caches share one on-disk root (`~/.scoutline/`) and one env-var policy; each owns its own subdirectory I/O (`cache/` for responses, `tools/` for tool discovery). Inspect or clear either via `scoutline cache stats` / `scoutline cache clear`.

`src/lib/cache.ts` exposes the unified on-disk cache root resolver
(`resolveCacheRootPure`), the call-time env-var aliasing policy, and a
provider-partitioned cache key
(`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`)
used by shared execution. Two sibling subdirectories live under one
root (`~/.scoutline/cache/` for responses, `~/.scoutline/tools/` for
tool discovery); each cache owns its own I/O, but the root resolver and
the env policy (`SCOUTLINE_CACHE*` with silent `ZAI_CACHE*`,
`ZAI_MCP_TOOL_CACHE*`, and `ZAI_MCP_CACHE_DIR` aliases) are shared.
Legacy `zai-cli` cache keys remain readable for Z.AI as Adapter-owned
candidates; old entries are never migrated or deleted.

`src/lib/tool-cache.ts` owns the tool-discovery cache I/O against the
`tools/` sibling. It is consumed by `ZaiMcpClient`; the response cache
never touches it. The LRU eviction loop in `src/lib/cache.ts` scans
`cache/` only and never deletes files under `tools/`.

`src/commands/cache.ts` is the presentation-only handler for
`scoutline cache stats` and `scoutline cache clear`. The handlers
receive already-resolved stats or clear results through injected
dependencies; the dispatcher (`src/index.ts`) wires them to the real
`cacheStats()` and `clearAllCaches()` from `src/lib/cache.ts`.

`src/lib/output.ts` owns the output contract. Commands send successful values through `formatSuccessOutput`; failures are serialized by `formatErrorOutput` from `src/lib/output.ts` (with a legacy compat re-export from `src/lib/errors.ts`).

### Consumption log seam (PB-T2)

`src/lib/consumption.ts` owns the typed `ConsumptionEvent` and the
`ConsumptionSink` abstraction. The shared execution primitive
(`executeProviderOperation` in `src/lib/execution.ts`) is the single
**when**: it emits one event per billable `invoke()` attempt — before
the call, so both success and a retrying failure count. Wrappers
(`executeSearch`, `executeRepositoryOperation`,
`executeReaderOperation`, `executeCachedOperation`) derive a
`ConsumptionContext` from the adapter-owned cache identity and pass it
through; cache-hit returns above the invoke path emit nothing because
the wrappers never call the retry loop. Observational handlers
(`scoutline quota`, `scoutline doctor`) call
`executeProviderOperation` directly without a consumption context, so
they emit nothing.

The amount is an explicit `exact`/`estimate`/`unknown` discriminated
value. Providers without per-call usage (Vision, Research, Crawl)
persist `unknown` rather than a fake-precise number; PB-T3 refines the
capability→category mapping.

`src/lib/quota-store.ts` gained `writeConsumption(providerId,
adjustment, at)` (PB-T2). The store advances `locallyUpdatedAt` and
adjusts the matching category's `current` window (subtracting from
`remaining`, adding to `used`, recomputing `remainingPercent`,
clamped at zero) when a finite amount is supplied and the category
exposes a count set; an absent matching category advances
`locallyUpdatedAt` only. `observedAt` (ground truth) is never moved.
Production wires `createQuotaStoreConsumptionSink({ store: quotaStore,
now, onWarning })`; tests inject `createInMemoryConsumptionSink()`.
The sink is awaited before the billable invoke returns outward — so
the write survives the bin's immediate `process.exit(status)`. A
write failure is converted to a redacted stderr warning inside the
sink and never reaches the retry classifier.

**Current wiring (0.14.x):** the seam is complete at the execution
layer, but only the `vision` handler currently forwards the sink into
its execution dependencies — `search`, `read`, `crawl`, `map`,
`research`, and `repo` invocations build their execution dependencies
without a consumption context, so those capabilities emit nothing today
(the wiring notes in `src/index.ts` flag this as later-ticket work).
Additionally, the sink mutates the provider's latest quota snapshot in
place; there is no append-only history, so `scoutline usage` reporting
requires new capture. Completing the handler wiring and adding a
retained ledger remain open follow-ups.

## Boundaries

- The CLI does not own the web-search, reader, ZRead, vision, quota, crawl, map, or research implementations; it adapts their transport contracts.
- The disk cache stores the normalized result of each operation (Search sources, File content, Directory listing, Reader content-read envelope, Crawl pages, Map URLs, Research report, Quota dashboard, etc.). Repository, Reader, Crawl, Map, and Research entries are normalized before the cache write; raw upstream responses never cross the Adapter boundary. Presentation flags therefore do not produce separate response-cache entries.
- Code Mode is an explicit advanced execution path. Normal commands should remain predictable wrappers around named operations.
- Provider field names never appear in public output. Raw quota fields do not cross the normalized Interface; raw Search fields are mapped to `SearchSource` before any command code observes them.