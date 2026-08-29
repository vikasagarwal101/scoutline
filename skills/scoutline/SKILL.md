---
name: scoutline
description: |
  Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, Jina AI, You.com,
  Linkup, and Spider.cloud CLI
  providing:
  - Vision: image/video analysis, OCR, UI-to-code, error diagnosis (GLM-5V-Turbo)
  - Search: real-time web search with domain/recency/topic filtering
  - Reader: web page to markdown extraction (Z.AI, Tavily, Exa, Firecrawl, Parallel, Jina,
    You.com, Linkup, or Spider.cloud)
  - Crawl: multi-page website traversal (Tavily, Firecrawl, or Spider.cloud)
  - Map: URL-set discovery without fetching pages (Tavily, Firecrawl, or Spider.cloud)
  - Research: asynchronous deep research with citations (Tavily, Exa, Parallel, Perplexity, Jina,
    You.com, or Linkup)
  - Repo: GitHub code search and reading via ZRead (Z.AI)
  - Tools: MCP tool discovery, schemas, and raw calls (Z.AI)
  - Code: TypeScript tool chaining (Z.AI)
  - Provider selection: --provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider> for shared
    capabilities, repo, read, crawl, map, and research
  Use for visual content analysis, web search, page reading, multi-page
  site traversal, deep research, or GitHub exploration.
---

# Scoutline

Access Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, Jina AI, You.com,
Linkup, and Spider.cloud capabilities via `npx scoutline@0.18.1`. The
CLI is self-documenting — use `--help` at any level.

## Setup

```bash
# Z.AI (default Provider)
export Z_AI_API_KEY="your-api-key"

# OR MiniMax Token Plan
export MINIMAX_API_KEY="your-minimax-key"

# OR Tavily (Search, Reader, Crawl, Map, Research)
export TAVILY_API_KEY="your-tavily-key"

# OR Exa (Search, Reader, Research)
export EXA_API_KEY="your-exa-key"

# OR Brave (Search: web, news, video)
export BRAVE_SEARCH_API_KEY="your-brave-key"

# OR Firecrawl (Search, Reader, Crawl, Map)
export FIRECRAWL_API_KEY="your-firecrawl-key"

# OR Parallel AI (Search, Research, Reader)
export PARALLEL_API_KEY="your-parallel-key"

# OR Perplexity (Search, Research)
export PERPLEXITY_API_KEY="your-perplexity-key"

# OR Jina AI (Search, Reader, Research)
export JINA_API_KEY="your-jina-key"

# OR You.com (Search, Reader, Research)
export YDC_API_KEY="your-you-key"

# OR Linkup (Search, Reader, Research)
export LINKUP_API_KEY="your-linkup-key"

# OR Spider.cloud (Search, Reader, Crawl, Map)
export SPIDER_API_KEY="your-spider-key"
```

Get a Z.AI key at: https://z.ai/manage-apikey/apikey-list
Get a Tavily key at: https://app.tavily.com/home/api-keys
Get an Exa key at: https://dashboard.exa.ai

### Interactive onboarding (`scoutline init`)

Run `scoutline init` once to record API keys in
`~/.scoutline/config.json` (mode 0600) through an interactive wizard.
The wizard validates each key with a single inline probe, supports
re-config (edit/add/remove provider, change fallback, edit the
routing table), and repairs a
corrupt config (backup + rewrite). Non-interactive terminals are
refused — set environment variables instead.

### Settings via `scoutline config` (scriptable, no TTY)

```bash
npx scoutline@0.18.1 config get                        # full config, credentials always masked
npx scoutline@0.18.1 config set routing.search tavily,brave   # strict: typos FAIL, not drop
npx scoutline@0.18.1 config unset routing.search
npx scoutline@0.18.1 config set fallbackEnabled false
```

The `routing` key sets a standing per-capability provider preference:
with no `--provider` / `SCOUTLINE_PROVIDER` pin, the first
configured-and-capable provider in the list wins (over quota ranking).
Credential paths (`providers.<id>.apiKey`) refuse `set` — use `init`
or env vars; API keys never belong in command arguments.

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`),
**`repo`**, **`read`**, **`crawl`**, **`map`**, and **`research`**
accept the global `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider>` flag. Precedence
is the flag, then the `SCOUTLINE_PROVIDER` environment variable, then
the default `zai`. Provider selection is never inferred from
credentials. Unknown values fail fast with `VALIDATION_ERROR`.

`tools`, `tool`, `call`, and `code` accept the flag but ignore it; they
remain Z.AI-only.

Capability coverage at launch (generated from the production registry
in registry order `[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider]`):

- `search` — Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI,
  Perplexity, Jina AI, You.com, Linkup, and Spider.cloud. The only search
  control honored by every Provider
  is `--topic <general|news|finance>`.
  Brave is the only Provider that accepts `--type video`; every other
  Provider rejects `controls.type` as `UnsupportedOptionError` so
  option-level fallback continues to Brave.
- `vision.interpret-image` — Z.AI, MiniMax. Specialized Vision ops
  (`ui-artifact`, `extract-text`, `diagnose-error`, `diagram`, `chart`)
  follow the same registry and are mediated by MiniMax's compiled
  conformance registry.
- `quota` — Z.AI, MiniMax, Tavily, Firecrawl (credits), Brave
  (rate-limit window), Jina AI (rate-limit telemetry), Linkup and
  Spider.cloud (credit balance, limit unknown). Exa, Parallel AI,
  Perplexity, and You.com do not advertise quota.
- `diagnostics` — every built-in Provider (Z.AI, MiniMax, Tavily, Exa,
  Brave, Firecrawl, Parallel AI, Perplexity, Jina AI, You.com, Linkup,
  Spider.cloud).
- `read` — Z.AI, Tavily, Exa, Firecrawl, Parallel AI, Jina AI, You.com,
  Linkup, and Spider.cloud (MiniMax, Brave, and Perplexity do not
  advertise it; Tavily/Exa/Firecrawl/Parallel reject Z.AI-only reader
  options: `--with-links`, `--no-gfm`, `--keep-img-data-url`,
  `--with-images-summary`; Jina maps them natively; You.com mirrors the
  Exa rejection list and also rejects `--format text`; Linkup renders
  JavaScript by default and also rejects `--format text` and
  `--no-images`; Spider.cloud rejects the Z.AI-only options).
- `repo` — Z.AI only (repository-exploration is Z.AI-supplied).
- `crawl` — Tavily (sync), Firecrawl (async, resumable after Ctrl-C),
  Spider.cloud (sync).
- `map` — Tavily, Firecrawl, Spider.cloud.
- `research` — Tavily, Exa, Parallel AI, Perplexity, Jina AI, You.com, Linkup.
  Credit-intensive (4-250 credits). `--output-length`, `--citation-format`,
  and `--domain` are honored by Tavily; Exa warn-and-strips them (Agent
  create has no native fields).

Z.AI is the only Provider that supplies `repo search/read/tree` and the
Raw tools (`tools`, `tool`, `call`). Reader is supplied by Z.AI, Tavily,
Exa, Firecrawl, Parallel AI, Jina AI, You.com, Linkup, and Spider.cloud;
Crawl and Map by Tavily, Firecrawl, and Spider.cloud; Research by
Tavily, Exa, Parallel AI, Perplexity, Jina AI, You.com, and Linkup;
Vision by Z.AI and MiniMax only. **Provider
fallback is always-on by default**
(0.11.0+): selecting a non-supplier emits a stderr notice and silently
reroutes to the next eligible configured Provider in registry order
`[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider]`. Pass
`--no-fallback` (or set `SCOUTLINE_NO_FALLBACK=1`) to restore the
previous strict `UNSUPPORTED_CAPABILITY` behavior — the preflight
still runs capability metadata → configuration → adapter handle in
order on the effective Provider only.

### Search fan-out (multi-provider search, ADR-0004)

`search` alone can run one query across several providers in parallel
and merge the results (dedupe by canonical URL identity, occurrence
ranking, additive `mergedFrom` provenance per result; arms are pinned —
no per-arm fallback, and an arm that rejects a control drops with a
stderr notice instead of failing the invocation). Activation tiers:

1. `--provider tavily,exa` (comma list) or `--provider all` — fan-out
   now, on the listed providers (`all` = every configured search
   provider, registry order).
2. A single `--provider <id>` or `SCOUTLINE_PROVIDER` — single
   provider; fan-out is ignored.
3. `npx scoutline@0.16.0 config set fanout true` (no pin) — standing
   fan-out on `routing.search` when set, else all configured search
   providers. Default off; `config set fanout false` disables.
4. Otherwise the standard single-provider selection.

**Cost is explicit: every fanned-out search bills ALL arms — N arms = N
billable calls.** Use it when recall across providers matters more than
spend; use a single `--provider` pin when it does not.

### Local context (`--context` / `--context-stdin`)

`research` and `search` accept a local notes file (markdown headings +
question lines, max 256 KiB) to steer the run. Sources: `--context
<path>` or `--context-stdin` (pipe; the flags are mutually exclusive).

- `research ... --context notes.md` defaults to `--context-mode
  organize`: the returned report is re-presented following the file's
  headings, purely locally — the wire request and the cache key are
  unchanged. `bias`/`both` append a `(focus: ...)` term segment to the
  query; that segment is derived from the file and is what leaves your
  machine, and it changes the cache key (each mode is a separate paid
  job). The resume command carries the context flags; `--context-stdin`
  runs must re-pipe the same content unchanged.
- `search ... --context notes.md` derives up to 8 sub-queries from the
  file's headings and questions, keeps the original query first, and
  merges + dedupes the results. The derived sub-query strings become the
  search queries (the file itself never leaves the machine); under
  fan-out, N sub-queries × M arms = N×M billable searches. Mutually
  exclusive with `--merge`.
- Privacy: only the research focus segment and the search sub-query
  strings ever transmit. Outputs record counts, the source path, and a
  SHA-256 — never file content.

### Saved artifacts (`--save` + `history`)

Provider-backed commands accept `--save [<path>]` to keep a durable clean
report — content plus a request id, no provider/argv metadata inside — with
stdout unchanged. Masters live under `SCOUTLINE_ARTIFACTS_DIR` (default
`~/.scoutline/artifacts/`) beside an `index.json` metadata log; report
metadata (provider routing, redacted flags, versions) joins by request id.
`--save-format markdown` renders human-readable; overwriting an existing
export target requires `--save-force` (`FILE_ERROR` otherwise). Reports are
redacted through the same seam as stdout and never touched by cache
operations. `history list|show|stats` is the credential-free, fail-open
inventory over that log.

```bash
scoutline search "x" --save report.json --save-format markdown
scoutline history list --since 7 --command search
scoutline history show 20260829T142233Z-7f3a
```

## Capability Matrix

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina AI | You.com | Linkup | Spider.cloud | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search | Yes | Yes (no domain/recency/content-size/location) | Yes (no location) | Yes (no location) | Yes (web/news/video; `--content-size high` → LLM Context) | Yes (no location; `--content-size high` = markdown, +1 credit/result) | Yes (domain, recency, location, content-size via `advanced_settings`; topic via keyword) | Yes (domain, recency, content-size; topic via keyword) | Yes (domain, location; rejects recency/content-size; topic via keyword) | Yes | Yes | Yes | `scoutline search` |
| General single-image interpretation | Yes | Yes (JPG/JPEG/PNG/WebP ≤50 MiB) | No | No | No | No | No | No | No | No | No | No | `scoutline vision analyze` |
| Specialized Vision (UI-to-code, OCR, error diagnosis, diagram) | Yes | Available (live-attested; conformance-gated) | No | No | No | No | No | No | No | No | No | No | `scoutline vision ui-to-code`, `vision extract-text`, `vision diagnose-error`, `vision diagram` |
| Specialized Vision (chart) | Yes | Pending (implemented; fixture image defect blocks live conformance) | No | No | No | No | No | No | No | No | No | No | `scoutline vision chart` |
| Two-image diff, video | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline vision diff`, `vision video` |
| Quota (normalized) | Yes | Yes | Yes | **No** (deferred) | Yes (rate-limit window, not spend) | Yes (credits) | **No** | **No** | Yes (rate-limit telemetry, not spend) | **No** | Yes (credit balance, not spend) | Yes (credit balance, not spend) | `scoutline quota [--all-providers]` |
| Diagnostics | Yes | Yes | Yes | Yes | Yes | Yes (single-scrape probe) | Yes | Yes | Yes | Yes | Yes | Yes | `scoutline doctor [--no-tools]` |
| Reader | Yes | **No** (UNSUPPORTED_CAPABILITY) | Yes (rejects Z.AI-only options) | Yes (rejects Z.AI-only options) | **No** (UNSUPPORTED_CAPABILITY) | Yes (returns page titles) | Yes | **No** (UNSUPPORTED_CAPABILITY) | Yes | Yes (rejects Z.AI-only options plus `--format text`) | Yes (renders JavaScript; rejects `--format text` and `--no-images`) | Yes (rejects Z.AI-only options) | `scoutline read` |
| Repository exploration (search/read/tree/brief) | Yes | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | `scoutline repo ...` |
| Crawl | **No** | **No** | Yes | **No** | **No** | Yes (async; resumable after Ctrl-C) | **No** | **No** | **No** | **No** | **No** | Yes (sync) | `scoutline crawl` |
| Map | **No** | **No** | Yes | **No** | **No** | Yes | **No** | **No** | **No** | **No** | **No** | Yes | `scoutline map` |
| Research (4-250 credits) | **No** | **No** | Yes | Yes | **No** | **No** (`/deep-research` deprecated) | Yes | Yes | Yes | Yes | Yes | **No** | `scoutline research` |
| Raw tools | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline code ...` |

Vision results are never cached. Z.AI image limits are JPG/JPEG/PNG ≤5 MiB.
Search result count is applied locally after normalization and is never sent
to the active Provider.

## Batch (manifest runner)

Run many operations in one process — one summary envelope on stdout,
`results[]` in manifest order:

```bash
scoutline batch manifest.json            # schema v1; allowlist: search, read,
                                          # research, repo, vision, crawl, map
scoutline batch manifest.json --dry-run  # assignment preview; no transport,
                                          # cache reads/writes, or output files
cat manifest.json | scoutline batch -    # manifest on stdin (ops never read stdin)
scoutline vision batch './shots/*.png' --prompt 'describe {filename}' --out out/
```

Provider **distribution is the default**: unpinned ops are assigned
round-robin across configured, capable providers per capability group in
registry order. Pin per op (`provider` field) or globally (`--provider`) to
opt out. `routing.<capability>` is ignored inside batch (all eligible
providers participate; pin to opt out) and search fan-out is suppressed —
each op runs on exactly its assigned provider. Ops run in data mode with
per-op notice/error capture; `--concurrency` 1-8 (default 4; `vision batch`
default 1); `--fail-fast` stops scheduling after the first failure; optional
per-op `output` writes captured stdout (temp + rename); `vision batch` adds
per-input files plus `out/summary.json` (`--out` required for more than one
input).

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| vision | Analyze images, screenshots, videos (incl. `batch`) | `--help` for 9 subcommands |
| batch | Manifest of operations run across providers (distribution by default) | `--help` for manifest + flags |
| search | Real-time web search | `--help` for filtering options (incl. `--topic`) and local context |
| read | Fetch web pages as markdown (nine providers) | `--help` for format options |
| crawl | Multi-page website traversal (Tavily, Firecrawl, or Spider.cloud) | `--help` for depth/breadth/filters |
| map | URL-set discovery without fetching pages (Tavily, Firecrawl, or Spider.cloud) | `--help` for depth/breadth/filters |
| research | Deep research with citations (seven providers; 4-250 credits) | `--help` for model/citation/timeout and local context |
| repo | GitHub code search and reading (Z.AI) | `--help` for tree/search/read/brief |
| quota | Provider-normalized plan usage dashboard | `--help` for `--all-providers` |
| tools | List available MCP tools (Z.AI) | |
| tool | Show tool schema | |
| call | Raw MCP tool invocation | |
| doctor | Provider-aware diagnostics (schema v2) | `--help` for `--no-tools` |
| cache | Inspect or clear the local cache | `--help` for stats/clear |
| usage | Local call-usage report (90-day `usage.json` ledger) | `--help` for `--days`/`--provider` |
| history | Read-only inventory of `--save` artifacts (list/show/stats) | `--help` for `--since`/`--limit`/`--command` |
| code | TypeScript tool chaining (Z.AI) | |
| init | Interactive onboarding wizard (writes ~/.scoutline/config.json) | `--help` for the four lifecycle states |

## Quick Start

```bash
# Z.AI (default)
npx scoutline@0.18.1 vision analyze ./screenshot.png "What errors do you see?"
npx scoutline@0.18.1 search "React 19 new features" --count 5
npx scoutline@0.18.1 read https://docs.example.com/api
npx scoutline@0.18.1 read https://docs.example.com/api --with-images-summary --no-gfm
npx scoutline@0.18.1 repo search facebook/react "server components"
npx scoutline@0.18.1 repo search openai/codex "config" --language en
npx scoutline@0.18.1 repo tree openai/codex --path codex-rs --depth 2
npx scoutline@0.18.1 quota
npx scoutline@0.18.1 doctor

# MiniMax Token Plan
npx scoutline@0.18.1 --provider minimax search "AI policy news"
npx scoutline@0.18.1 --provider minimax vision analyze ./diagram.png "Explain this"
npx scoutline@0.18.1 --provider minimax quota
npx scoutline@0.18.1 doctor --provider minimax

# Tavily (Search, Reader, Crawl, Map, Research)
npx scoutline@0.18.1 --provider tavily search "AI funding rounds" --topic news
npx scoutline@0.18.1 --provider tavily read https://example.com/
npx scoutline@0.18.1 --provider tavily crawl https://docs.example.com --depth 2
npx scoutline@0.18.1 --provider tavily map https://docs.example.com
npx scoutline@0.18.1 --provider tavily research "Rust async runtime comparison"
npx scoutline@0.18.1 doctor --provider tavily

# Exa (Search, Reader, Research)
npx scoutline@0.18.1 --provider exa search "latest AI research" --topic news
npx scoutline@0.18.1 --provider exa read https://example.com/
npx scoutline@0.18.1 --provider exa research "Compare Rust async runtimes"
npx scoutline@0.18.1 doctor --provider exa

# Brave (Search: web, news, video)
npx scoutline@0.18.1 --provider brave search "AI policy news" --topic news
npx scoutline@0.18.1 --provider brave search "rust async" --type video
npx scoutline@0.18.1 --provider brave search "large context topic" --content-size high
npx scoutline@0.18.1 --provider brave quota
npx scoutline@0.18.1 doctor --provider brave

# All-Provider quota
npx scoutline@0.18.1 quota --all-providers

# Local cache inspection, clearing, and pruning
npx scoutline@0.18.1 cache stats                 # inventory both subdirectories
npx scoutline@0.18.1 cache clear                 # delete every file in cache/ and tools/
npx scoutline@0.18.1 cache prune --older-than 24h   # delete entries older than 24h (Nh|Nm|Ns|seconds)

# Config (see "Settings via scoutline config" above)
npx scoutline@0.18.1 config get routing
```

## Repository Exploration

`scoutline repo search`, `scoutline repo read`, `scoutline repo tree`, and
`scoutline repo brief` participate in Provider selection. Z.AI advertises
and supplies `repository-exploration`; the other built-in Providers do not. By
default (0.11.0+) Provider fallback auto-reroutes to Z.AI with a
stderr notice; under `--no-fallback` (or `SCOUTLINE_NO_FALLBACK=1`)
the preflight surfaces `UNSUPPORTED_CAPABILITY` for the selected
non-supplier.

### v0.2 → v1 schema migration (breaking)

`repo` successes return **schema-version-1 structured values**, not the v0.2
raw ZRead text or depth-dependent raw Tree shape:

| Command | v1 schema |
| --- | --- |
| `repo search` | `{schemaVersion:1, repository, query, language, excerpts:[{text}], truncated, originalTextLength}` |
| `repo read` | `{schemaVersion:1, repository, path, content, truncated, originalContentLength}` |
| `repo tree` | `{schemaVersion:1, repository, path, depth, snapshots:[{repository, path, entries:[{name, path, kind}]}]}` (structured at every depth, including depth 1) |
| `repo brief` | `{schemaVersion:1, repository, focus, coverage:{probes}, tree?, docs?, entryPoints?, files?:[{path, content, truncated, originalContentLength}], detected:{hasReadme, hasManifest, manifestKinds}}` (sections gated by `--focus`; `coverage` and `detected` always present) |

Root Tree path is the empty string `""`. Default Search language is `"en"`
(pass `--language zh` for Chinese). Output modes for `repo` results:
`data` emits the raw schema-version-1 value as plain JSON with no
envelope; `json` and `pretty` emit the standard `{success, data,
timestamp}` envelope (indent 0 for `json`, indent 2 for `pretty`); and
the text-oriented modes (`compact`, `markdown`, `refs`, `tty`) receive
the JSON fallback — the same value as `data` mode — because `repo`
supplies no per-mode prose presentation override.

### `repo brief` (composed envelope)

`scoutline repo brief <owner/repo>` composes the three operations — tree,
search, and read — into one schema-version-1 `RepositoryBrief` envelope.
`--focus` subsets the sealed set `structure, readme, manifest, files`
(default all four; repeatable — repeated flags combine in first-seen
order). Focus gates the optional probes and their envelope sections
together: an excluded README/manifest search or read stage does not run
and is recorded `skipped`/`focus-excluded` in `coverage.probes`; the tree
probe is the exception and always runs, because read-path selection and
`detected` both derive from it. File selection is tree-derived and
deterministic: the shallowest README first, then one manifest per kind
(`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) — capped at 4
reads total. The cap counts the README, so when a README is present only
the first three manifest kinds are read (`go.mod` is the one dropped).
A focus-requested read stage that selects nothing still records a
terminal `read:<files>` probe (`skipped`/`no-selection`). `--max-chars`
is a per-call budget forwarded to every search and read; the tree is
never character-limited. A failed probe is recorded in `coverage.probes`
(ok/failed/skipped with a stable code and redacted message) while the
brief continues — `coverage` and `detected` are always present, so
consumers distinguish "not requested", "failed", "dependency failed",
and "nothing selected" from the probe records, never from missing keys.
The brief is never cached as a unit; its probes reuse the per-operation
repository cache entries, and identical responses yield byte-identical
output.

### `--max-chars` is deterministic and local

`--max-chars` never invokes a model — it is post-normalization projection:

- absent / zero / negative → no truncation;
- `repo search` → one total budget across `excerpts[].text`; the final
  retained excerpt is truncated, later excerpts are omitted;
- `repo read` → only `content` is truncated; `originalContentLength` and
  `truncated` describe the pre-truncation state;
- `repo tree` → never character-limited; metadata and JSON envelopes are not
  part of any budget;
- `repo brief` → forwarded verbatim to every search and read probe as a
  per-call budget; the tree probe is never character-limited.

### Errors and lifecycle

Encoded MCP error strings and malformed ZRead wrappers are mapped
deterministically before success parsing. Exhausted ZRead quota (code
`1310` or explicit exhausted-limit meaning) is terminal `QUOTA_ERROR` 429.
Transient 429/5xx and a malformed envelope retry once; auth 401/403 and other
4xx are terminal. Raw Provider body, reset metadata, and error-text strings
never cross the public interface.

Transport close is best-effort and per attempt: success does not become
failure when close rejects or times out, and a primary failure remains the
outward failure when close also fails. Cache hits construct and close no
transport.

### Cache continuity

New cache entries use the namespace
`v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json`,
where `<credential-hash>` is the full lowercase SHA-256 hex digest of the
Adapter-resolved credential. Legacy v0.2 Z.AI cache entries remain readable
read-only; their key is reconstructed from the same credential using the
exact v0.2 algorithm, and a valid hit is written through to the new key.
Legacy files are never rewritten, migrated, or deleted. `--no-cache`
performs no reads or writes. Injected credentials drive the fingerprint and
legacy-key construction — ambient `process.env` is never reread.

## Reader

`scoutline read` participates in Provider selection. Z.AI, Tavily, Exa,
and Firecrawl advertise `reader`; Z.AI supplies it through the Z.AI
Reader Adapter, Tavily through the Tavily `/extract` endpoint, Exa
through `/contents`, and Firecrawl through `/v2/scrape`. MiniMax and
Brave do not, so by default (0.11.0+) selecting either emits a stderr
notice and Provider fallback auto-reroutes to the next eligible
configured supplier; under `--no-fallback` (or
`SCOUTLINE_NO_FALLBACK=1`) the preflight surfaces
`UNSUPPORTED_CAPABILITY`. Tavily rejects the Z.AI-only options
(`--with-links`, `--no-gfm`, `--keep-img-data-url`,
`--with-images-summary`) with `UNSUPPORTED_OPTION` when set to `true`.

### v0.2 → v1 schema migration (breaking)

`read` successes return **schema-version-1 structured values**, not the v0.2
raw content string or bare extract array:

| Read shape | v1 schema |
| --- | --- |
| Content read (default) | `{schemaVersion:1, url, finalUrl, title, content, contentFormat, truncated, originalContentLength}` |
| Extract read (`--extract code\|links\|tables\|headings`) | `{schemaVersion:1, url, finalUrl, mode, items, truncated, originalItemCount}` |

`url` is exactly what the caller passed; `finalUrl` is the URL the operation
actually fetched (differs only on a Provider-side rewrite, e.g. gist URLs to
their raw form). The four `--extract` modes and their item shapes are
unchanged from v0.2 — only the outer envelope changed (bare array →
schema-versioned object with `items`).

### Output-mode disambiguation

`read` is asymmetric with `repo` on the text-oriented modes. `repo` always
falls back to JSON; `read` emits prose when the result has prose and falls
back to JSON when it does not:

| Mode | Content read | Extract read |
| --- | --- | --- |
| `data` / `json` / `pretty` | The envelope object | The envelope object |
| `compact` / `markdown` / `refs` / `tty` | The `content` string directly | **JSON fallback** (the envelope object) |

A content read supplies one prose form (the page body); an extract read
supplies data, not prose, so the text modes fall back to JSON. Use `-O data`
for the structured extract shape every time.

### `--max-chars` and `--full-envelope`

`--max-chars` is deterministic local projection (never a model):

- absent / zero / negative → no truncation;
- content read → truncates the envelope's `content`; sets `truncated: true`
  and preserves `originalContentLength`;
- extract read → **ignored**. Extract reports `originalItemCount` instead.

`--full-envelope` is silently accepted and ignored — the v1 envelope is
always returned. Scripts that branched on its presence will now always
receive the envelope.

### Errors and lifecycle

Encoded MCP error envelopes are recognized before success parsing. The
taxonomy matches `repo`: exhausted WebReader quota (code `1310` or explicit
exhausted-limit meaning) is terminal `QUOTA_ERROR` 429; transient 429/5xx
and a malformed envelope retry once; auth 401/403 and other 4xx are
terminal. Raw Provider body, reset metadata, and error-text strings never
cross the public interface. Transport close is best-effort and per attempt;
cache hits construct and close no transport.

### Cache continuity

New cache entries use the namespace
`v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json`,
where `<credential-hash>` is the full lowercase SHA-256 hex digest of the
Adapter-resolved credential. The canonical request URL is the **rewritten**
URL so two requests that normalize to the same fetched URL share one entry.
Legacy v0.2 Z.AI cache entries remain readable read-only; their key is
reconstructed from the same credential using the exact v0.2 args-order
algorithm, and a valid hit is written through to the new key. Legacy files
are never rewritten, migrated, or deleted. `--no-cache` performs no reads or
writes. Injected credentials drive the fingerprint and legacy-key
construction — ambient `process.env` is never reread.

## Output

Default: **data-only** (raw output for token efficiency).
Use `--output-format json` for `{ success, data, timestamp }` wrapping.

`quota` returns a schema-version-1 `QuotaDashboard` (ADR-0001); `doctor`
returns a **schema-version-2** `DiagnosticsReport` carrying a
`capabilityMatrix` field (per-capability list of supplying Providers)
plus a one-line cache summary under `cache.summary`. Both are
Provider-neutral. PB-T5 adds additive optional fields to both schemas
(no version bump): each `quota` success row may carry `quotaSource:
{ source: "snapshot" | "live", observedAt, authoritative }`, the
`providers` union may include a `{ status: "none", reason:
"no-capability" }` row for a configured provider without quota (Exa,
Parallel, Perplexity, You.com),
and each `doctor` provider entry may carry `quota: { source:
"snapshot" | "none", observedAt?, authoritative }` plus `verification:
{ status, checkedAt, reason? }`. Pre-PB-T5 consumers ignore these
fields (handled by fall-through). `repo` returns the schema-version-1 objects documented
above; the standard envelope wraps them in `json`/`pretty` and the
exact object is emitted in `data`. `read` returns the schema-version-1
content-read or extract-read envelope in `data`/`json`/`pretty`;
text-oriented modes emit the `content` string for content reads
(prose) and fall back to JSON for extract reads (data, not prose).
`crawl` and `research` return schema-version-1 structured values
(`{schemaVersion, baseUrl|query, pages|report, ...}`) in `data` mode;
`map` returns `{schemaVersion, baseUrl, urls, totalUrls}`.

`cache stats`, `cache clear`, and `cache prune` return their raw JSON
shape in `data` mode (`{dir, enabled, ttlMs, sizeCapBytes,
responseCache, toolCache}`, `{responsesCleared, toolsCleared,
bytesFreed}`, and `{prunedResponses, prunedTools, bytesFreed}`
respectively) and a multi-line / one-line rendering in every
text-oriented mode. `cache stats` also reports additively:
`responseCache`/`toolCache` carry `live`/`expired` counts (derived from
each entry's stored timestamp — `ts` for response entries, `timestamp`
for tool entries — vs the TTL), and `responseCache` breaks down
into `byProvider`/`byCapability` buckets (each `{entries, totalBytes,
live, expired}`; non-v2 filenames group under `legacy`).

## Local Cache

The local cache lives at `~/.scoutline/` on every platform with two
sibling subdirectories: `cache/` (Provider responses) and `tools/`
(MCP tool discovery). Inspect, clear, or prune it with
`scoutline cache stats`, `scoutline cache clear`, and
`scoutline cache prune`. Prune deletes expired entries by stored
timestamp: `--older-than <D>` (`24h`, `90m`, `30s`, or bare seconds)
replaces the TTL threshold; `--provider`/`--capability` selectors AND
together and match v2 filenames only (legacy files are age-selected,
never selector-selected).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOUTLINE_CACHE` | `1` | `0` or `false` disables both caches. |
| `SCOUTLINE_CACHE_TTL_MS` | `86400000` (24h) | TTL for both response and tool entries. |
| `SCOUTLINE_CACHE_SIZE_MB` | `100` | Size cap (MB) for the response cache (LRU eviction). |
| `SCOUTLINE_CACHE_DIR` | `~/.scoutline/` | Overrides the root; `cache/` and `tools/` are created underneath. |

Legacy aliases (`ZAI_CACHE*`, `ZAI_MCP_TOOL_CACHE*`, `ZAI_MCP_CACHE_DIR`)
are accepted silently at lower precedence. `XDG_CACHE_HOME` is no longer
consulted; the orphaned `~/.cache/zai-cli/` directory is never read,
migrated, or deleted.

## Usage Ledger

Every billable invoke (search — fan-out arms and `--merge` sub-queries
each count — read, crawl, map, research, repo, vision) appends counters
to `~/.scoutline/usage.json`, bucketed by UTC calendar day, then
provider, then capability. Retries each count as an attempt; cache hits
record nothing. Retention is 90 days (pruned on day-roll; no config
knob). `SCOUTLINE_CONFIG_DIR` moves the ledger with the config root.

Report it with `scoutline usage [--days N] [--provider <id>]` (default
window 7 days; credential-free, no network). Counts are billable call
attempts — providers do not report credit costs. The ledger stores
counters only: no queries, URLs, prompts, results, or credentials; a
corrupt or missing ledger reports an empty window with exit 0.

## Advanced

For raw MCP tool calls (`tools`, `tool`, `call`), Code Mode, package and
publication gates, MiniMax environment variables, repository cache shape
and legacy continuity, diagnostics inventory derivation, and encoded MCP
error taxonomy, see `references/advanced.md`.