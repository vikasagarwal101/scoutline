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
- Keep Z.AI-only command families (Reader, repository exploration, raw tools,
  Code Mode) accepting but ignoring Provider selection.
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

No release date is currently planned for the direct-transport replacement.
Until it ships, Scoutline continues to pin `mmx-cli@1.0.16` exactly and to
document the SDK as a transitional Implementation.

## Phase 4: Streaming Transport

### Streaming Output

Add `--stream` with newline-delimited JSON output for operations whose upstream transport can produce incremental data.

- Define event types for start, progress, data, warning, error, and complete.
- Keep the existing non-streaming response contract unchanged when `--stream` is absent.
- Begin with local progress and chunk emission where UTCP supports it; use a clear non-streaming fallback when an upstream tool cannot stream.
- Ensure logs and warnings stay on stderr so stdout remains machine-readable.

Acceptance: tests validate event ordering, valid JSONL framing, cancellation cleanup, and the fallback behavior.

## Deliberately Out of Scope

- Cache inspection and replay commands.
- Serving the CLI itself as an MCP server.
- Additional search source-quality controls beyond the existing filtering and merge behavior.
- Dynamic Provider loading, user-supplied Adapter files, or external Adapter packages.
- Cache path migration; legacy `zai-cli` keys remain readable but are never rewritten.
- Automatic Provider fallback or Provider inference from credentials.
- MiniMax Reader, repository exploration, raw tools, Code Mode, image diff, or video analysis.

These capabilities can be reconsidered only after the selected roadmap proves a concrete need for them.