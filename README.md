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

- **Vision** - Analyze images, screenshots, diagrams, charts, videos using GLM-4.6V
- **Search** - Real-time web search with domain and recency filtering
- **Reader** - Fetch and parse web pages to markdown
- **Repo** - Search and read GitHub repository code via ZRead
- **Tools** - MCP tool discovery, schemas, and raw calls
- **Code Mode** - TypeScript tool chaining for agent automation

## Quick Start

```bash
export Z_AI_API_KEY="your-api-key"

npx scoutline --help
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
npx scoutline search "React 19 new features" --count 5
```

Get your API key at: https://z.ai/manage-apikey/apikey-list

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

## Usage

The CLI is self-documenting. Use `--help` at any level:

```bash
scoutline --help              # All commands
scoutline vision --help       # Vision commands
scoutline search --help       # Search options
scoutline repo --help         # GitHub repo commands
```

### Examples

```bash
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

# Doctor - check setup
scoutline doctor
scoutline doctor --no-vision
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

## Notes

- `repo search` defaults to English results. Use `--language zh` for Chinese.
- `repo tree` supports `--path` (directory scope) and `--depth` (expand subtrees).
- `tools`, `tool`, `call`, `doctor` accept `--no-vision` to speed startup when vision tools are not needed.
- `read` supports `--with-images-summary`, `--no-gfm`, and `--keep-img-data-url` for richer parsing control.
- Vision tool calls automatically retry transient 5xx/network errors (default: 2 retries). Configure with `ZAI_MCP_VISION_RETRY_COUNT` (or `ZAI_MCP_RETRY_COUNT` for all tools).
- Tool discovery can be cached to speed `tools`/`tool`/`doctor` (default: on, 24h TTL). Configure with `ZAI_MCP_TOOL_CACHE`, `ZAI_MCP_TOOL_CACHE_TTL_MS`, `ZAI_MCP_CACHE_DIR`.

## Repository Layout

```
├── docs/                # User, contributor, and maintainer guides
├── packages/scoutline/    # npm package source
├── skills/scoutline/      # Agent skill (SKILL.md)
└── .claude-plugin/      # Claude Code marketplace config
```

## Documentation

Detailed guides are available in [docs/](docs/README.md):

- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Product roadmap](docs/roadmap.md)
- [Standalone transition](docs/standalone-transition.md)

## Development

```bash
cd packages/scoutline
npm install
npm run build
npm test
node scripts/bench-tools.mjs
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT - see [LICENSE](LICENSE).

## Links

- [npm package](https://www.npmjs.com/package/scoutline)
- [Repository credits](CREDITS.md)
