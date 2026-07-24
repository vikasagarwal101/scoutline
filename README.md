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
- **Provider selection** — Run shared capabilities through Z.AI, MiniMax, Tavily, Exa, or Brave

## Quick Start

```bash
export Z_AI_API_KEY="your-api-key"

npx scoutline --help
npx scoutline search "React 19 new features" --count 5
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
```

Get your Z.AI API key at: https://z.ai/manage-apikey/apikey-list

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

Shared commands accept `--provider <zai|minimax|tavily|exa|brave>`. Resolution precedence:

1. Explicit `--provider` flag
2. `SCOUTLINE_PROVIDER` environment variable
3. Default `zai`

```bash
scoutline --provider minimax search "React 19 features"
scoutline --provider tavily research "Rust async runtime comparison"
SCOUTLINE_PROVIDER=minimax scoutline quota
```

Selecting a provider that doesn't support a capability returns `UNSUPPORTED_CAPABILITY` with no fallback.

### Capability Matrix

| Capability | Z.AI | MiniMax | Tavily | Exa | Brave | Command |
|---|---|---|---|---|---|---|
| Search | Yes | Yes | Yes | Yes | Yes (web/news/video) | `scoutline search` |
| Reader | Yes | No | Yes | Yes | No | `scoutline read` |
| Crawl | No | No | Yes | No | No | `scoutline crawl` |
| Map | No | No | Yes | No | No | `scoutline map` |
| Research | No | No | Yes | Yes | No | `scoutline research` |
| Vision (interpret-image) | Yes | Yes | No | No | No | `scoutline vision analyze` |
| Quota | Yes | Yes | Yes | No | Yes (rate-limit window) | `scoutline quota` |
| Diagnostics | Yes | Yes | Yes | Yes | Yes | `scoutline doctor` |
| Repo exploration | Yes | No | No | No | No | `scoutline repo` |
| Raw tools | Yes | No | No | No | No | `scoutline tools` |
| Code Mode | Yes | No | No | No | No | `scoutline code` |

### Search Controls

`--topic <general|news|finance>` is accepted by all providers. Tavily passes it natively; Z.AI and MiniMax append a keyword to the query; Exa maps it to a category; Brave routes `news` to a dedicated news endpoint.

`--type <video>` is Brave-only (mutually exclusive with `--topic`).

`--domain` and `--recency` are honored by Z.AI, Tavily, Exa, and Brave (Brave maps `--domain` → `site:`, `--recency` → `freshness`). `--location` is Z.AI- and Brave-only (Brave → `country`); MiniMax rejects these controls.

`--content-size` is a deliberate per-provider overload: `high` maps to Z.AI `content_size`, Tavily `search_depth=advanced`, and Brave's LLM Context endpoint (extracted passages joined into summaries); Exa accepts it; MiniMax rejects it (`UNSUPPORTED_OPTION`).

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
