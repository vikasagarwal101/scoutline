# Product Roadmap

This roadmap contains the selected Scoutline capabilities and the provider boundary required to grow beyond its current Z.AI adapter. It is ordered by shared foundations and implementation risk, not by release date.

## Product Principles

- Preserve the current data-only default and structured error contract.
- Keep normal commands deterministic wrappers around named operations; Code Mode remains the explicit escape hatch for arbitrary tool chains.
- Keep local artifacts, local context, and cached responses separate so users control what leaves their machine.
- Make every new operation testable without a live API where practical.
- Keep provider adapters behind a stable Scoutline command and tool contract.

## Phase 0: Provider Boundary

Scoutline begins with the existing Z.AI adapter and keeps its current internal API and configuration intact. New providers must be introduced as adapters, not as provider-specific command forks.

- Qualify raw provider tools as `scoutline.<provider>.<service>.<tool>`; version 0.1 exposes Z.AI tools as `scoutline.zai.*`.
- Define provider-neutral command capabilities for search, reading, repository exploration, and vision before adding a second provider.
- Add explicit provider selection and validation only when a second adapter exists; do not add speculative configuration now.
- Preserve Z.AI endpoint and `Z_AI_*`/`ZAI_*` configuration behavior during the transition.

Acceptance: the current Z.AI adapter is reachable through the `scoutline.zai.*` namespace and provider-specific behavior remains covered by existing command tests.

## Phase 1: Research Workflow

### Research Command

Add `scoutline research <query>` as a first-class composition of the existing search and reader commands.

- Search for a query, choose a bounded set of results, fetch each page, and emit a cited source bundle.
- Support domain, recency, source-count, reader-format, extraction, and output-format controls.
- Produce deterministic Markdown and JSON output containing source URL, title, fetch status, extracted content, and citations. Do not present unsourced generated claims as research results.
- Reuse the existing MCP client, response cache, URL validation, extraction, and output contracts.

Acceptance: an offline unit test covers source selection and rendering; a mocked integration test proves search-to-read orchestration and failure isolation.

### Local Context

Add `research --context <file>` and `--context-stdin` to refine source selection and output organization from local Markdown or text.

- Parse context locally and derive query terms, sections, or user questions before making remote calls.
- Enforce explicit size limits and clear errors for unreadable or binary files.
- Record only the context file path and content hash in saved metadata by default, never its contents.
- Do not silently transmit the local file to an external service.

Acceptance: context influences client-side ranking and grouping in tests while the outbound MCP request contains only the selected search query.

## Phase 2: Durable Artifacts and Batch Work

### Result Persistence

Add `--save <path>` to supported commands and a local `history` command for saved artifact metadata.

- Save an explicit artifact rather than exposing implementation cache entries.
- Include schema version, CLI version, timestamp, command arguments with secrets redacted, output format, and result payload.
- Support Markdown and JSON artifacts; refuse accidental overwrite unless `--force` is given.
- Keep artifacts outside the response-cache directory by default.

Acceptance: tests verify redaction, deterministic metadata shape, overwrite protection, and round-trip reading of saved JSON.

### Batch Execution

Add `scoutline batch <manifest>` for repeatable groups of supported CLI operations.

- Define a versioned JSON manifest with named operations, arguments, output locations, and dependency-free bounded concurrency.
- Return one structured result per operation and continue after independent failures unless `--fail-fast` is supplied.
- Reuse command-level validators and client methods rather than shelling out to the executable.
- Support a dry-run mode that validates the manifest without network requests.

Acceptance: tests cover manifest validation, concurrency limits, partial failures, dry runs, and saved per-operation artifacts.

### Vision Batch

Build `vision batch` on the generic batch runner rather than a separate scheduler.

- Accept an explicit manifest and optionally a file glob; require an output directory for multi-item runs.
- Apply one named vision operation and prompt template per input.
- Bound concurrency conservatively because each operation starts or uses an MCP transport and can be expensive.
- Save machine-readable per-input outcomes and a concise summary report.

Acceptance: mocked vision tests cover glob expansion, rejected files, concurrency, output naming, and partial failure behavior.

## Phase 3: Repository Briefing

### Repository Brief

Add `scoutline repo brief <owner/repo>` for a deterministic initial repository orientation.

- Combine the existing ZRead tree, targeted search, and file-read primitives.
- Report repository structure, detected documentation and entry points, selected files, and the evidence URL/path for every conclusion.
- Provide `--path`, `--depth`, `--focus`, and `--max-chars` controls to keep results bounded.
- Avoid unsupported claims about architecture; show the source files that support each summary item.

Acceptance: fixture-based tests verify stable output, bounded reads, path filtering, and evidence links.

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

These capabilities can be reconsidered only after the selected roadmap proves a concrete need for them.
