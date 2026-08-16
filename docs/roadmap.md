# Product Roadmap

This doc is **forward-looking only**: it holds product principles, candidate
features, and explicit exclusions. Completed work is not tracked here —
`CHANGELOG.md` is the durable record of what shipped. Candidates marked
"seed" carry their verified facts, scope, and decision gates in
`docs/plans/v2/`; a seed graduates to a plan (PRD/DESIGN/TASKS, cf.
`docs/plans/provider-isolation/`) when picked up.

Ordering principle: contract-free local features first; contract-extending
features next; features that reverse a written decision (ADR) last.

## Product Principles

- Preserve the data-only default stdout and the structured JSON error contract.
- Keep normal commands deterministic wrappers around named operations; Code Mode remains the explicit escape hatch for arbitrary tool chains.
- Keep local artifacts, local context, and cached responses separate so users control what leaves their machine.
- Make every new operation testable without a live API where practical.
- Keep provider adapters behind a stable Scoutline command and capability
  contract. Adding a provider must never require changing command modules,
  capability interfaces, normalized fixtures, or outward result shapes.

## Candidate Features

### Studied seeds — contract-free (pickup-ready)

- **`--save <path>` + `history`** (`docs/plans/v2/14-save-artifacts-and-history.md`)
  — durable explicit artifacts (redacted arguments, overwrite protection)
  outside the response cache, plus a metadata view. stdout, cache-key
  identity, and `config.json` schema all unaffected. Seeds the superset-vs-
  seed-07 (journal) decision gate. Effort: medium.

### Studied seeds — contract-extending

- **Consumption sink wiring + `usage` ledger**
  (`docs/plans/v2/02-consumption-wiring-and-usage.md`) — finish threading the
  consumption sink beyond vision-only, then add a retained ledger so "what
  did I spend yesterday?" is answerable. Reports call counts, not credits.
  Touches `state.json` schema.
- **`compare` command** (`docs/plans/v2/03-compare-command.md`) —
  *shelved (product decision 2026-08-15)*: superseded by multi-provider
  fan-out ([ADR-0004](adr/0004-multi-provider-search-fanout.md),
  accepted and implemented — see `CHANGELOG.md` "0.16.0"); the
  plan's arm-execution design transferred.
- **Local context refinement** (`docs/plans/v2/13-local-context-refinement.md`)
  — `--context <file>` / `--context-stdin` refine research/search from a
  local file parsed entirely client-side; only `{path, sha256}` recorded,
  never contents. Additive envelope fields; `--context=bias` fragments the
  cache key via the wire `query` (documented in `--help`). Effort: medium.
- **`batch` manifest runner** (`docs/plans/v2/15-batch-manifest-runner.md`)
  — versioned JSON manifest of CLI operations with bounded concurrency,
  per-operation results, `--fail-fast`, and dry-run; `vision batch` builds
  on the runner. One new stable v1 summary envelope. Effort: medium.
- **`--stream` streaming output** (`docs/plans/v2/17-streaming-output.md`)
  — JSONL event stream (start/progress/data/warning/error/complete) on
  stdout; non-streaming contract unchanged when absent. Jina DeepSearch's
  SSE parser is the in-codebase transport precedent; `--stream` stays out
  of the cache key like `--output-format`. Effort: medium.

### Studied seeds — ADR-gated (start with a superseding ADR, not code)

- **`serve` — MCP server mode** (`docs/plans/v2/12-mcp-server-mode.md`) —
  expose the capability layer as MCP tools served by scoutline itself.
  Reverses the "serving the CLI itself as an MCP server" exclusion below.

### Studied seeds — visionary

- **`investigate` pipeline** (`docs/plans/v2/06-investigate-pipeline.md`) —
  local multi-step research: plan → fan-out search → read top hits →
  deterministic evidence extraction → `EvidencePack` envelope;
  agent-synthesis by default, `--synthesize` (Z.AI chat) as the escape hatch.
- **Research journal + provenance**
  (`docs/plans/v2/07-research-journal.md`) — append-only local research
  memory with provenance hashes; `journal recall` / `journal export`.
- **Temporal reading + Wayback adapter**
  (`docs/plans/v2/08-temporal-reading-wayback.md`) — `read --as-of <date>`,
  page diff over time, cache-pinned recency for `search --as-of`.
- **`watch` monitoring** (`docs/plans/v2/09-watch-monitoring.md`) — snapshot
  and diff URLs, site maps, or queries; cron-friendly exit codes.
- **`--budget-tokens` output compaction**
  (`docs/plans/v2/10-token-budget-output.md`) — context-aware, deterministic
  output sizing at the projection layer; citation-preserving priorities.
- **Selection strategies** (`docs/plans/v2/11-selection-strategies.md`) —
  `--strategy cheapest|freshest|diverse` extending the quota-aware ranking.

## Deferred Pending Work

### Cache-entry migration across credential sources (Fork-C)

When a user moves a credential between an environment variable and
`config.json` (or changes its value), the response-cache fingerprint
changes, so entries written under the old credential stop hitting on the
new one. Scoutline does **not** migrate, rewrite, or invalidate those
entries — they expire naturally (default 24h TTL) or are cleared manually
via `scoutline cache clear`. Reusing entries written under a previous
credential is deferred pending a concrete design; until then, `scoutline
cache clear` after a credential change is the documented recovery path.

## Deliberately Out of Scope

- **Cache replay commands** — rejected in the 2026-08-15 study as redundant:
  output-format flags are excluded from the cache key, so re-running with a
  different `--output-format` is already a network-free re-render.
  (`cache stats` and `cache clear` shipped.)
- **Offline mode (serve-from-cache-only)** — needs a new stable error code
  for cache-miss-under-offline while the cache is documented best-effort;
  weak foundation for an offline *promise*.
- **Local embeddings index** — needs an embedding dependency; revisit after
  the research journal (seed 07) exists.
- **`--fresh` / per-invocation `--cache-ttl`** — `--no-cache` already
  exists; marginal value does not justify new flag surface.
- **Serving the CLI itself as an MCP server** — reversal candidate: see
  ADR-gated seed 12.
- **Cross-provider result normalization / multi-provider fan-out beyond
  search** — the search-only reversal shipped ([ADR-0004](adr/0004-multi-provider-search-fanout.md)
  accepted, superseding ADR-0002 decision 6 for search; see
  `CHANGELOG.md` "0.16.0"). Reader, crawl, map, research, and vision
  remain strictly single-provider + fallback.
- **Additional search source-quality controls** beyond the existing
  filtering and merge behavior.
- **Dynamic provider loading, user-supplied adapter files, or external
  adapter packages.**
- **Migration of the orphaned legacy `~/.cache/zai-cli/` directory** —
  entries there are never rewritten, migrated, or deleted.
- **Provider inference from credentials** — provider selection stays
  explicit (`--provider`, `SCOUTLINE_PROVIDER`, the routing table, fallback).
  Provider fallback itself shipped (`--no-fallback` / `SCOUTLINE_NO_FALLBACK`
  to opt out); *inferring* a provider from ambient credentials remains
  excluded.
- **MiniMax raw tools, Code Mode, image diff, video analysis, or repository
  exploration.**
- **MiniMax Reader Adapter, removing the deprecated `--full-envelope` flag,
  and a `--max-items` truncation policy for extract reads.**
- **A deprecation notice for the legacy `ZAI_CACHE*` / `ZAI_MCP_TOOL_CACHE*` /
  `ZAI_MCP_CACHE_DIR` aliases** (deferred to a future release).

These capabilities can be reconsidered only after a concrete need is
proven; reversing a written decision starts with an ADR, following the
ADR-0002 precedent (provider fallback was once "deliberately out of scope"
too).
