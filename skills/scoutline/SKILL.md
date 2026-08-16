---
name: scoutline
description: |
  Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, and Jina AI CLI providing:
  - Vision: image/video analysis, OCR, UI-to-code, error diagnosis (GLM-5V-Turbo)
  - Search: real-time web search with domain/recency/topic filtering
  - Reader: web page to markdown extraction (Z.AI, Tavily, Exa, Firecrawl, Parallel, or Jina)
  - Crawl: multi-page website traversal (Tavily or Firecrawl)
  - Map: URL-set discovery without fetching pages (Tavily or Firecrawl)
  - Research: asynchronous deep research with citations (Tavily, Exa, Parallel, Perplexity, or Jina)
  - Repo: GitHub code search and reading via ZRead (Z.AI)
  - Tools: MCP tool discovery, schemas, and raw calls (Z.AI)
  - Code: TypeScript tool chaining (Z.AI)
  - Provider selection: --provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina> for shared
    capabilities, repo, read, crawl, map, and research
  Use for visual content analysis, web search, page reading, multi-page
  site traversal, deep research, or GitHub exploration.
---

# Scoutline

Access Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, and Jina AI capabilities via `npx scoutline@0.14.11`. The
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
npx scoutline@0.14.11 config get                        # full config, credentials always masked
npx scoutline@0.14.11 config set routing.search tavily,brave   # strict: typos FAIL, not drop
npx scoutline@0.14.11 config unset routing.search
npx scoutline@0.14.11 config set fallbackEnabled false
```

The `routing` key sets a standing per-capability provider preference:
with no `--provider` / `SCOUTLINE_PROVIDER` pin, the first
configured-and-capable provider in the list wins (over quota ranking).
Credential paths (`providers.<id>.apiKey`) refuse `set` — use `init`
or env vars; API keys never belong in command arguments.

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`),
**`repo`**, **`read`**, **`crawl`**, **`map`**, and **`research`**
accept the global `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>` flag. Precedence
is the flag, then the `SCOUTLINE_PROVIDER` environment variable, then
the default `zai`. Provider selection is never inferred from
credentials. Unknown values fail fast with `VALIDATION_ERROR`.

`tools`, `tool`, `call`, and `code` accept the flag but ignore it; they
remain Z.AI-only.

Capability coverage at launch (generated from the production registry
in registry order `[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina]`):

- `search` — Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI,
  Perplexity, Jina AI. The only search control honored by every Provider
  is `--topic <general|news|finance>`.
  Brave is the only Provider that accepts `--type video`; every other
  Provider rejects `controls.type` as `UnsupportedOptionError` so
  option-level fallback continues to Brave.
- `vision.interpret-image` — Z.AI, MiniMax. Specialized Vision ops
  (`ui-artifact`, `extract-text`, `diagnose-error`, `diagram`, `chart`)
  follow the same registry and are mediated by MiniMax's compiled
  conformance registry.
- `quota` — Z.AI, MiniMax, Tavily, Firecrawl (credits), Brave
  (rate-limit window), Jina AI (rate-limit telemetry). Exa, Parallel AI,
  and Perplexity do not advertise quota.
- `diagnostics` — every built-in Provider (Z.AI, MiniMax, Tavily, Exa,
  Brave, Firecrawl, Parallel AI, Perplexity, Jina AI).
- `read` — Z.AI, Tavily, Exa, Firecrawl, Parallel AI, Jina AI (MiniMax,
  Brave, and Perplexity do not advertise it; Tavily/Exa/Firecrawl/Parallel
  reject Z.AI-only reader options: `--with-links`, `--no-gfm`,
  `--keep-img-data-url`, `--with-images-summary`; Jina maps them natively).
- `repo` — Z.AI only (repository-exploration is Z.AI-supplied).
- `crawl` — Tavily (sync), Firecrawl (async, resumable after Ctrl-C).
- `map` — Tavily, Firecrawl.
- `research` — Tavily, Exa, Parallel AI, Perplexity, Jina AI.
  Credit-intensive (4-250 credits). `--output-length`, `--citation-format`,
  and `--domain` are honored by Tavily; Exa warn-and-strips them (Agent
  create has no native fields).

Z.AI is the only Provider that supplies `repo search/read/tree` and the
Raw tools (`tools`, `tool`, `call`). Reader is supplied by Z.AI, Tavily,
Exa, Firecrawl, Parallel AI, and Jina AI; Crawl and Map by Tavily and
Firecrawl only; Research by Tavily, Exa, Parallel AI, Perplexity, and
Jina AI; Vision by Z.AI and MiniMax only. **Provider
fallback is always-on by default**
(0.11.0+): selecting a non-supplier emits a stderr notice and silently
reroutes to the next eligible configured Provider in registry order
`[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina]`. Pass
`--no-fallback` (or set `SCOUTLINE_NO_FALLBACK=1`) to restore the
previous strict `UNSUPPORTED_CAPABILITY` behavior — the preflight
still runs capability metadata → configuration → adapter handle in
order on the effective Provider only.

## Capability Matrix

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina AI | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Search | Yes | Yes (no domain/recency/content-size/location) | Yes (no location) | Yes (no location) | Yes (web/news/video; `--content-size high` → LLM Context) | Yes (no location; `--content-size high` = markdown, +1 credit/result) | Yes (domain, recency, location, content-size via `advanced_settings`; topic via keyword) | Yes (domain, recency, content-size; topic via keyword) | Yes (domain, location; rejects recency/content-size; topic via keyword) | `scoutline search` |
| General single-image interpretation | Yes | Yes (JPG/JPEG/PNG/WebP ≤50 MiB) | No | No | No | No | No | No | No | `scoutline vision analyze` |
| Specialized Vision (UI-to-code, OCR, error diagnosis, diagram) | Yes | Available (live-attested; conformance-gated) | No | No | No | No | No | No | No | `scoutline vision ui-to-code`, `vision extract-text`, `vision diagnose-error`, `vision diagram` |
| Specialized Vision (chart) | Yes | Pending (implemented; fixture image defect blocks live conformance) | No | No | No | No | No | No | No | `scoutline vision chart` |
| Two-image diff, video | Yes | No | No | No | No | No | No | No | No | `scoutline vision diff`, `vision video` |
| Quota (normalized) | Yes | Yes | Yes | **No** (deferred) | Yes (rate-limit window, not spend) | Yes (credits) | **No** | **No** | Yes (rate-limit telemetry, not spend) | `scoutline quota [--all-providers]` |
| Diagnostics | Yes | Yes | Yes | Yes | Yes | Yes (single-scrape probe) | Yes | Yes | Yes | `scoutline doctor [--no-tools]` |
| Reader | Yes | **No** (UNSUPPORTED_CAPABILITY) | Yes (rejects Z.AI-only options) | Yes (rejects Z.AI-only options) | **No** (UNSUPPORTED_CAPABILITY) | Yes (returns page titles) | Yes | **No** (UNSUPPORTED_CAPABILITY) | Yes | `scoutline read` |
| Repository exploration (search/read/tree/brief) | Yes | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | **No** (UNSUPPORTED_CAPABILITY) | `scoutline repo ...` |
| Crawl | **No** | **No** | Yes | **No** | **No** | Yes (async; resumable after Ctrl-C) | **No** | **No** | **No** | `scoutline crawl` |
| Map | **No** | **No** | Yes | **No** | **No** | Yes | **No** | **No** | **No** | `scoutline map` |
| Research (4-250 credits) | **No** | **No** | Yes | Yes | **No** | **No** (`/deep-research` deprecated) | Yes | Yes | Yes | `scoutline research` |
| Raw tools | Yes | No | No | No | No | No | No | No | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | No | No | No | No | No | No | No | `scoutline code ...` |

Vision results are never cached. Z.AI image limits are JPG/JPEG/PNG ≤5 MiB.
Search result count is applied locally after normalization and is never sent
to the active Provider.

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| vision | Analyze images, screenshots, videos | `--help` for 8 subcommands |
| search | Real-time web search | `--help` for filtering options (incl. `--topic`) |
| read | Fetch web pages as markdown (six providers) | `--help` for format options |
| crawl | Multi-page website traversal (Tavily or Firecrawl) | `--help` for depth/breadth/filters |
| map | URL-set discovery without fetching pages (Tavily or Firecrawl) | `--help` for depth/breadth/filters |
| research | Deep research with citations (five providers; 4-250 credits) | `--help` for model/citation/timeout |
| repo | GitHub code search and reading (Z.AI) | `--help` for tree/search/read/brief |
| quota | Provider-normalized plan usage dashboard | `--help` for `--all-providers` |
| tools | List available MCP tools (Z.AI) | |
| tool | Show tool schema | |
| call | Raw MCP tool invocation | |
| doctor | Provider-aware diagnostics (schema v2) | `--help` for `--no-tools` |
| cache | Inspect or clear the local cache | `--help` for stats/clear |
| code | TypeScript tool chaining (Z.AI) | |
| init | Interactive onboarding wizard (writes ~/.scoutline/config.json) | `--help` for the four lifecycle states |

## Quick Start

```bash
# Z.AI (default)
npx scoutline@0.14.11 vision analyze ./screenshot.png "What errors do you see?"
npx scoutline@0.14.11 search "React 19 new features" --count 5
npx scoutline@0.14.11 read https://docs.example.com/api
npx scoutline@0.14.11 read https://docs.example.com/api --with-images-summary --no-gfm
npx scoutline@0.14.11 repo search facebook/react "server components"
npx scoutline@0.14.11 repo search openai/codex "config" --language en
npx scoutline@0.14.11 repo tree openai/codex --path codex-rs --depth 2
npx scoutline@0.14.11 quota
npx scoutline@0.14.11 doctor

# MiniMax Token Plan
npx scoutline@0.14.11 --provider minimax search "AI policy news"
npx scoutline@0.14.11 --provider minimax vision analyze ./diagram.png "Explain this"
npx scoutline@0.14.11 --provider minimax quota
npx scoutline@0.14.11 doctor --provider minimax

# Tavily (Search, Reader, Crawl, Map, Research)
npx scoutline@0.14.11 --provider tavily search "AI funding rounds" --topic news
npx scoutline@0.14.11 --provider tavily read https://example.com/
npx scoutline@0.14.11 --provider tavily crawl https://docs.example.com --depth 2
npx scoutline@0.14.11 --provider tavily map https://docs.example.com
npx scoutline@0.14.11 --provider tavily research "Rust async runtime comparison"
npx scoutline@0.14.11 doctor --provider tavily

# Exa (Search, Reader, Research)
npx scoutline@0.14.11 --provider exa search "latest AI research" --topic news
npx scoutline@0.14.11 --provider exa read https://example.com/
npx scoutline@0.14.11 --provider exa research "Compare Rust async runtimes"
npx scoutline@0.14.11 doctor --provider exa

# Brave (Search: web, news, video)
npx scoutline@0.14.11 --provider brave search "AI policy news" --topic news
npx scoutline@0.14.11 --provider brave search "rust async" --type video
npx scoutline@0.14.11 --provider brave search "large context topic" --content-size high
npx scoutline@0.14.11 --provider brave quota
npx scoutline@0.14.11 doctor --provider brave

# All-Provider quota
npx scoutline@0.14.11 quota --all-providers

# Local cache inspection, clearing, and pruning
npx scoutline@0.14.11 cache stats                 # inventory both subdirectories
npx scoutline@0.14.11 cache clear                 # delete every file in cache/ and tools/
npx scoutline@0.14.11 cache prune --older-than 24h   # delete entries older than 24h (Nh|Nm|Ns|seconds)

# Config (see "Settings via scoutline config" above)
npx scoutline@0.14.11 config get routing
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
"no-capability" }` row for a configured provider without quota (Exa),
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

## Advanced

For raw MCP tool calls (`tools`, `tool`, `call`), Code Mode, package and
publication gates, MiniMax environment variables, repository cache shape
and legacy continuity, diagnostics inventory derivation, and encoded MCP
error taxonomy, see `references/advanced.md`.