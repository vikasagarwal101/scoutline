# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

_No published changes yet. See `docs/plans/` for in-flight work._

## [0.4.0] - 2026-07-20

### Added
- Provider-selected Reader Capability. `scoutline read` participates in the
  existing Provider selection order (explicit `--provider`, then
  `SCOUTLINE_PROVIDER`, then default `zai`). The Z.AI descriptor advertises
  the `reader` Capability and the Z.AI Reader Adapter
  (`src/providers/zai/reader.ts`) supplies it through a typed
  `executeReaderOperation` wrapper over `executeProviderOperation`
  (`src/lib/execution.ts`). MiniMax does not advertise the Capability;
  selecting MiniMax (explicitly or via the environment) for `read` returns
  `UNSUPPORTED_CAPABILITY` before descriptor configuration, Adapter creation,
  credential resolution for use, cache identity, or transport construction,
  with no implicit Z.AI fallback.
- Schema-version-1 Reader result envelopes. Content reads return
  `{schemaVersion, url, finalUrl, title, content, contentFormat, truncated,
  originalContentLength}` (with optional `metadata` and `external` when the
  Provider returns them). Extract reads (`--extract code|links|tables|
  headings`) return `{schemaVersion, url, finalUrl, mode, items, truncated,
  originalItemCount}`. The four extract modes and their item shapes are
  unchanged from v0.2; only the outer envelope is new. The total decoder
  starts from `unknown`, rejects malformed values without throwing, and
  preserves `metadata`/`external` verbatim when present.
- URL rewrite observability. The Provider-side URL rewrite (today: gist
  URLs to their raw form) is recorded as the `finalUrl` field on every
  Reader envelope. The v0.2 stderr rewrite notice is removed; the signal
  now lives in the result. The rewrite is idempotent on URLs already
  ending in `/raw` and preserves fragments.
- Reader cache namespace
  `v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json`,
  where the credential hash is the full lowercase SHA-256 hex digest of
  the Adapter-resolved credential and is never re-hashed by cache code.
  The canonical request URL is the **rewritten** URL so two requests that
  normalize to the same fetched URL (e.g. `gist.github.com/<id>` and
  `gist.github.com/<id>/raw`) share one cache entry. Legacy v0.2 Z.AI
  cache entries remain readable **read-only** — their key is reconstructed
  from the same Adapter-resolved credential using the exact v0.2 args-
  order algorithm (the Adapter never sends `no_cache`, so `--no-cache`
  entries written by v0.2 — if any — are intentionally unreconstructible;
  the contract requires `--no-cache` to perform no reads or writes).
  `--no-cache` performs no reads or writes. Injected credentials drive the
  fingerprint and legacy-key construction; ambient environment is never
  reread.
- Encoded MCP error taxonomy for Reader operations, recognized before
  success parsing through the shared `classifyEncodedMcpError` helper
  factored out of `repository.ts` in 0.3.0 (`src/providers/zai/encoded-error.ts`).
  Exhausted WebReader quota (code `1310` or explicit exhausted-limit
  meaning) surfaces as a normalized `QUOTA_ERROR` 429 and is terminal;
  transient 429/5xx and a malformed envelope retry once; auth 401/403 and
  other 4xx are terminal. Raw Provider body, reset metadata, and error-
  text strings are discarded. The P6-04A/B/C corrections (code 1310 wins
  regardless of status; "rate limited" excluded; "limit reached/exceeded"
  included; 403 → `AUTH_ERROR` status 403 exact; 5xx retryable) apply to
  Reader for free.
- Descriptor-derived `DiagnosticsReport` inventories extended to Reader.
  `reader` appears under `zaiOnlyCapabilities` while still participating
  in selection, and Doctor help names MiniMax as unsupported for `read`.
- A fake second Reader Adapter conformance suite under
  `tests/helpers/fake-adapter.js` and `tests/reader-conformance.test.js`
  that proves the seam without making MiniMax claim support. The fake
  Adapter is registered under the `"zai"` ID because production
  `parseProviderId` rejects unknowns — this proves the dispatcher branches
  on descriptor metadata and Adapter handles, never on Provider ID itself.
  The matrix asserts byte-identical public stdout across content × extract
  × {data, json, pretty, compact}.

### Changed
- **`scoutline read` data-mode success payloads are intentionally
  breaking.** This release replaces the v0.2 raw content string for
  content reads and the bare JSON array for extract reads with the
  schema-version-1 contract. The migration table:

  | Read shape | v0.2 (legacy, now obsolete) | v1 (current) |
  | --- | --- | --- |
  | Content read (default) | Raw content string | `{schemaVersion, url, finalUrl, title, content, contentFormat, truncated, originalContentLength}` |
  | Extract read (`--extract <mode>`) | Bare JSON array of items | `{schemaVersion, url, finalUrl, mode, items, truncated, originalItemCount}` |

  Any consumer that did `scoutline read URL > file.md`, `scoutline read
  URL | jq -r .content`, or `scoutline read URL --extract code | jq -c .[]`
  against v0.2 output must switch to the v1 envelope.
- Output modes for `read` results are intentionally asymmetric with `repo`
  because Reader content is naturally prose:
  - `data` emits the schema-version-1 envelope object (content or extract).
  - `json` and `pretty` emit the standard `{success, data, timestamp}`
    envelope (indent 0 for `json`, indent 2 for `pretty`).
  - Text-oriented modes (`compact`, `markdown`, `refs`, `tty`) emit the
    `content` string directly for **content reads** (prose presentation);
    they fall back to the JSON envelope for **extract reads** because
    extracted items are data, not prose. (`repo` always supplies JSON
    fallback because every `repo` result is structured data.)
- The v0.2 URL rewrite **stderr notice is removed**. The same signal now
  lives on the `finalUrl` field of every Reader envelope. Scripts that
  parsed the stderr notice must read `finalUrl` from the v1 result.
- The `--full-envelope` flag is **silently deprecated**. It is still
  accepted for compatibility but has no effect and emits no warning: the
  envelope is always returned at v1. The deferred decision to add a
  one-time deprecation notice in a future release is recorded in the
  reader-migration-core-flows artifact.
- `--max-chars` is **ignored on extract reads.** Content reads truncate
  the envelope's `content` (set `truncated: true` and preserve
  `originalContentLength`); extract reads report `originalItemCount`
  instead because truncating a code block or link list mid-item would be
  harmful. `--max-chars` never invokes a model — it is post-normalization
  projection only.
- The static `commands/read.ts` Module is now a thin read handler: parse-
  level validation (URL scheme, `--extract` mode), `executeReaderOperation`
  invocation, schema-v1 envelope projection (`--max-chars` content
  truncation, `--extract` slicing), and output-mode presentation. Provider
  selection (explicit `--provider`, `SCOUTLINE_PROVIDER`, default Z.AI),
  the capability support gate, the configured-but-unconfigured check, and
  Adapter creation live in `src/index.ts`. Direct `ZaiMcpClient`
  construction/close, raw WebReader name resolution, URL rewrite, response
  parsing, cache/retry policy, and close lifecycle have moved to the Z.AI
  Reader Adapter. Reader has no Explorer module — a single fetch does not
  need one; projection lives in the thin handler.
- `ZaiMcpClient.webRead` TypeScript return type widened from `Promise<string>`
  to `Promise<ReaderRawResponse>` (`ReaderRawObjectResponse | string`). The
  characterization probe proved the runtime shape was always the union;
  the v0.2 type was a lie. The package's `main` entry is the CLI dispatcher
  and does not re-export `ZaiMcpClient` or `webRead`, so external consumers
  are unaffected unless they deep-import `scoutline/dist/lib/mcp-client.js`
  (a discouraged pattern). Internal callers were migrated: the Reader
  Adapter uses `callToolRaw` directly and `commands/tools.ts` uses
  `callToolRaw`; zero `.webRead(` call sites remain in `src/`. The
  `webRead` wrapper itself stays on `ZaiMcpClient` for raw-tool callers
  (`scoutline.zai.reader.webReader` via `tools` / `tool` / `call`).
- The shared encoded-MCP error classifier (`src/providers/zai/encoded-error.ts`)
  introduced in 0.3.0 is reused by the Reader Adapter. The Reader migration
  consumed the P6-04A/B/C corrections for free with zero changes to the
  classifier; `repository.ts` and `reader.ts` share one helper.

### Out of scope (not added)
- MiniMax Reader Adapter implementation. MiniMax still does not advertise
  `reader`; an explicit MiniMax `read` fails closed with
  `UNSUPPORTED_CAPABILITY`.
- mmx-cli/sdk replacement (still pinned to `1.0.16` for the MiniMax
  Search/Vision transport).
- Removing the deprecated `--full-envelope` flag.
- Future `--max-items` truncation policy for extract reads.
- Automatic summarization or an implicit `--summarize` mode.
- Reopening P5 specialized Vision attestation state.

## [0.3.0] - 2026-07-20

### Added
- Provider-neutral repository exploration. `scoutline repo search`,
  `scoutline repo read`, and `scoutline repo tree` participate in the
  existing Provider selection order (explicit `--provider`, then
  `SCOUTLINE_PROVIDER`, then default `zai`). The Z.AI descriptor
  advertises the `repository-exploration` Capability and the Z.AI
  Repository Adapter supplies it through a Provider-neutral Explorer
  (`src/commands/repository-explorer.ts`) plus shared
  `executeRepositoryOperation` (`src/lib/execution.ts`). MiniMax does not
  advertise the Capability; selecting MiniMax (explicitly or via the
  environment) returns `UNSUPPORTED_CAPABILITY` before descriptor
  configuration, Adapter creation, credential resolution for use, cache
  identity, or transport construction, with no implicit Z.AI fallback.
- Schema-version-1 structured `repo` successes (`RepositorySearchResult`,
  `RepositoryFileResult`, `RepositoryTreeResult`) with strict request
  defaults: Search carries `language: "en" | "zh"`, Directory root is
  `path: ""`, File paths are non-root, repeated and trailing `/`
  collapse, leading `./` is normalized on File, and actual `.`/`..`
  segments, backslashes, and ASCII control characters are rejected.
  Provider sibling order and Search excerpt order are preserved.
- Deterministic, local `--max-chars` projection. `--max-chars` never
  invokes a model. Absent, zero, or negative means no truncation.
  `repo search` applies one total budget across `excerpts[].text` in
  Provider order, truncates the final retained excerpt with the existing
  ellipsis rule, and omits later excerpts. `repo read` truncates only
  `content` and preserves `originalContentLength`. `repo tree` is never
  character-limited. The flag is post-normalization projection — it
  never enters the Provider request or cache identity.
- Repository cache namespace
  `v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json`,
  where the credential hash is the full lowercase SHA-256 hex digest of
  the Adapter-resolved credential and is never re-hashed by cache code.
  Legacy v0.2 Z.AI cache entries remain readable **read-only** — their
  key is reconstructed from the same Adapter-resolved credential using
  the exact v0.2 algorithm, and a valid hit is written through to the
  new key without rewriting, migrating, or deleting the legacy file.
  `--no-cache` performs no reads or writes. Injected credentials drive
  the fingerprint and legacy-key construction; ambient environment is
  never reread.
- Encoded MCP error taxonomy for repository operations, recognized
  before success parsing. Exhausted ZRead quota (code `1310` or explicit
  exhausted-limit meaning) surfaces as a normalized `QUOTA_ERROR` 429
  and is terminal. Transient 429 / 5xx and a malformed envelope retry
  once. Auth 401/403 and other 4xx are terminal. Raw Provider body,
  reset metadata, and error-text are discarded.
- Best-effort per-attempt transport close. Each `operation.invoke`
  creates a fresh ZRead client with internal cache and retry disabled
  and best-effort closes it once in `finally`, bounded by the existing
  2000 ms semantic. Close rejection or timeout never replaces a
  successful result or masks a primary failure. Cache hits construct
  and close no transport.
- Descriptor-derived `DiagnosticsReport` inventories. `sharedCapabilities`
  is the intersection across built-in Provider capabilities; `zaiOnlyCapabilities`
  is Z.AI support minus the union of every other built-in Provider.
  `repository-exploration` therefore appears under Z.AI-only while still
  participating in selection, and Doctor help names MiniMax as
  unsupported for `repo`.
- A fake second Repository Adapter conformance suite under
  `tests/helpers/fake-adapter.js` and `tests/repository-conformance.test.js`
  that proves the seam without making MiniMax claim support, plus an
  integrated legacy-cache, retry, transport, close, selection, and
  credential-clean test matrix.

### Changed
- **`scoutline repo` data-mode success payloads are intentionally
  breaking.** This release replaces the v0.2 raw-string Search/File
  returns and the depth-dependent raw Tree/deep-snapshot shape with the
  schema-version-1 contract. Any consumer parsing the v0.2 raw text or
  the v0.2 split-depth Tree shape must switch to the v1 fields. The
  raw `scoutline.zai.*` namespace remains available for callers that
  need the legacy grammar; it is not wrapped in the v1 envelope.
- Output modes for `repo` results:
  - `data` emits the raw schema-version-1 value as plain JSON (no envelope).
  - `json` and `pretty` emit the standard `{success, data, timestamp}`
    envelope (indent 0 for `json`, indent 2 for `pretty`).
  - Text-oriented modes (`compact`, `markdown`, `refs`, `tty`) receive
    the JSON fallback — the same value as `data` mode — because `repo`
    supplies no per-mode prose presentation override.
  Root Tree path is `""` and Tree is structured at every depth
  including depth 1.
- Search default `language` is `"en"`; pass `--language zh` for Chinese.
  File paths must be non-root; canonical paths normalize leading and
  trailing separators, collapse repeated `/`, and reject actual `.`/
  `..`, backslashes, and ASCII controls. Percent escapes are never
  decoded — they remain literal characters in the canonical path.
- The static `commands/repo.ts` Module is now a thin command routing
  layer: parse-level validation, dispatch table, Explorer invocation,
  and `CommandResult` wrapping. Provider selection (explicit
  `--provider`, `SCOUTLINE_PROVIDER`, default Z.AI), the capability
  support gate, the configured-but-unconfigured check, and Adapter
  creation live in `src/index.ts`. Direct `ZReadMcpClient`
  construction/close, raw ZRead name resolution, response parsing,
  cache/retry policy, and close lifecycle have moved to the
  Provider-neutral Explorer, shared execution, and the Z.AI Repository
  Adapter.
- Specialized MiniMax Vision mappings remain independent and conformance-
  gated; they are not claimed complete by this release. The conformance
  registry, attestation workflow, fallback behavior, and the `vision.diff`
  / `vision.video` Z.AI-only scope are unchanged.

### Out of scope (not added)
- MiniMax repository implementation.
- Reader migration.
- Automatic summarization or an implicit `--summarize` mode.
- Dynamic Provider loading or external Adapter packages.
- Implicit Z.AI fallback for an unsupported Provider.
- Reopening P5 specialized Vision attestation state.

## [0.2.0] - 2026-07-18

### Added
- Provider selection (`--provider <zai|minimax>` / `SCOUTLINE_PROVIDER` /
  default `zai`) for shared capabilities: `search`, `vision analyze`,
  `quota`, `doctor`. Unknown or empty values fail with `VALIDATION_ERROR`
  before any Provider invocation; credentials never participate in selection.
- MiniMax Token Plan Provider Adapter. Supports Search, general single-image
  Vision (`vision analyze`), normalized quota, and Provider diagnostics.
  Implemented on top of the transitional `mmx-cli/sdk@1.0.16` for Search and
  Vision, with a narrow Adapter-local transport for quota. Configured via
  `MINIMAX_API_KEY`, `MINIMAX_REGION` (`global` default, `cn`), and an
  optional `MINIMAX_BASE_URL` HTTPS override.
- `quota` command returns a schema-version-1 normalized `QuotaDashboard`
  (ADR-0001). Default mode reports the effective Provider; `--all-providers`
  queries every configured Provider in registry order with settled
  collection, preserves successful entries, and exits 1 when any Provider
  fails.
- `doctor` command returns a schema-version-1 `DiagnosticsReport` listing
  every built-in Provider with its configured state, declared Capabilities,
  and probe status. Probes every configured Provider unless `--no-tools` is
  supplied. Z.AI connectivity uses MCP tool discovery; MiniMax connectivity
  uses a raw single-attempt quota probe.
- Provider-partitioned cache keys (`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`).
  Legacy `zai-cli` cache entries remain readable for Z.AI as Adapter-owned
  candidates; old entries are never migrated or deleted.
- Recursive, case-insensitive credential redaction at every outward
  boundary: output, errors, diagnostics, quota failures, cached metadata,
  and fatal shell errors. Covers `Z_AI_API_KEY`, `ZAI_API_KEY`,
  `MINIMAX_API_KEY`, Bearer / `x-api-key` values, and embedded credential
  strings.
- Specialized MiniMax Vision conformance registry and attestation workflow.
  Five operations (`ui-artifact`, `extract-text`, `diagnose-error`,
  `diagram`, `chart`) have dedicated prompt-composition modules with
  offline-conformance fixtures, generated SHA-256 mapping revisions, and a
  per-operation live attestation script. Two operations (`ui-artifact`,
  `diagnose-error`) are live-attested and enabled at runtime; the remaining
  three are offline-pass but pending live conformance.

### Fixed
- Raw Provider response bodies no longer leak to public error output.
  Adapter error normalization, MCP init paths, and Code Mode init paths
  now surface clean typed messages while preserving error codes and status
  for retry classification.
- `ZAI_API_KEY` alias fully honored by the Z.AI adapter (was only accepted
  by `lib/config.ts`; the adapter read `Z_AI_API_KEY` exclusively).
- Provider selection default (`zai`) no longer consults credentials or
  descriptors (FR-003 compliance). The "is configured?" check moved to
  the dispatch layer.
- Missing credentials throw `ConfigurationError` (exit 3) instead of
  `AuthError` (exit 1). `AuthError` is reserved for Provider-rejected
  credentials (401/403).
- Retry classification corrected: HTTP 404 is terminal (was retried as
  500); unexpected-system errors map to positive 500 (was negative -500,
  which escaped retry).
- Injected `MainDependencies.env` credentials properly redacted (was
  reading ambient `process.env` only).
- Invalid `--count` values rejected with `VALIDATION_ERROR` before provider
  resolution or credential checks. `--count` without a value is an error.
  Uses `Number.isSafeInteger`.
- Offline test suite makes zero network calls regardless of ambient
  credentials (NFR-001 compliance).
- Pre-invocation errors (invalid provider, invalid output mode) respect
  the requested output format.
- `TimeoutError` preserves original duration when rewrapped by adapters.

### Changed
- Quota output is now a schema-version-1 normalized `QuotaDashboard`
  (ADR-0001). Provider-specific quota fields (Z.AI `usageDetails`,
  `nextResetTime` shape; MiniMax `model_remains`, `end_time`,
  `weekly_end_time`) no longer cross the Interface. The previous
  Z.AI-specific quota payload is replaced — this is a deliberate
  machine-readable compatibility change. See `docs/adr/0001-normalize-provider-quota-output.md`.
- Z.AI Search public tool names resolve through `scoutline.zai.*` and use the
  Adapter's name-translation fix; the previous UTCP internal sanitized names
  (`web_search_prime` and similar) are reachable only via the raw
  `scoutline call` flow.

## [0.1.0] - 2026-07-16

### Added
- Scoutline CLI for visual media, web, and repository source investigation.
- Provider-qualified Z.AI raw-tool namespace: `scoutline.zai.*`.