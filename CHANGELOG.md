# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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