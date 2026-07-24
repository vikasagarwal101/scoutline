# Product Roadmap

This roadmap contains the selected Scoutline capabilities and the Provider
boundary required to grow beyond the initial Z.AI Adapter. It is ordered by
shared foundations and implementation risk, not by release date.

## Product Principles

- Preserve the current data-only default and structured error contract.
- Keep normal commands deterministic wrappers around named operations; Code Mode remains the explicit escape hatch for arbitrary tool chains.
- Keep local artifacts, local context, and cached responses separate so users control what leaves their machine.
- Make every new operation testable without a live API where practical.
- Keep Provider Adapters behind a stable Scoutline command and Capability contract. Adding a Provider must never require changing command modules, Capability interfaces, normalized fixtures, or outward result shapes.

## Phase 0: Provider Boundary

Scoutline begins with the existing Z.AI Adapter and keeps its current internal API and configuration intact. New Providers must be introduced as Adapters, not as Provider-specific command forks.

- Qualify raw provider tools as `scoutline.<provider>.<service>.<tool>`; version 0.1 exposes Z.AI tools as `scoutline.zai.*`.
- Define provider-neutral command Capabilities for search, reading, repository exploration, and vision before adding a second Provider.
- Add explicit Provider selection and validation only when a second Adapter exists; do not add speculative configuration now.
- Preserve Z.AI endpoint and `Z_AI_*`/`ZAI_*` configuration behavior during the transition.

Acceptance: the current Z.AI Adapter is reachable through the `scoutline.zai.*` namespace and Provider-specific behavior remains covered by existing command tests.

## Phase 1: Provider Isolation Foundation

Add a second built-in Provider Adapter behind the same command surface, then
document and ship the base release.

- Introduce `src/providers/selection.ts` with explicit precedence
  (`--provider` > `SCOUTLINE_PROVIDER` > `zai`) and `VALIDATION_ERROR` for
  unknown values. Credentials never participate.
- Keep Z.AI-only command families (Reader, raw tools, Code Mode,
  repository exploration) accepting but ignoring Provider selection.
- Move Provider field mapping, media rules, credential resolution, and
  transport construction into per-Provider Adapter Modules. Commands consume
  only Capability interfaces.
- Ship the MiniMax Token Plan Adapter using `mmx-cli/sdk@1.0.16` as a
  transitional transport. Pin the SDK version exactly; the Adapter exposes
  only Search and general single-image Vision in the base release.
- Ship provider-partitioned cache keys (`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`)
  with legacy `zai-cli` keys preserved as Adapter-owned read-through
  candidates.
- Ship normalized `QuotaDashboard` (ADR-0001) and `DiagnosticsReport`
  schema-version-1 contracts. Provider-only fields must not cross either
  Interface.
- Ship the base-release documentation and packaging gate (GATE-4): update
  `README.md`, `docs/`, `skills/scoutline/`, `CHANGELOG.md`, the
  `prepublishOnly` script, and the tarball install test in
  `tests/package.test.js`.

Acceptance: the base release passes Phase 0 through Phase 4 offline gates, the
normalized quota and diagnostics contracts hold for both Providers, and
`npm pack --dry-run` includes the required compiled output while excluding
tests, fixtures, local planning artifacts, and credential-shaped files.

## Phase 2: MiniMax Specialized Vision (conformance-gated)

Enable MiniMax Vision operations beyond general single-image interpretation.

- Move specialized mappings (`ui-to-code`, `extract-text`, `diagnose-error`,
  `diagram`, `chart`) into the MiniMax Adapter one at a time.
- Each operation is gated by its offline and live attestation
  (`providers/minimax/vision-attestations.ts`). Support is enabled only when
  both states are `pass`, the implementation identity matches, and every
  assertion passed.
- Image diff and video remain out of scope.
- Update the Capability matrix and Capability metadata automatically from the
  compiled conformance entry; do not maintain a separate registry.

Acceptance: each specialized operation ships its own attestation; command
help, doctor, and runtime support reflect the compiled registry without a
separate flag.

## Phase 3: Direct MiniMax Transport

Replace the transitional `mmx-cli/sdk` transport with direct MiniMax
endpoint calls.

- Replace the SDK transport for Search and Vision. The narrow quota transport
  already lives in `providers/minimax/quota-client.ts`.
- Run the existing Search, Vision, quota, diagnostics, media, error, and live
  conformance suite under the direct Implementation.
- After parity, remove `mmx-cli` from `package.json` and the lockfile.
- Re-attest every enabled specialized Vision mapping under the
  direct-transport implementation identity.

Shipped in v0.6.0: the direct transport replaces the SDK on the runtime
path (`fetchMiniMaxSearch` / `fetchMiniMaxVlm`); `mmx-cli` moved to
`devDependencies` (retained for the live envelope-parity fixture). See
CHANGELOG [0.6.0].

## Current Release (P6): MiniMax Repository Isolation

P6 introduces the Provider-isolated Repository Capability architecture
described in `docs/plans/provider-isolation/DESIGN.md`. Repository
exploration now routes through Provider Adapters behind a shared
`executeRepositoryOperation` executor: Z.AI supplies a live Repository
Adapter (`src/providers/zai/repository.ts`), and the `repo` subcommands
participate in Provider selection. MiniMax does **not** supply a
Repository Adapter; explicit MiniMax selection of any `repo` subcommand
fails closed with `UNSUPPORTED_CAPABILITY` before any selected-Provider
work, with no implicit Z.AI fallback. The Phase 1 base-release wording
above is preserved as the historical record; this section captures the
P6 reality rather than rewriting it.

## Current Release (P7): Reader Provider Migration

P7 applies the same Capability-seam pattern P6 delivered for `repo` to the
Reader. `scoutline read` now participates in Provider selection. Z.AI
advertises the `reader` Capability and supplies it through a new Z.AI
Reader Adapter (`src/providers/zai/reader.ts`) routed through a shared
`executeReaderOperation` typed wrapper over `executeProviderOperation`.
MiniMax does **not** supply a Reader Adapter; explicit MiniMax selection
of `read` fails closed with `UNSUPPORTED_CAPABILITY` before any selected-
Provider work, with no implicit Z.AI fallback.

The migration is **breaking for `data`-mode consumers** (see CHANGELOG
v0.4.0): the v0.2 raw content string and bare extract array are replaced
with schema-version-1 envelopes (`{schemaVersion, url, finalUrl, title,
content, contentFormat, truncated, originalContentLength}` for content
reads and `{schemaVersion, url, finalUrl, mode, items, truncated,
originalItemCount}` for extract reads). URL rewrite is surfaced as
`finalUrl` instead of a stderr notice; `--full-envelope` is silently
deprecated; `--max-chars` is ignored on extract reads. The four
`--extract` modes and their item shapes are unchanged. Reader has no
Explorer module (a single fetch does not need one) — projection lives in
the thin `commands/read.ts` handler. The shared encoded-MCP error
classifier factored out of `repository.ts` in P6 is reused by the Reader
Adapter, so all P6-04A/B/C corrections apply for free. The Phase 1
"keep Reader accepting but ignoring Provider selection" wording above is
preserved as the historical record; this section captures the P7 reality.

## Current Release (P8): Cache Module Unification

P8 unifies the response cache and the tool-discovery cache under one
on-disk root and one environment-variable policy. The previously
separate `~/.cache/zai-cli/responses` (XDG-flavoured) and the
`ZAI_MCP_TOOL_CACHE*` / `ZAI_MCP_CACHE_DIR` env surface are replaced by
`~/.scoutline/{cache,tools}/` and `SCOUTLINE_CACHE*`. Old env vars
remain as silent lower-precedence aliases; old directories are
orphaned (not migrated, not deleted). Call-time env reads replace
module-load capture so per-suite mutations remain observable.

Operator surface additions:

- `scoutline cache stats` — inventory both subdirectories.
- `scoutline cache clear` — delete every file under `<root>/cache/`
  and `<root>/tools/` (the directory shells are preserved).
- `scoutline doctor` — embeds a one-line cache summary in its
  `DiagnosticsReport` under `cache.summary`. The summary is formatted
  by the dispatcher from `cacheStats()` output; the report builder
  only embeds it (L1 fix).

Internal boundaries:

- `src/lib/cache.ts` owns the unified root resolver, the env policy,
  the response cache I/O, the LRU eviction loop (scans `cache/` only),
  and the inventory / clear helpers (`cacheStats`, `clearAllCaches`).
- `src/lib/tool-cache.ts` owns the tool-discovery cache I/O against
  the `tools/` sibling. Consumed by `ZaiMcpClient`; extracted from the
  client in Ticket 02 of this release.
- `src/commands/cache.ts` is the presentation-only handler for
  `cache stats` / `cache clear`.

The "cache inspection commands" entry below has been moved out of the
deliberately-out-of-scope list to reflect the new reality; cache
**replay** commands remain out of scope.

## Current Release: Brave Provider

Brave ships as the fourth built-in Provider. New module
`src/providers/brave/` with the direct-HTTP Adapter (auth via the
`X-Subscription-Token` header); credential `BRAVE_SEARCH_API_KEY`
(whitespace-only = absent; missing → `CONFIGURATION_ERROR`, exit 3).
The production registry at `src/providers/registry.ts` grows from
`[zai, minimax, tavily]` to `[zai, minimax, tavily, brave]`.

Brave's confirmed Capabilities:

- **Search** — default → web search; `--topic news` → dedicated news
  endpoint; `--type video` → videos endpoint (**Brave is the only
  Provider that advertises `--type video`**, mutually exclusive with
  `--topic`); `--content-size high` → LLM Context endpoint (extracted
  passages joined into summaries). `--domain` → `site:`, `--recency` →
  `freshness`, `--location` → `country`. `--count` is client-side.
- **Quota** — Brave has no `/usage` endpoint. Quota is read from
  `X-RateLimit-*` response headers on a 1-query probe and surfaces the
  monthly rate-limit window (the per-second window is dropped). A
  prominent caveat warns this is a rate-limit window, **not** spend or
  credits consumed (Brave uses metered billing).
- **Diagnostics** — 1-query web-search probe; unconfigured Brave is
  listed but skipped.

Brave does **not** supply Reader, Crawl, Map, Research, or Vision;
selecting Brave for any of those returns `UNSUPPORTED_CAPABILITY` with
no fallback. Operational note: Brave recently shifted from a pure free
tier to $5 monthly metered credits (a saved card is now billable).

## Phase 4: Streaming Transport

### Streaming Output

Add `--stream` with newline-delimited JSON output for operations whose upstream transport can produce incremental data.

- Define event types for start, progress, data, warning, error, and complete.
- Keep the existing non-streaming response contract unchanged when `--stream` is absent.
- Begin with local progress and chunk emission where UTCP supports it; use a clear non-streaming fallback when an upstream tool cannot stream.
- Ensure logs and warnings stay on stderr so stdout remains machine-readable.

Acceptance: tests validate event ordering, valid JSONL framing, cancellation cleanup, and the fallback behavior.

## Deliberately Out of Scope

- Cache replay commands (`cache stats` and `cache clear` shipped in P8;
  replay remains out of scope).
- Serving the CLI itself as an MCP server.
- Additional search source-quality controls beyond the existing filtering and merge behavior.
- Dynamic Provider loading, user-supplied Adapter files, or external Adapter packages.
- Migration of the orphaned legacy `~/.cache/zai-cli/` directory; entries
  there are never rewritten, migrated, or deleted.
- Automatic Provider fallback or Provider inference from credentials.
- MiniMax raw tools, Code Mode, image diff, video analysis, or
  repository exploration.
- MiniMax Reader Adapter, removing the deprecated `--full-envelope` flag,
  and a future `--max-items` truncation policy for extract reads.
- A deprecation notice for the legacy `ZAI_CACHE*` / `ZAI_MCP_TOOL_CACHE*`
  / `ZAI_MCP_CACHE_DIR` aliases (deferred to a future release).
- A `cache prune` subcommand (future enhancement; P8 ships `stats` and
  `clear` only).

These capabilities can be reconsidered only after the selected roadmap proves a concrete need for them.