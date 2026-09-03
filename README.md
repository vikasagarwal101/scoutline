<h1 align="center">Scoutline</h1>

<p align="center">
  A command-line field kit for investigating web, repository, and visual sources.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/scoutline"><img src="https://img.shields.io/npm/v/scoutline.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

> Independently maintained by Vikas Agarwal. See [CREDITS.md](CREDITS.md) for project attribution.

---

## Features

- **Search** — Real-time web search with domain, recency, and topic filtering
- **Reader** — Fetch and parse web pages to clean markdown
- **Crawl** — Multi-page website traversal with depth, breadth, and path filters
- **Map** — Discover URL structure without fetching page content
- **Research** — Asynchronous deep research with cited sources
- **Vision** — Analyze images, screenshots, diagrams, charts, and videos
- **Repo** — Search and read GitHub repository code
- **Tools** — MCP tool discovery, schemas, and raw calls
- **Code Mode** — TypeScript tool chaining for agent automation
- **Provider selection** — Run shared capabilities through Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, Jina AI, You.com, Linkup, or Spider.cloud

## Quick Start

```bash
export Z_AI_API_KEY="your-api-key"

npx scoutline@0.17.4 --help
npx scoutline@0.17.4 search "React 19 new features" --count 5
npx scoutline@0.17.4 vision analyze ./screenshot.png "What errors do you see?"
```

Get your Z.AI API key at: https://z.ai/manage-apikey/apikey-list

### Interactive setup (`scoutline init`)

Run `npx scoutline init` once to record API keys in
`~/.scoutline/config.json` (mode 0600). The wizard:

- offers to import a key already present in your environment;
- walks a provider checklist (Z.AI, MiniMax, Tavily, Exa, Brave,
  Firecrawl, Parallel AI, Perplexity, Jina AI, You.com, Linkup, and Spider.cloud — none pre-checked);
- validates each key with a single inline probe against an ephemeral
  environment (the candidate never touches disk until the final
  atomic write);
- asks the fallback preference (auto-reroute when the selected
  provider is unavailable);
- supports re-config (edit/add/remove a provider, change fallback,
  re-run full) and corrupt-config repair (backup + rewrite).

Non-interactive terminals are refused — set environment variables
instead, or run the wizard inside a real TTY. Editing a key resets
that provider's verification; `scoutline doctor` re-promotes it after
a successful probe.

### Using MiniMax

```bash
export MINIMAX_API_KEY="your-minimax-key"
npx scoutline@0.17.4 --provider minimax search "latest LLM benchmarks"
```

### Using Tavily (Search, Reader, Crawl, Map, Research)

```bash
export TAVILY_API_KEY="your-tavily-key"
npx scoutline@0.17.4 --provider tavily search "AI funding rounds" --topic news
npx scoutline@0.17.4 --provider tavily read https://example.com/
npx scoutline@0.17.4 --provider tavily crawl https://docs.example.com --depth 2
npx scoutline@0.17.4 --provider tavily research "Compare React vs Svelte for production"
```

Get your Tavily API key at: https://app.tavily.com

### Using Exa (Search, Reader, Research)

```bash
export EXA_API_KEY="your-exa-key"
npx scoutline@0.17.4 --provider exa search "latest AI research" --topic news
npx scoutline@0.17.4 --provider exa read https://example.com/
npx scoutline@0.17.4 --provider exa research "Compare Rust async runtimes"
```

Get your Exa API key at: https://dashboard.exa.ai

### Using Brave (Search — web, news, video)

```bash
export BRAVE_SEARCH_API_KEY="your-brave-key"
npx scoutline@0.17.4 --provider brave search "AI policy news" --topic news
npx scoutline@0.17.4 --provider brave search "rust async" --type video
npx scoutline@0.17.4 --provider brave search "large context topic" --content-size high
```

Brave is the only Provider that supports `--type video`. `--content-size high`
maps to Brave's LLM Context endpoint (extracted passages joined into summaries).
`--type` is mutually exclusive with `--topic`. Note: Brave recently shifted from
a pure free tier to $5 monthly metered credits.

### Using Firecrawl (Search, Reader, Crawl, Map)

```bash
export FIRECRAWL_API_KEY="your-firecrawl-key"
npx scoutline@0.17.4 --provider firecrawl search "AI funding rounds" --content-size high
npx scoutline@0.17.4 --provider firecrawl read https://example.com/
npx scoutline@0.17.4 --provider firecrawl crawl https://docs.example.com --limit 10
npx scoutline@0.17.4 --provider firecrawl map https://example.com/
```

Get your Firecrawl API key at: https://www.firecrawl.dev/signin

Firecrawl is credit-based. `--content-size high` on search returns richer
(markdown) summaries at +1 credit/result. Crawl is asynchronous and resumes
after Ctrl-C with no double-charge (state-file resume + reclaim-on-miss).
`--provider firecrawl research` is not supported (`UNSUPPORTED_CAPABILITY`).

### Using Parallel AI (Search, Reader, Research)

```bash
export PARALLEL_API_KEY="your-parallel-key"
npx scoutline@0.17.4 --provider parallel search "AI funding rounds" --topic news
npx scoutline@0.17.4 --provider parallel read https://example.com/
npx scoutline@0.17.4 --provider parallel research "Compare React vs Svelte for production"
```

Get your Parallel AI API key at: https://api.parallel.ai

### Using Perplexity (Search, Research)

```bash
export PERPLEXITY_API_KEY="your-perplexity-key"
npx scoutline@0.17.4 --provider perplexity search "latest AI research" --topic news
npx scoutline@0.17.4 --provider perplexity research "Compare Rust async runtimes"
```

Get your Perplexity API key at: https://www.perplexity.ai/settings/api

### Using Jina AI (Search, Reader, Research)

```bash
export JINA_API_KEY="your-jina-key"  # optional — keyless supported
npx scoutline@0.17.4 --provider jina search "AI policy news" --topic news
npx scoutline@0.17.4 --provider jina read https://example.com/
npx scoutline@0.17.4 --provider jina research "State of carbon capture 2025"
```

Get your Jina AI API key at: https://jina.ai/api-dashboard/

Jina AI supports keyless access (no API key required). Setting `JINA_API_KEY`
enables higher rate limits. The init wizard omits Jina when no key is
entered — keyless still works without any wizard configuration.

Deep-search streams can legitimately run for minutes; the client budget
defaults to 120 seconds. Raise it with `JINA_DEEPSEARCH_TIMEOUT`
(milliseconds) for long `jina research` runs.

### Using You.com (Search, Reader, Research)

```bash
export YDC_API_KEY="your-you-key"  # YOU_API_KEY also accepted
npx scoutline@0.17.7 --provider you search "AI policy news" --topic news
npx scoutline@0.17.7 --provider you read https://example.com/
npx scoutline@0.17.7 --provider you research "State of carbon capture 2025"
```

Get your You.com API key at: https://you.com/api

`YDC_API_KEY` is preferred; `YOU_API_KEY` is accepted as a lower-priority
alias. The key travels as an `X-API-Key` header and never appears in URLs,
cached files, or error messages. Search and reader hit `ydc-index.io`;
research hits `api.you.com`. The init wizard's You.com probe is billable.
You.com exposes no quota endpoint — `scoutline quota` reports no signal
for it.

### Using Linkup (Search, Reader, Research)

```bash
export LINKUP_API_KEY="your-linkup-key"
npx scoutline --provider linkup search "AI funding rounds" --topic news
npx scoutline --provider linkup read https://example.com/
npx scoutline --provider linkup research "Compare React vs Svelte for production"
```

Get your Linkup API key at: https://app.linkup.so

### Using Spider.cloud (Search, Reader, Crawl, Map)
```bash
export SPIDER_API_KEY="your-spider-key"
npx scoutline --provider spider search "AI funding rounds" --topic news
npx scoutline --provider spider read https://example.com/
npx scoutline --provider spider crawl https://example.com --limit 10
npx scoutline --provider spider map https://example.com
```
Get your Spider.cloud API key at: https://spider.cloud

## Installation

### As an Agent Skill

**OpenSkills** (universal — works with any AI coding agent):

```bash
npx openskills install vikasagarwal101/scoutline
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

Shared commands accept `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider>`. Resolution precedence:

1. Explicit `--provider` flag
2. `SCOUTLINE_PROVIDER` environment variable
3. Default `zai`

```bash
scoutline --provider minimax search "React 19 features"
scoutline --provider tavily research "Rust async runtime comparison"
SCOUTLINE_PROVIDER=minimax scoutline quota
```

Selecting a provider that doesn't support a capability auto-reroutes to the next eligible configured provider in registry order and emits a stderr notice (the default since 0.11.0). Pass `--no-fallback` (or set `SCOUTLINE_NO_FALLBACK=1`) to restore the previous strict `UNSUPPORTED_CAPABILITY` behavior for scripting or cost-sensitive workflows.

## Saved Artifacts (`--save` + `history`)

Any provider-backed command (`search`, `read`, `crawl`, `map`, `research`, `repo`, `vision`) can save its result as a durable, clean report — content plus a request id, nothing else — while stdout stays exactly what it would be without the flag:

```bash
scoutline search "rust vs go" --save ~/report.json          # master copy + export copy
scoutline search "rust vs go" --save --save-format markdown # master only, human-readable
```

Reports live in the artifact store (`~/.scoutline/artifacts/`, override with `SCOUTLINE_ARTIFACTS_DIR`) and are joined to their run metadata (provider routing, redacted flags, versions) by request id in `index.json`. Saving to an existing path is refused unless `--save-force` is passed (`FILE_ERROR`, detected before any provider call). `cache clear` and cache TTLs never touch saved artifacts.

```bash
scoutline history list --limit 5                    # newest saves, from the metadata log
scoutline history show 20260829T142233Z-7f3a        # metadata + report, joined
scoutline history stats                             # counts, bytes, span
```

### Search Fan-Out (multi-provider search)

For `search` only, one query can run across several providers in parallel and merge into a single deduplicated list ([ADR-0004](docs/adr/0004-multi-provider-search-fanout.md)). Activation tiers, highest precedence first:

1. `--provider tavily,exa` (comma list) or `--provider all` — fan-out on the listed providers; `all` expands to every configured search provider in registry order.
2. A single `--provider <id>` or `SCOUTLINE_PROVIDER` — single provider; an explicit pin, fan-out is ignored.
3. `scoutline config set fanout true` (no pin) — fan-out on `routing.search` when set, else every configured search provider. Default is **false**.
4. No pin and fan-out off — single provider via the standard selection order.

```bash
scoutline --provider tavily,exa search "rust async runtimes"
scoutline --provider all search "AI policy news"
scoutline config set fanout true    # standing preference (default off)
```

**Cost:** every search will bill ALL configured search providers — N arms = N billable calls (when `routing.search` is set, only the eligible routed providers — configured and search-capable — are billed; `config set fanout true` names exactly those). Arms run in parallel (one client each, pinned — no per-arm fallback); a provider that rejects a search control drops with a stderr notice and never fails the invocation. Results are deduplicated by canonical URL identity (scheme/host lowercased, default ports, fragments, trailing slashes, and `utm_*`/`fbclid` parameters removed — tracking names are matched after percent-decoding, the raw path and userinfo are preserved verbatim, and the original URLs are kept in output), ranked by cross-provider occurrences, and each result carries `mergedFrom` listing the providers that returned it. `--merge` composes with fan-out: every arm runs every sub-query and occurrences span the arms × sub-queries grid. Disable the standing switch with `scoutline config set fanout false`.

### Batch Manifest Runner (distribution by default)

`scoutline batch` executes a strict schema-v1 JSON manifest of capability
operations (`search`, `read`, `research`, `repo`, `vision`, `crawl`, `map`)
through a bounded worker pool — the same handlers a direct call uses, forced
to data mode, with per-operation notices and errors captured per result.
Stdout carries exactly one write: the summary envelope. `results[]` keeps
manifest order regardless of completion order.

**Provider distribution is the default.** Unpinned operations are assigned
round-robin across configured, capable providers per capability group, in
registry order. `routing.<capability>` preferences are ignored inside batch —
all eligible providers participate; pin an operation (manifest `provider`
field) or the whole batch (`--provider`) to opt out. Search fan-out is
suppressed inside batch: each operation runs on exactly its assigned
provider, and the runtime fallback chain still rescues a failing one.

```bash
scoutline batch manifest.json                        # distribute across providers
scoutline batch manifest.json --concurrency 2 --fail-fast
scoutline batch manifest.json --dry-run              # preview assignment; no transport
scoutline --provider tavily batch manifest.json      # pin the whole batch
cat manifest.json | scoutline batch -                # manifest on stdin
```

`--dry-run` resolves every assignment and runs the pre-dispatch gates
(configured + capability-advertised) without contacting any provider,
touching the cache, or writing per-op output files. Optional per-op `output`
paths write captured stdout via temp-file + rename; `--fail-fast` stops
scheduling after the first failure (unscheduled operations are recorded).

`scoutline vision batch` runs many media inputs through the same runner: a
single-directory glob (`.jpg .jpeg .png .webp .mp4 .mov .m4v .avi .webm
.wmv`; the extension infers `video` vs `analyze`) or a one-vision-op
manifest, `{filename}`/`{filepath}` prompt substitution, sanitized per-input
result files plus `summary.json` under `--out` (required for more than one
input; the directory is created if missing), and distribution across
eligible vision providers (`--concurrency` default 1).

### Capability Matrix

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina AI | You.com | Linkup | Spider.cloud | Command |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Search | Yes | Yes | Yes | Yes | Yes (web/news/video) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | `scoutline search` |
| Reader | Yes | No | Yes | Yes | No | Yes | Yes | No | Yes | Yes | Yes | Yes | `scoutline read` |
| Crawl | No | No | Yes | No | No | Yes (async) | No | No | No | No | No | Yes (sync) | `scoutline crawl` |
| Map | No | No | Yes | No | No | Yes | No | No | No | No | No | Yes | `scoutline map` |
| Research | No | No | Yes | Yes | No | No | Yes | Yes | Yes | Yes | Yes | No | `scoutline research` |
| Vision (interpret-image) | Yes | Yes | No | No | No | No | No | No | No | No | No | No | `scoutline vision analyze` |
| Quota | Yes | Yes | Yes | No | Yes (rate-limit window) | Yes (credits) | No | No | Yes (rate-limit telemetry, not spend) | No | Yes (credits) | Yes (credits) | `scoutline quota` |
| Diagnostics | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | `scoutline doctor` |
| Repo exploration | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline repo` |
| Raw tools | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline tools` |
| Code Mode | Yes | No | No | No | No | No | No | No | No | No | No | No | `scoutline code` |

### Search Controls

`--topic <general|news|finance>` is accepted by all providers. Tavily passes it natively; Z.AI, MiniMax, Parallel AI, Perplexity, Jina AI, You.com, Linkup, and Spider.cloud append a keyword to the query; Exa maps it to a category; Firecrawl maps `news` to a news source type; Brave routes `news` to a dedicated news endpoint.

`--type <video>` is Brave-only (mutually exclusive with `--topic`).

`--domain` and `--recency` are honored by Z.AI, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, and You.com (Brave maps `--domain` → `site:`, `--recency` → `freshness`; Parallel forwards both through `advanced_settings`; Perplexity forwards both as native search filters). Jina honors `--domain` (`X-Site`) but not `--recency`; Linkup honors both (`includeDomains`, `fromDate` date window); Spider.cloud honors both (`whitelist`, Google-style `tbs` filter). `--location` is honored by Z.AI, Brave (`country`), Parallel AI (`us` only), Jina (`gl`), You.com (`country`), Linkup (locale keyword appended to the query), and Spider.cloud (`country_code`); MiniMax rejects these controls.

`--content-size` is a deliberate per-provider overload: `high` maps to Z.AI `content_size`, Tavily `search_depth=advanced`, Brave's LLM Context endpoint (extracted passages joined into summaries), and Parallel AI's per-result excerpt budget; Exa accepts it; You.com maps it to an extraction mode (`full_page`/`highlights`); Firecrawl returns scraped markdown summaries (+1 credit/result); MiniMax and Jina reject it (`UNSUPPORTED_OPTION`); Linkup maps it to a `depth` search parameter (`high` -> `deep`); Spider.cloud pins the markdown `return_format` (the canonical payload is the observation).

## Usage

The CLI is self-documenting. Use `--help` at any level:

```bash
scoutline --help              # All commands
scoutline fetch --help        # Direct HTTP retrieval (GET/POST, @file, --md5, --out)
scoutline archive --help      # Wayback temporal index (cdx) and replay (get)
scoutline search --help       # Search options
scoutline read --help         # Reader options
scoutline crawl --help        # Crawl options
scoutline map --help          # Map options
scoutline research --help     # Research options
scoutline vision --help       # Vision commands
scoutline batch --help        # Batch manifest runner (distribution by default)
scoutline repo --help         # GitHub repo commands
scoutline doctor --help       # Provider diagnostics (--health for live probe)
scoutline quota --help        # Plan usage
scoutline cache --help        # Local cache inspection, clearing, and pruning
```

### Examples

```bash
# Evidentiary Direct Retrieval (no AI credentials required)
scoutline fetch https://api.github.com/repos/nodejs/node --md5
scoutline fetch https://example.com/api -X POST --data @payload.json -H "Content-Type: application/json"
scoutline fetch https://example.com/doc.pdf --pdf text --out extracted.txt

# Temporal Archival (Wayback Machine)
scoutline archive cdx https://example.com/ --from 20200101 --limit 5
scoutline archive get https://example.com/ --at 20210601000000 --raw

# Search
scoutline search "TypeScript best practices" --count 10
scoutline --provider tavily search "earnings call" --topic finance

# Reader
scoutline read https://docs.example.com/api
scoutline --provider tavily read https://example.com/

# Crawl
scoutline crawl https://docs.example.com --depth 2 --limit 20
scoutline crawl https://example.com --select-paths "/api/.*,/guide/.*"

# Map
scoutline map https://docs.example.com --depth 2

# Research (credit-intensive — 4-250 credits per request)
scoutline research "Compare React vs Svelte for enterprise apps"
scoutline research "State of carbon capture 2025" --model pro

# Vision
scoutline vision analyze ./image.png "Describe this"
scoutline vision diagnose-error ./error.png

# Repo
scoutline repo tree facebook/react
scoutline repo search vercel/next.js "app router"
scoutline repo brief facebook/react

# Diagnostics
scoutline doctor                      # full diagnostics
scoutline quota --all-providers       # every configured provider
scoutline cache stats                 # cache inventory
scoutline cache prune --older-than 24h   # delete cache entries older than 24h
```

## Output Format

Default output is **data-only JSON** for token efficiency. Use `--output-format` (`-O`) to switch:

| Mode | Behavior |
|---|---|
| `data` (default) | Raw JSON — no envelope |
| `json` | Envelope-wrapped: `{success, data, timestamp}` |
| `pretty` | Same as `json` with 2-space indent |
| `compact` | Condensed text (varies per command) |
| `markdown` | Formatted text for human reading |
| `refs` | Citation-style URLs only |

## JSON Error Envelope

When a command fails, Scoutline writes a JSON error envelope to stderr (data-only stdout is preserved). The shape is:

```json
{
  "success": false,
  "error": "Provider \"minimax\" does not support capability \"research\"",
  "code": "UNSUPPORTED_CAPABILITY",
  "help": "Use --provider <id> to select a Provider that supports this Capability, or remove --no-fallback to enable cross-Provider rerouting."
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `false` | Always `false` on errors |
| `error` | `string` | Human-readable error message |
| `code` | `string` | Stable error code (see table below) |
| `help` | `string?` | Actionable next-step suggestion. Present for `UNSUPPORTED_CAPABILITY` and other typed errors that carry guidance. |
| `statusCode` | `number?` | HTTP status code when applicable (e.g. `401` for `AUTH_ERROR`, `429` for `QUOTA_ERROR`) |

**Stable error codes:**

| Code | Meaning |
|---|---|
| `AUTH_ERROR` | Credential missing, invalid, or expired |
| `API_ERROR` | Provider API returned an error status |
| `CONFIGURATION_ERROR` | Configuration issue (exit code 3) |
| `QUOTA_ERROR` | Provider quota exhausted |
| `UNSUPPORTED_CAPABILITY` | Provider does not advertise the requested capability |
| `UNSUPPORTED_OPTION` | Provider does not support a specific option for a capability |
| `VALIDATION_ERROR` | Invalid command-line input |
| `TIMEOUT_ERROR` | Request timed out |
| `NETWORK_ERROR` | Network connectivity failure |
| `UNKNOWN_ERROR` | Generic catch-all for unclassified errors (plain `Error` instances, unknown values passed through `formatErrorOutput`) |
| `FILE_ERROR` | File or media I/O error |

**Backwards compatibility:** the `help` field is additive (added in 0.14.0). Scripts that parse the JSON envelope and ignore unknown fields are unaffected. The `code` field remains stable across releases.

## Notes

- **Research** is credit-intensive (4-250 credits). Ctrl-C preserves the in-flight task — re-running the same command resumes polling instead of creating a new one. No double charge.
- **Doctor** output is at `schemaVersion: 2` with a `capabilityMatrix` field listing which providers support each capability.
- **Cache** lives at `~/.scoutline/` (`cache/` for responses, `tools/` for tool discovery). Research state files live at `~/.scoutline/research/`. Inspect, clear, or prune with `scoutline cache stats` / `scoutline cache clear` / `scoutline cache prune`.
- `repo search` defaults to English. Use `--language zh` for Chinese.
- **Brave quota** reports a monthly rate-limit window (used/limit/remaining/%/reset) read from response headers, not spend or credits consumed. Brave uses metered billing, so it is **not** a budget signal — a prominent caveat prints to stderr.

## Repository Layout

```
├── docs/                   # User, contributor, and maintainer guides
├── packages/scoutline/     # npm package source
├── skills/scoutline/       # Agent skill (SKILL.md)
└── .claude-plugin/         # Claude Code marketplace config
```

## Documentation

Detailed guides in [docs/](docs/README.md):

- [Architecture](docs/architecture.md) — Provider boundaries, capability contracts, execution model
- [Configuration](docs/configuration.md) — Environment variables, cache settings
- [Development](docs/development.md) — Build, test, contribute
- [Troubleshooting](docs/troubleshooting.md)

## Development

```bash
cd packages/scoutline
npm install
npm run build
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
