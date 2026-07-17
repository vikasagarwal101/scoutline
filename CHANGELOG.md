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