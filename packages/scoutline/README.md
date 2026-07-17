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

- **Vision** - Analyze images, screenshots, diagrams, charts, videos using GLM-4.6V
- **Search** - Real-time web search with domain and recency filtering
- **Reader** - Fetch and parse web pages to markdown
- **Repo** - Search and read GitHub repository code via ZRead
- **Tools** - MCP tool discovery, schemas, and raw calls
- **Code Mode** - TypeScript tool chaining for agent automation
- **Provider selection** - Run shared capabilities through Z.AI or MiniMax Token Plan

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

Shared commands (`search`, `vision`, `quota`, `doctor`) accept a global
`--provider <zai|minimax>` flag. Resolution precedence:

1. Explicit `--provider <zai|minimax>` on the command line
2. `SCOUTLINE_PROVIDER` environment variable
3. Compatibility default `zai`

Examples:

```bash
# 1. Flag wins over everything
scoutline --provider minimax search "React 19 features"

# 2. Environment variable when no flag is supplied
export SCOUTLINE_PROVIDER=minimax
scoutline quota

# 3. Default Z.AI when nothing is supplied
scoutline search "TypeScript best practices"
```

Provider selection is **never** inferred from which credentials are present;
empty credentials leave the Provider unconfigured and shared capabilities will
fail with `AUTH_ERROR` or `CONFIGURATION_ERROR`. Unknown Provider IDs fail
fast with `VALIDATION_ERROR`.

`scoutline read`, `scoutline repo`, `scoutline tools`, `scoutline tool`,
`scoutline call`, and `scoutline code` accept the flag but ignore it; they
remain Z.AI-only in the base release.

## Capability Matrix

| Capability | Z.AI | MiniMax | Notes |
| --- | --- | --- | --- |
| `search` | Yes | Yes | MiniMax rejects domain/recency/content-size/location controls |
| `vision.interpret-image` (analyze) | Yes | Yes | Provider-specific media limits; uncached |
| `vision.ui-artifact` (ui-to-code) | Yes | Pending | Implemented, pending live conformance (see below) |
| `vision.extract-text` | Yes | Pending | Implemented, pending live conformance (see below) |
| `vision.diagnose-error` | Yes | Pending | Implemented, pending live conformance (see below) |
| `vision.diagram` | Yes | Pending | Implemented, pending live conformance (see below) |
| `vision.chart` | Yes | Pending | Implemented, pending live conformance (see below) |
| `vision.diff` (image diff) | Yes | No | Base-release Z.AI-only |
| `vision.video` | Yes | No | Base-release Z.AI-only |
| `quota` | Yes | Yes | Normalized `QuotaDashboard` (ADR-0001) |
| `diagnostics` (`doctor`) | Yes | Yes | Lists both Providers; probes configured |
| `read` (Reader) | Yes | No | Base-release Z.AI-only |
| `repo` (Repository exploration) | Yes | No | Base-release Z.AI-only |
| `tools`, `tool`, `call` (Raw tools) | Yes | No | Base-release Z.AI-only |
| `code` (Code Mode) | Yes | No | Base-release Z.AI-only |

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

In the current release every specialized operation has offline `pass` and
live `pending`, and no attestations are compiled in — so every
specialized operation is **unsupported at runtime**. The CLI surfaces
`UNSUPPORTED_CAPABILITY` and falls back to Z.AI (the Z.AI Provider
supports every operation in the base release).

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

# Quota - effective or all providers
scoutline quota                       # effective Provider
scoutline quota --all-providers       # every configured Provider

# Doctor - check setup
scoutline doctor                      # full diagnostics
scoutline doctor --no-tools           # metadata only, no transport
scoutline doctor --provider minimax   # MiniMax connectivity
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
Provider with its configured state, declared capabilities, and probe status.

## Notes

- `repo search` defaults to English results. Use `--language zh` for Chinese.
- `repo tree` supports `--path` (directory scope) and `--depth` (expand subtrees).
- `quota --all-providers` exits 1 if any configured Provider fails; successful
  entries are still reported.
- `doctor` exits 1 when the effective Provider is unconfigured or any
  configured probe fails; successful entries are still reported.
- `read` supports `--with-images-summary`, `--no-gfm`, and `--keep-img-data-url` for richer parsing control.
- Vision tool calls automatically retry transient 5xx/network errors (default: 2 retries). Configure with `ZAI_MCP_VISION_RETRY_COUNT` (or `ZAI_MCP_RETRY_COUNT` for all tools).
- Tool discovery can be cached to speed `tools`/`tool`/`doctor` (default: on, 24h TTL). Configure with `ZAI_MCP_TOOL_CACHE`, `ZAI_MCP_TOOL_CACHE_TTL_MS`, `ZAI_MCP_CACHE_DIR`.
- The response cache uses provider-partitioned keys; legacy `zai-cli` cache
  entries remain readable for Z.AI but are never migrated.

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