<h1 align="center">Scoutline</h1>

<p align="center">
  A command-line field kit for investigating web, repository, and visual sources.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scoutline"><img src="https://img.shields.io/npm/v/scoutline.svg" alt="npm version"></a>
  <a href="https://github.com/vikasagarwal101/scoutline/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

> Independently maintained by Vikas Agarwal. See [CREDITS.md](https://github.com/vikasagarwal101/scoutline/blob/main/CREDITS.md) for project attribution.

---

## Features

- **Vision** - Analyze images, screenshots, diagrams, charts, videos using GLM-5V-Turbo
- **Search** - Real-time web search with domain and recency filtering
- **Reader** - Fetch and parse web pages to markdown
- **Repo** - Search and read GitHub repository code via ZRead
- **Tools** - MCP tool discovery, schemas, and raw calls
- **Code Mode** - TypeScript tool chaining for agent automation
- **Provider selection** - Run shared capabilities through Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, or Jina AI

## Quick Start

```bash
export Z_AI_API_KEY="your-api-key"

npx scoutline --help
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
npx scoutline search "React 19 new features" --count 5
```

Get your Z.AI API key at: https://z.ai/manage-apikey/apikey-list

To use MiniMax instead:

```bash
export MINIMAX_API_KEY="your-minimax-key"
npx scoutline --provider minimax search "latest LLM benchmarks"
```

To use Brave (Search: web, news, video):

```bash
export BRAVE_SEARCH_API_KEY="your-brave-key"
npx scoutline --provider brave search "AI policy news" --topic news
npx scoutline --provider brave search "rust async" --type video
```

### Interactive Onboarding (`scoutline init`)

Instead of exporting environment variables, run the interactive wizard to
record API keys in `~/.scoutline/config.json` (mode 0600):

```bash
scoutline init
```

The wizard walks you through a provider checklist (Z.AI, MiniMax, Tavily,
Exa, Brave, Firecrawl — equal weight, none pre-checked), takes each key via
hidden input, and performs a single inline validation probe against an
ephemeral in-memory environment (the candidate key is never persisted or
written to `process.env` until the final atomic write). It also asks your
fallback preference and discloses credit costs before any paid probe.

If you already have a config, `init` opens a re-config menu (edit a key, add
or remove a provider, change the fallback preference, re-run the full
wizard, or cancel). For a corrupt `config.json`, `init` offers to back up
the live file and rewrite a fresh one — it is the recovery path.

Environment variables always take precedence over file keys at runtime
(`Z_AI_API_KEY` > `ZAI_API_KEY` > file key), so the wizard notes when an
imported env key will keep overriding the saved key.

Run `scoutline init --help` for the full lifecycle and exit-code reference.

## Installation

### As an Agent Skill

**OpenSkills** (universal - works with any AI coding agent):

```bash
npx openskills install vikasagarwal101/scoutline
```

**Claude Code** (native skill marketplace):

```bash
claude skill install vikasagarwal101/scoutline --skill scoutline
```

### As a CLI Tool

```bash
npm i -g scoutline
scoutline --help
```

Or use directly with npx:

```bash
npx scoutline --help
```

## Provider Selection

Shared commands (`search`, `vision`, `quota`, `doctor`, `repo`) accept a global
`--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>` flag. Resolution precedence:

1. Explicit `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>` on the command line
2. `SCOUTLINE_PROVIDER` environment variable
3. Per-capability **routing table** (`config.json` `routing` key; the first
   configured, capable provider in the list wins — over quota ranking)
4. Quota-ranked pick among configured, capable providers (registry-order tiebreak)

Set a standing preference once and skip per-command flags:

```bash
scoutline config set routing.search tavily,brave   # search prefers Tavily, then Brave
scoutline config set routing.crawl firecrawl
scoutline config get routing                       # view the effective table
```

Examples:

```bash
# 1. Flag wins over everything
scoutline --provider minimax search "React 19 features"

# 2. Environment variable when no flag is supplied
export SCOUTLINE_PROVIDER=minimax
scoutline quota

# 3/4. Routing table, then quota-ranked pick, when nothing is supplied
scoutline search "TypeScript best practices"
```

Provider selection is **never** inferred from which credentials are present;
empty credentials leave the Provider unconfigured and shared capabilities will
fail with `AUTH_ERROR` or `CONFIGURATION_ERROR`. Unknown Provider IDs fail
fast with `VALIDATION_ERROR`.

`scoutline search`, `scoutline vision`, `scoutline quota`, `scoutline doctor`,
**`scoutline repo`**, and **`scoutline read`** participate in Provider
selection. `scoutline tools`, `scoutline tool`, `scoutline call`, and
`scoutline code` accept the flag but ignore it; they remain Z.AI-only.

**Provider fallback is always-on by default** (0.11.0+). When the
selected provider does not advertise the capability (for example,
MiniMax does not advertise `repository-exploration` or `reader`) or
fails at runtime, Scoutline emits a stderr notice and silently
reroutes to the next eligible configured provider in registry order
`[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina]`. Pass `--no-fallback`
(or set `SCOUTLINE_NO_FALLBACK=1`) to restore the previous strict
single-provider, fail-loud behavior for scripting or cost-sensitive
workflows. See
[`docs/adr/0002-provider-fallback.md`](https://github.com/vikasagarwal101/scoutline/blob/main/docs/adr/0002-provider-fallback.md)
for the rationale
and the accepted async double-charge risk on `crawl` / `map` /
`research`.

### Search Fan-Out (multi-provider search)

For `search` only, one query can run across several providers in parallel
and merge into a single deduplicated list
([ADR-0004](https://github.com/vikasagarwal101/scoutline/blob/main/docs/adr/0004-multi-provider-search-fanout.md)).
Activation tiers, highest precedence first:

1. `--provider tavily,exa` (comma list) or `--provider all` — fan-out on
   the listed providers; `all` expands to every configured search
   provider in registry order.
2. A single `--provider <id>` or `SCOUTLINE_PROVIDER` — single provider;
   an explicit pin, fan-out is ignored.
3. `scoutline config set fanout true` (no pin) — fan-out on
   `routing.search` when set, else every configured search provider.
   Default is **false**; remove the standing switch with
   `scoutline config unset fanout`.
4. No pin and fan-out off — single provider via the standard selection
   order.

```bash
scoutline --provider tavily,exa search "rust async runtimes"
scoutline --provider all search "AI policy news"
scoutline config set fanout true    # standing preference (default off)
scoutline config unset fanout       # remove the standing switch
```

**Cost:** every search will bill ALL configured search providers — N arms
= N billable calls (when `routing.search` is set, only the eligible
routed providers — configured and search-capable — are billed;
`config set fanout true` names exactly those). Arms run in parallel (one client each,
pinned — no per-arm fallback); a provider that rejects a search control
drops with a stderr notice and never fails the invocation. Results are
deduplicated by canonical URL identity (scheme/host lowercased, default
ports, fragments, trailing slashes, and `utm_*`/`fbclid` parameters
removed — tracking names are matched after percent-decoding, the raw path
and userinfo are preserved, and the original URLs are kept in output),
ranked by cross-provider occurrences, and each result carries `mergedFrom`
listing the providers that returned it. `--merge` composes with fan-out:
every arm runs every sub-query and occurrences span the arms ×
sub-queries grid. Disable the standing switch with
`scoutline config set fanout false`.

### Local Context (`--context` / `--context-stdin`)

Steer `research` and `search` with a local notes file (markdown headings and
question lines; max 256 KiB, text only — NUL-byte detection rejects binary
input). `--context <path>` reads a file; `--context-stdin` reads the same
content from standard input. The two flags are mutually exclusive.

```bash
scoutline research "quokka conservation" --context notes.md             # organize (default)
scoutline research "quokka conservation" --context notes.md --context-mode bias
cat notes.md | scoutline research "quokka conservation" --context-stdin
scoutline search "rust async" --context notes.md
```

**Research modes** (`--context-mode organize | bias | both`): `organize`
(the default) re-presents the provider's report following your file's
headings — a purely local reordering, so the wire request and the response
cache key are untouched. `bias` (and `both`) append a capped
`(focus: ...)` term segment to the query before it is sent: that segment is
derived from your file and is what leaves your machine under those modes —
and it changes the cache key, so each mode is a separate (paid) job. The
resume command printed after an interrupt carries your context flags; with
`--context-stdin` you must re-pipe the same content unchanged.

**Search derivation**: `search --context` derives up to 8 sub-queries from
the file's headings and questions, always keeps your original query first,
and merges and dedupes all results. What leaves your machine under
`search --context`: the derived sub-query strings themselves become the
search queries — the file is never sent. Under fan-out this multiplies
cost (N sub-queries × M arms = N×M billable searches, disclosed once on
stderr). `--context` and `--context-stdin` are mutually exclusive with `--merge`.

**Privacy boundary**: parsed file content crosses the network in exactly
two shapes — the research `bias`/`both` focus segment and the
search-derived sub-query strings. Everything else stays local: `organize`
sends nothing derived, JSON outputs record only counts, the source path,
and a SHA-256 of the content, and no heading, question, term, or file byte
appears in notices or logs. Without these flags, `research` and `search`
output is byte-identical to previous releases.

## Capability Matrix

The matrix below is generated from the production provider registry
(`packages/scoutline/src/providers/registry.ts`) and reflects the
release-shipped capability advertisements for every built-in provider
in registry order `[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina]`. The
exact same `descriptor.capabilities()` set drives executor preflight,
Provider selection, and `doctor`.

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `search` | Yes | Yes | Yes | Yes | Yes (incl. `type: "video"`) | Yes | Yes | Yes | Yes | Parallel (declarative semantic), Perplexity (Sonar citations), Jina (neural web search) |
| `vision.interpret-image` (analyze) | Yes | Yes | No | No | No | No | No | No | No | Provider-specific media limits; uncached |
| `vision.ui-artifact` (ui-to-code) | Yes | Available | No | No | No | No | No | No | No | Live-attested; conformance-gated |
| `vision.extract-text` | Yes | Pending | No | No | No | No | No | No | No | Implemented, pending live conformance |
| `vision.diagnose-error` | Yes | Available | No | No | No | No | No | No | No | Live-attested; conformance-gated |
| `vision.diagram` | Yes | Pending | No | No | No | No | No | No | No | Implemented, pending live conformance |
| `vision.chart` | Yes | Pending | No | No | No | No | No | No | No | Implemented, pending live conformance |
| `vision.diff` (image diff) | Yes | No | No | No | No | No | No | No | No | Z.AI-only (never MiniMax-claimable) |
| `vision.video` | Yes | No | No | No | No | No | No | No | No | Z.AI-only (never MiniMax-claimable) |
| `quota` | Yes | Yes | Yes | No | Yes | Yes (credits) | No | No | Yes (rate-limit telemetry, not spend) | Normalized `QuotaDashboard` (ADR-0001) |
| `diagnostics` (`doctor`) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Lists every Provider; probes configured |
| `read` (Reader) | Yes | **No** | Yes | Yes | No | Yes | Yes | No | Yes | Parallel (Extract API) & Jina add Reader support |
| `crawl` | **No** | **No** | Yes | No | No | Yes (async) | No | No | No | Tavily sync; Firecrawl async (resumable after Ctrl-C) |
| `map` | **No** | **No** | Yes | No | No | Yes | No | No | No | URL-set discovery; no per-page content |
| `research` | **No** | **No** | Yes | Yes | **No** | **No** | Yes | Yes | Yes | Tavily, Exa, Parallel, Perplexity `sonar-deep-research`, and Jina DeepSearch report synthesis |
| `repo search` / `repo read` / `repo tree` / `repo brief` | Yes | **No** | **No** | **No** | **No** | **No** | **No** | **No** | **No** | Participates in selection; only Z.AI supplies `repository-exploration` |
| `tools`, `tool`, `call` (Raw tools) | Yes | No | No | No | No | No | No | No | No | Z.AI-only; accepts but ignores `--provider` |
| `code` (Code Mode) | Yes | No | No | No | No | No | No | No | No | Z.AI-only; accepts but ignores `--provider` |

Media limits for general single-image interpretation:

| Provider | Formats | Maximum |
| --- | --- | --- |
| Z.AI | JPG, JPEG, PNG | 5 MiB |
| MiniMax | JPG, JPEG, PNG, WebP | 50 MiB |

Vision results are never written to the local response cache.

### Specialized MiniMax Vision Mappings

The five specialized MiniMax Vision operations (`ui-artifact`,
`extract-text`, `diagnose-error`, `diagram`, `chart`) are **implemented**
in this release. Each operation has a dedicated prompt-composition Module
under `packages/scoutline/src/providers/minimax/vision-mappings/` and a
generated mapping revision committed to source.

Runtime support for these operations is gated by the compiled conformance
registry (`src/providers/minimax/vision-conformance.ts`). A specialized
operation is only routable through MiniMax when **every** condition holds:

- offline conformance state is `pass`,
- live conformance state is `pass`,
- a sanitized compiled attestation matches the operation, fixture version,
  Implementation identity, and generated mapping revision.

In the current release, `ui-artifact`, `extract-text`, `diagnose-error`, and
`diagram` have offline `pass`, live `pass`, and compiled attestations —
they are **supported at runtime** through MiniMax. The remaining operation
(`chart`) has offline `pass` and live `pending`; it is **unsupported at
runtime** through MiniMax (its fixture image has a rotated, low-resolution
Y-axis label that VLMs read inconsistently — a fixture-image-quality
blocker, not an evaluator issue). By default (0.11.0+), an explicit
MiniMax selection for `chart` emits a stderr notice and auto-reroutes
to Z.AI, which supports every specialized operation. Under
`--no-fallback` the preflight surfaces `UNSUPPORTED_CAPABILITY` for
MiniMax before credentials, media, transport, cache, or any other
Provider is touched (FR-023, FR-024). Pass `--no-fallback` to restore
the previous strict single-provider behavior.

No environment variable, flag, or configuration value can promote a
mapping to supported. Support is driven exclusively by the compiled
registry state.

#### Enabling live support

Live support is gated on a per-operation live attestation. The
attestation script requires explicit opt-in and `MINIMAX_API_KEY`:

```bash
SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs --operation chart
```

Replace `chart` with `ui-artifact`, `extract-text`, `diagnose-error`,
or `diagram`. The script runs one fixture against the live Provider,
evaluates the semantic assertions in memory, and either:

- writes a sanitized attestation entry to
  `src/providers/minimax/vision-attestations.ts`, flips the registry's
  `live` state to `pass`, and verifies runtime support becomes `true`;
  OR
- sets the registry's `live` state to `fail` if the semantics do not
  hold. No success attestation is written and the mapping remains
  unsupported.

The next `npm run build` recompiles the registry with the new
attestation and the operation becomes routable through MiniMax.

Help text, `doctor`, and the Adapter's descriptor metadata all derive
from the same registry, so once a mapping is promoted it appears on
every runtime surface automatically — there is no second support list
to update.

## Usage

The CLI is self-documenting. Use `--help` at any level:

```bash
scoutline --help              # All commands
scoutline vision --help       # Vision commands
scoutline search --help       # Search options
scoutline repo --help         # GitHub repo commands
scoutline doctor --help       # Provider diagnostics
scoutline quota --help        # Plan usage
scoutline cache --help        # Local cache inspection, clearing, and pruning
```

### Examples

```bash
# Provider selection
scoutline --provider minimax search "AI policy news"
scoutline --provider zai search "internal docs"

# Vision - analyze images
scoutline vision analyze ./image.png "Describe this"
scoutline vision ui-to-code ./design.png --output code
scoutline vision extract-text ./screenshot.png --language python
scoutline vision diagnose-error ./error.png

# Search - web search
scoutline search "TypeScript best practices" --count 10
scoutline search "security news" --recency oneDay

# Reader - fetch web content
scoutline read https://docs.example.com/api
scoutline read https://blog.example.com --format text

# Repo - GitHub exploration
scoutline repo tree facebook/react
scoutline repo search vercel/next.js "app router"
scoutline repo read anthropics/anthropic-sdk-python README.md
scoutline repo search openai/codex "config" --language en
scoutline repo tree openai/codex --path codex-rs --depth 2
scoutline repo brief facebook/react
scoutline repo brief openai/codex --focus readme,manifest --max-chars 2000

# Quota - effective or all providers
scoutline quota                       # effective Provider
scoutline quota --all-providers       # every configured Provider

# Doctor - check setup
scoutline doctor                      # full diagnostics
scoutline doctor --no-tools           # metadata only, no transport
scoutline doctor --provider minimax   # MiniMax connectivity

# Cache - inspect, clear, or prune the local cache
scoutline cache stats                 # inventory of both subdirectories (live/expired, per provider and capability)
scoutline cache clear                 # delete every file under cache/ and tools/
scoutline cache prune                 # delete expired entries (effective TTL threshold)
scoutline cache prune --older-than 168h --provider zai    # age override + selectors (AND together)

# Config - inspect and change settings (scriptable, always redacted)
scoutline config get                  # full config dump (credentials masked)
scoutline config set routing.search tavily,brave
scoutline config unset routing.search
```

## Output Format

Default output is **data-only** for token efficiency. Use `--output-format json` for structured responses:

```json
{
  "success": true,
  "data": "...",
  "timestamp": 1234567890
}
```

Quota output is a schema-version-1 `QuotaDashboard`:

```json
{
  "schemaVersion": 1,
  "effectiveProvider": "zai",
  "providers": [
    {
      "provider": "zai",
      "status": "ok",
      "categories": [
        { "name": "requests", "unit": "requests", "current": { "remainingPercent": 87.5 } },
        { "name": "tokens",   "unit": "tokens",   "current": { "remainingPercent": 64.2 } }
      ]
    }
  ]
}
```

Doctor output is a schema-version-1 `DiagnosticsReport` listing every built-in
Provider with its configured state, declared capabilities, probe status, and a
one-line cache summary under the `cache` field.

## Notes

- `repo search` defaults to English results. Use `--language zh` for Chinese.
- `repo tree` supports `--path` (directory scope) and `--depth` (expand subtrees).
- `repo brief` composes tree + search + read into one schema-version-1
  `RepositoryBrief` envelope; `--focus` subsets the sealed set
  `structure, readme, manifest, files` (default all four).
- `quota --all-providers` exits 1 if any configured Provider fails; successful
  entries are still reported.
- `doctor` exits 1 when the effective Provider is unconfigured or any
  configured probe fails; successful entries are still reported.
- `read` returns a schema-version-1 envelope (content read or extract read) in every output mode. `--with-images-summary`, `--no-gfm`, and `--keep-img-data-url` are passed through to the Provider request. `--max-chars` is ignored on extract reads; `--full-envelope` is silently deprecated.
- Vision tool calls automatically retry transient 5xx/network errors (default: 2 retries). Configure with `ZAI_MCP_VISION_RETRY_COUNT` (or `ZAI_MCP_RETRY_COUNT` for all tools).
- Tool discovery can be cached to speed `tools`/`tool`/`doctor` (default: on, 24h TTL). The cache shares the unified root with the response cache; configure both via `SCOUTLINE_CACHE`, `SCOUTLINE_CACHE_TTL_MS`, `SCOUTLINE_CACHE_SIZE_MB`, and `SCOUTLINE_CACHE_DIR` (legacy aliases `ZAI_MCP_TOOL_CACHE*`, `ZAI_MCP_CACHE_DIR`, and `ZAI_CACHE*` are accepted silently).
- The local cache lives at `~/.scoutline/` (`cache/` for responses, `tools/` for tool discovery) on every platform. Inspect, clear, or prune it with `scoutline cache stats`, `scoutline cache clear`, and `scoutline cache prune`. Prune deletes expired entries by their stored timestamp (`--older-than <24h|90m|30s|seconds>` replaces the TTL threshold; `--provider`/`--capability` narrow the response scan to v2 filenames — the tool cache is unpartitioned and is always scanned age-only).

## Repository Exploration (P6)

`scoutline repo search`, `scoutline repo read`, `scoutline repo tree`, and
`scoutline repo brief` participate in `--provider` selection. Z.AI
advertises the `repository-exploration` Capability and supplies it through
the Z.AI Repository Adapter. MiniMax and the other built-in Providers do not
advertise it; by default (0.11.0+) Scoutline emits a stderr notice and
auto-reroutes to Z.AI. Under `--no-fallback` the preflight surfaces
`UNSUPPORTED_CAPABILITY` for the selected non-supplier before descriptor
configuration, Adapter creation, credential resolution for use, cache
identity, or transport construction. Pass `--no-fallback` to restore
the previous strict single-provider behavior.

### Breaking data-mode migration (v0.2 → v1)

The `repo search`, `read`, `tree`, and `brief` successes return
**schema-version-1 structured values** in every output mode. This is an intentional breaking change from the v0.2 raw
Search/File strings and the depth-dependent raw Tree shape:

| Command | v0.2 (legacy, now obsolete) | v1 (current) |
| --- | --- | --- |
| `repo search` | Raw ZRead text with `<excerpt>` blocks | `{schemaVersion, repository, query, language, excerpts:[{text}], truncated, originalTextLength}` |
| `repo read` | Raw `<file_content>…</file_content>` body | `{schemaVersion, repository, path, content, truncated, originalContentLength}` |
| `repo tree` | `<structure>` block (depth 1 returned split/deep routes) | `{schemaVersion, repository, path, depth, snapshots:[{repository, path, entries:[{name, path, kind}]}]}` (structured at every depth, including depth 1) |
| `repo brief` | — (new command) | `{schemaVersion, repository, focus, coverage:{probes}, tree?, docs?, entryPoints?, files?:[{path, content, truncated, originalContentLength}], detected:{hasReadme, hasManifest, manifestKinds}}` (sections gated by `--focus`; `coverage` and `detected` always present) |

`data` mode emits the exact object above. `json` and `pretty` wrap it through
the standard success envelope. Text-oriented modes (`compact`, `markdown`,
`refs`, `tty`) fall back to the JSON value because the command supplies no
prose presentation override.

**Scripting impact:** any consumer parsing v0.2 raw ZRead text or the v0.2
split/deep `tree` shape must switch to the v1 structured fields. The raw
`scoutline.zai.*` namespace remains available for callers that need the
legacy grammar; it is not wrapped in the v1 envelope.

### Canonical repository paths

- Tree aliases omitted, empty, `/`, or `.` normalize to the root path `""`.
- File paths must be non-root; the root is invalid for `repo read`.
- Leading `./` and leading `/` are accepted on File; leading and trailing `/`
  are stripped and repeated `/` collapses on both.
- Actual `.`/`..` segments, backslashes, and ASCII control characters are
  rejected. Percent escapes (`%XX`) are never decoded — they remain literal.

### `--max-chars` (deterministic, local)

`--max-chars` is **never** a summarization model call. It is presentation
projection applied to the normalized result after caching.

- Absent, zero, or negative → no truncation.
- `repo read` → truncates `content` with the existing ellipsis rule; preserves
  the original length in `originalContentLength` and sets `truncated: true`.
- `repo search` → applies **one total budget** across `excerpts[].text` in
  Provider order; the final retained excerpt is truncated and later excerpts
  are omitted.
- `repo tree` → never character-limited.
- `repo brief` → forwarded verbatim to every search and read call (per-call
  budget); the tree probe is never character-limited.
- Metadata, JSON envelopes, and Tree snapshots are not part of the budget.

### Empty results

A future Provider Adapter may explicitly return an empty `excerpts`/`entries`
array when its own contract distinguishes a valid empty state. The Z.AI
Adapter requires at least one well-formed `<excerpt>` block per Search;
unwrapped text is malformed and surfaces as a normalized `API_ERROR 502`, not
as an empty success. An empty ZRead structure without `entries` is malformed
the same way.

### Cache continuity

Repository results use a new key shape
`v2.repository-exploration-<op>.<provider>.<credential-hash>.<request-hash>.json`.
The credential hash is supplied by the Adapter (full lowercase SHA-256 hex
digest of the active credential) and is never re-hashed by cache code.

Legacy v0.2 Z.AI cache entries remain readable **read-only**: their key is
reconstructed from the same Adapter-resolved credential using the exact v0.2
algorithm, and a valid hit is written through to the new key. Old files are
never rewritten, migrated, or deleted. `--no-cache` performs no reads or
writes. Injected credentials drive the fingerprint and legacy-key
construction; ambient `process.env` is never reread.

`repo brief` is never cached as a unit: its probes reuse the per-operation
entries above, so a warm re-run still invokes the Explorer operations but
makes no new provider transport calls, and still produces byte-identical
output.

### Errors and lifecycle

Encoded MCP error envelopes are recognized before success parsing:
`QUOTA_ERROR` 429 (exhausted ZRead quota, code `1310`) is terminal; transient
429/5xx and a malformed envelope retry once; auth 401/403 and other 4xx are
terminal. Raw Provider response bodies, reset metadata, and error texts are
discarded.

Transport close is best-effort and called once per constructed attempt. A
successful operation does not become a failure when close rejects or times
out, and a primary failure remains the outward failure when close also fails.
Cache hits construct and close no transport.

### Diagnostics inventory

`capabilityMatrix` is derived from descriptor metadata: for each advertised
capability, the providers that supply it (in descriptor order).
`repository-exploration` therefore lists only `zai` while still participating
in Provider selection. Doctor help names MiniMax as unsupported for `repo`.

### Non-goals

This release does not add MiniMax repository exploration, automatic
summarization, or dynamic Provider loading. The P5 specialized
Vision mappings remain independent and are not claimed complete
here. Provider fallback is always-on by default in this release
(see `Capability Matrix` above) — passing `--no-fallback` restores
the previous strict single-provider behavior for scripting or
cost-sensitive workflows.

## Reader (P7)

`scoutline read` participates in `--provider` selection. Z.AI, Tavily,
Exa, and Firecrawl advertise the `reader` Capability and supply it
through their respective Reader Adapters. MiniMax and Brave do not
advertise it; by default (0.11.0+) Scoutline emits a stderr notice and
auto-reroutes to the next eligible configured supplier. Under
`--no-fallback` the preflight surfaces `UNSUPPORTED_CAPABILITY` for the
selected non-supplier before descriptor configuration, Adapter
creation, credential resolution for use, cache identity, or transport
construction. Pass `--no-fallback` to restore the previous strict
single-provider behavior.

### Breaking data-mode migration (v0.2 → v1)

`scoutline read` returns **schema-version-1 structured values** in every
output mode. This is an intentional breaking change from the v0.2 raw content
string and the bare extract array:

| Read shape | v0.2 (legacy, now obsolete) | v1 (current) |
| --- | --- | --- |
| Content read (default) | Raw content string | `{schemaVersion, url, finalUrl, title, content, contentFormat, truncated, originalContentLength}` |
| Extract read (`--extract <mode>`) | Bare JSON array of items | `{schemaVersion, url, finalUrl, mode, items, truncated, originalItemCount}` |

`url` is exactly what the caller passed; `finalUrl` is the URL the operation
actually fetched, which differs only when a Provider-side rewrite occurred
(e.g. `gist.github.com/<id>` → `gist.github.com/<id>/raw`). The v0.2 stderr
rewrite notice is gone — the signal now lives in `finalUrl`.

The four `--extract` modes (`code`, `links`, `tables`, `headings`) and the
shape of each item are unchanged from v0.2. Only the outer envelope changed
(bare array → schema-versioned object with `items`).

#### Output-mode behavior

| Mode | Content read | Extract read |
| --- | --- | --- |
| `data` | The content-read envelope object | The extract-read envelope object |
| `json` | `{success: true, data: <envelope>, timestamp}` (indent 0) | same |
| `pretty` | `{success: true, data: <envelope>, timestamp}` (indent 2) | same |
| `compact` | The `content` string directly | JSON fallback (the envelope object) |
| `markdown` | The `content` string directly | JSON fallback |
| `refs` | The `content` string directly | JSON fallback |
| `tty` | The `content` string directly | JSON fallback |

`compact`, `markdown`, `refs`, and `tty` exist to give operators a prose form
for human reading. A content read supplies one (the page body). An extract
read does not — extracted items are data, not prose — so those modes fall
back to JSON. This is the deliberate asymmetry from `repo`, whose results are
always structured data.

**Scripting impact:** any consumer that did `scoutline read URL > file.md`,
`scoutline read URL | jq -r .content`, or `scoutline read URL --extract code |
jq -c .[]` against v0.2 output must switch to the v1 envelope. `--max-chars`
still truncates the content-read `content`; it is **ignored on extract reads**
(extract reports `originalItemCount` instead). The deprecated
`--full-envelope` flag is silently accepted and ignored — the envelope is
always returned at v1.

### URL rewrite as `finalUrl`

A Provider-side URL rewrite (today: gist URLs to their raw form) is recorded
as `finalUrl` in the v1 result. The rewrite is idempotent on URLs already
ending in `/raw` and preserves fragments. The v0.2 stderr notice is removed.

### Cache namespace

Reader results share the partitioned cache namespace and use the
`reader-fetch` operation suffix:

```text
v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json
```

The Adapter resolves its credential once. The canonical request URL is the
**rewritten** URL so two requests that normalize to the same fetched URL share
one cache entry. Legacy v0.2 Z.AI entries are reconstructed from the same
Adapter-resolved credential using the exact v0.2 args-order algorithm and
remain read-only; a valid hit is written through to the new key; legacy files
are never migrated, rewritten, or deleted. `--no-cache` performs no reads or
writes. Injected credentials drive the fingerprint and legacy-key
construction; ambient `process.env` is never reread.

### Errors and lifecycle

Encoded MCP error envelopes are recognized before success parsing. The same
taxonomy that governs `repo` applies: exhausted WebReader quota (code `1310`
or explicit exhausted-limit meaning) surfaces as a normalized `QUOTA_ERROR`
429 and is terminal; transient 429/5xx and a malformed envelope retry once;
auth 401/403 and other 4xx are terminal. Raw Provider body, reset metadata,
and error-text strings are discarded. Transport close is best-effort and
called once per constructed attempt; a close failure never masks a primary
result. Cache hits construct and close no transport.

### Diagnostics inventory

`capabilityMatrix` is derived from descriptor metadata: for each advertised
capability, the providers that supply it. `reader` therefore lists only
`zai` while still participating in Provider selection, and Doctor help names
MiniMax as unsupported for `read`.

### Non-goals

This release does not add a MiniMax Reader Adapter, automatic summarization,
removal of the deprecated `--full-envelope` flag, or a future `--max-items`
truncation policy for extract reads.

## Contributing

See [CONTRIBUTING.md](https://github.com/vikasagarwal101/scoutline/blob/main/CONTRIBUTING.md) for development setup and guidelines.

## Performance

Benchmark tool discovery (cache on/off):

```bash
node scripts/bench-tools.mjs
```

## License

MIT - see [LICENSE](https://github.com/vikasagarwal101/scoutline/blob/main/LICENSE).

## Links

- [GitHub Repository](https://github.com/vikasagarwal101/scoutline)
- [Documentation](https://github.com/vikasagarwal101/scoutline/tree/main/docs)