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
- **Provider selection** — Run shared capabilities through Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, or Jina AI

## Quick Start

```bash
export Z_AI_API_KEY="your-api-key"

npx scoutline --help
npx scoutline search "React 19 new features" --count 5
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
```

Get your Z.AI API key at: https://z.ai/manage-apikey/apikey-list

### Interactive setup (`scoutline init`)

Run `npx scoutline init` once to record API keys in
`~/.scoutline/config.json` (mode 0600). The wizard:

- offers to import a key already present in your environment;
- walks a provider checklist (Z.AI, MiniMax, Tavily, Exa, Brave,
  Firecrawl, Parallel AI, Perplexity, Jina AI — none pre-checked);
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
npx scoutline --provider minimax search "latest LLM benchmarks"
```

### Using Tavily (Search, Reader, Crawl, Map, Research)

```bash
export TAVILY_API_KEY="your-tavily-key"
npx scoutline --provider tavily search "AI funding rounds" --topic news
npx scoutline --provider tavily read https://example.com/
npx scoutline --provider tavily crawl https://docs.example.com --depth 2
npx scoutline --provider tavily research "Compare React vs Svelte for production"
```

Get your Tavily API key at: https://app.tavily.com

### Using Exa (Search, Reader, Research)

```bash
export EXA_API_KEY="your-exa-key"
npx scoutline --provider exa search "latest AI research" --topic news
npx scoutline --provider exa read https://example.com/
npx scoutline --provider exa research "Compare Rust async runtimes"
```

Get your Exa API key at: https://dashboard.exa.ai

### Using Brave (Search — web, news, video)

```bash
export BRAVE_SEARCH_API_KEY="your-brave-key"
npx scoutline --provider brave search "AI policy news" --topic news
npx scoutline --provider brave search "rust async" --type video
npx scoutline --provider brave search "large context topic" --content-size high
```

Brave is the only Provider that supports `--type video`. `--content-size high`
maps to Brave's LLM Context endpoint (extracted passages joined into summaries).
`--type` is mutually exclusive with `--topic`. Note: Brave recently shifted from
a pure free tier to $5 monthly metered credits.

### Using Firecrawl (Search, Reader, Crawl, Map)

```bash
export FIRECRAWL_API_KEY="your-firecrawl-key"
npx scoutline --provider firecrawl search "AI funding rounds" --content-size high
npx scoutline --provider firecrawl read https://example.com/
npx scoutline --provider firecrawl crawl https://docs.example.com --limit 10
npx scoutline --provider firecrawl map https://example.com/
```

Get your Firecrawl API key at: https://www.firecrawl.dev/signin

Firecrawl is credit-based. `--content-size high` on search returns richer
(markdown) summaries at +1 credit/result. Crawl is asynchronous and resumes
after Ctrl-C with no double-charge (state-file resume + reclaim-on-miss).
`--provider firecrawl research` is not supported (`UNSUPPORTED_CAPABILITY`).

### Using Parallel AI (Search, Reader, Research)

```bash
export PARALLEL_API_KEY="your-parallel-key"
npx scoutline --provider parallel search "AI funding rounds" --topic news
npx scoutline --provider parallel read https://example.com/
npx scoutline --provider parallel research "Compare React vs Svelte for production"
```

Get your Parallel AI API key at: https://api.parallel.ai

### Using Perplexity (Search, Research)

```bash
export PERPLEXITY_API_KEY="your-perplexity-key"
npx scoutline --provider perplexity search "latest AI research" --topic news
npx scoutline --provider perplexity research "Compare Rust async runtimes"
```

Get your Perplexity API key at: https://www.perplexity.ai/settings/api

### Using Jina AI (Search, Reader, Research)

```bash
export JINA_API_KEY="your-jina-key"  # optional — keyless supported
npx scoutline --provider jina search "AI policy news" --topic news
npx scoutline --provider jina read https://example.com/
npx scoutline --provider jina research "State of carbon capture 2025"
```

Get your Jina AI API key at: https://jina.ai/api-dashboard/

Jina AI supports keyless access (no API key required). Setting `JINA_API_KEY`
enables higher rate limits.

## Installation

### As an Agent Skill

**OpenSkills** (universal — works with any AI coding agent):

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

Shared commands accept `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina>`. Resolution precedence:

1. Explicit `--provider` flag
2. `SCOUTLINE_PROVIDER` environment variable
3. Default `zai`

```bash
scoutline --provider minimax search "React 19 features"
scoutline --provider tavily research "Rust async runtime comparison"
SCOUTLINE_PROVIDER=minimax scoutline quota
```

Selecting a provider that doesn't support a capability auto-reroutes to the next eligible configured provider in registry order and emits a stderr notice (the default since 0.11.0). Pass `--no-fallback` (or set `SCOUTLINE_NO_FALLBACK=1`) to restore the previous strict `UNSUPPORTED_CAPABILITY` behavior for scripting or cost-sensitive workflows.

### Capability Matrix

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Firecrawl | Parallel | Perplexity | Jina AI | Command |
|---|---|---|---|---|---|---|---|---|---|---|
| Search | Yes | Yes | Yes | Yes | Yes (web/news/video) | Yes | Yes | Yes | Yes | `scoutline search` |
| Reader | Yes | No | Yes | Yes | No | Yes | Yes | No | Yes | `scoutline read` |
| Crawl | No | No | Yes | No | No | Yes (async) | No | No | No | `scoutline crawl` |
| Map | No | No | Yes | No | No | Yes | No | No | No | `scoutline map` |
| Research | No | No | Yes | Yes | No | No | Yes | Yes | Yes | `scoutline research` |
| Vision (interpret-image) | Yes | Yes | No | No | No | No | No | No | No | `scoutline vision analyze` |
| Quota | Yes | Yes | Yes | No | Yes (rate-limit window) | Yes (credits) | No | No | Yes (rate-limit telemetry, not spend) | `scoutline quota` |
| Diagnostics | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | `scoutline doctor` |
| Repo exploration | Yes | No | No | No | No | No | No | No | No | `scoutline repo` |
| Raw tools | Yes | No | No | No | No | No | No | No | No | `scoutline tools` |
| Code Mode | Yes | No | No | No | No | No | No | No | No | `scoutline code` |

### Search Controls

`--topic <general|news|finance>` is accepted by all providers. Tavily passes it natively; Z.AI, MiniMax, Parallel AI, Perplexity, and Jina AI append a keyword to the query; Exa maps it to a category; Firecrawl maps `news` to a news source type; Brave routes `news` to a dedicated news endpoint.

`--type <video>` is Brave-only (mutually exclusive with `--topic`).

`--domain` and `--recency` are honored by Z.AI, Tavily, Exa, Brave, Firecrawl, and Parallel AI (Brave maps `--domain` → `site:`, `--recency` → `freshness`; Parallel forwards both through `advanced_settings`). Jina honors `--domain` (`X-Site`) but not `--recency`. `--location` is honored by Z.AI, Brave (`country`), Parallel AI (`us` only), and Jina (`gl`); MiniMax rejects these controls.

`--content-size` is a deliberate per-provider overload: `high` maps to Z.AI `content_size`, Tavily `search_depth=advanced`, Brave's LLM Context endpoint (extracted passages joined into summaries), and Parallel AI's per-result excerpt budget; Exa accepts it; Firecrawl returns scraped markdown summaries (+1 credit/result); MiniMax and Jina reject it (`UNSUPPORTED_OPTION`).

## Usage

The CLI is self-documenting. Use `--help` at any level:

```bash
scoutline --help              # All commands
scoutline search --help       # Search options
scoutline read --help         # Reader options
scoutline crawl --help        # Crawl options
scoutline map --help          # Map options
scoutline research --help     # Research options
scoutline vision --help       # Vision commands
scoutline repo --help         # GitHub repo commands
scoutline doctor --help       # Provider diagnostics
scoutline quota --help        # Plan usage
scoutline cache --help        # Local cache inspection and clearing
```

### Examples

```bash
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

# Diagnostics
scoutline doctor                      # full diagnostics
scoutline quota --all-providers       # every configured provider
scoutline cache stats                 # cache inventory
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
- **Cache** lives at `~/.scoutline/` (`cache/` for responses, `tools/` for tool discovery). Research state files live at `~/.scoutline/research/`. Inspect or clear with `scoutline cache stats` / `scoutline cache clear`.
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
