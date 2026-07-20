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

Shared commands (`search`, `vision`, `quota`, `doctor`, `repo`) accept a global
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

`scoutline search`, `scoutline vision`, `scoutline quota`, `scoutline doctor`,
and **`scoutline repo`** participate in Provider selection. `scoutline read`,
`scoutline tools`, `scoutline tool`, `scoutline call`, and `scoutline code`
accept the flag but ignore it; they remain Z.AI-only. MiniMax does not
currently advertise the repository-exploration Capability — selecting MiniMax
(explicitly or via `SCOUTLINE_PROVIDER`) for any `repo` subcommand returns
`UNSUPPORTED_CAPABILITY` before descriptor configuration, Adapter creation,
cache identity, or transport construction, with no Z.AI fallback.

## Capability Matrix

| Capability | Z.AI | MiniMax | Notes |
| --- | --- | --- | --- |
| `search` | Yes | Yes | MiniMax rejects domain/recency/content-size/location controls |
| `vision.interpret-image` (analyze) | Yes | Yes | Provider-specific media limits; uncached |
| `vision.ui-artifact` (ui-to-code) | Yes | Available | Live-attested; conformance-gated |
| `vision.extract-text` | Yes | Pending | Implemented, pending live conformance |
| `vision.diagnose-error` | Yes | Available | Live-attested; conformance-gated |
| `vision.diagram` | Yes | Pending | Implemented, pending live conformance |
| `vision.chart` | Yes | Pending | Implemented, pending live conformance |
| `vision.diff` (image diff) | Yes | No | Z.AI-only (never MiniMax-claimable) |
| `vision.video` | Yes | No | Z.AI-only (never MiniMax-claimable) |
| `quota` | Yes | Yes | Normalized `QuotaDashboard` (ADR-0001) |
| `diagnostics` (`doctor`) | Yes | Yes | Lists both Providers; probes configured |
| `read` (Reader) | Yes | No | Z.AI-only; accepts but ignores `--provider` |
| `repo search` / `repo read` / `repo tree` | Yes | **No** (UNSUPPORTED_CAPABILITY) | Participates in selection; only Z.AI supplies `repository-exploration` |
| `tools`, `tool`, `call` (Raw tools) | Yes | No | Z.AI-only; accepts but ignores `--provider` |
| `code` (Code Mode) | Yes | No | Z.AI-only; accepts but ignores `--provider` |

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

In the current release, `ui-artifact` and `diagnose-error` have offline
`pass`, live `pass`, and compiled attestations — they are **supported at
runtime** through MiniMax. The remaining three operations (`extract-text`,
`diagram`, `chart`) have offline `pass` and live `pending`; they are
**unsupported at runtime** through MiniMax. Selecting MiniMax explicitly
for one of these operations fails closed with `UNSUPPORTED_CAPABILITY`
before credentials, media, transport, cache, or any other Provider is
touched (FR-023, FR-024). There is **no automatic Z.AI fallback** for an
explicit MiniMax selection — call without `--provider minimax` (or unset
`SCOUTLINE_PROVIDER`) to route through Z.AI instead.

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

## Repository Exploration (P6)

`scoutline repo search`, `scoutline repo read`, and `scoutline repo tree`
participate in `--provider` selection. Z.AI advertises the
`repository-exploration` Capability and supplies it through the Z.AI
Repository Adapter. MiniMax does not advertise it; selecting MiniMax returns
`UNSUPPORTED_CAPABILITY` before descriptor configuration, Adapter creation,
credential resolution for use, cache identity, or transport construction
with no fallback to Z.AI.

### Breaking data-mode migration (v0.2 → v1)

The three `repo` successes return **schema-version-1 structured values** in
every output mode. This is an intentional breaking change from the v0.2 raw
Search/File strings and the depth-dependent raw Tree shape:

| Command | v0.2 (legacy, now obsolete) | v1 (current) |
| --- | --- | --- |
| `repo search` | Raw ZRead text with `<excerpt>` blocks | `{schemaVersion, repository, query, language, excerpts:[{text}], truncated, originalTextLength}` |
| `repo read` | Raw `<file_content>…</file_content>` body | `{schemaVersion, repository, path, content, truncated, originalContentLength}` |
| `repo tree` | `<structure>` block (depth 1 returned split/deep routes) | `{schemaVersion, repository, path, depth, snapshots:[{repository, path, entries:[{name, path, kind}]}]}` (structured at every depth, including depth 1) |

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

`sharedCapabilities` and `zaiOnlyCapabilities` are derived from descriptor
metadata (intersection across built-in Providers; Z.AI minus the union of
the others). `repository-exploration` is therefore `zaiOnlyCapabilities`
while still participating in Provider selection. Doctor help names MiniMax
as unsupported for `repo`.

### Non-goals

This release does not add MiniMax repository exploration, a Reader
migration, automatic summarization, dynamic Provider loading, or an implicit
Z.AI fallback for unsupported Providers. The P5 specialized Vision mappings
remain independent and are not claimed complete here.

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