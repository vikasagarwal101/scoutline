---
name: scoutline
description: |
  Z.AI and MiniMax CLI providing:
  - Vision: image/video analysis, OCR, UI-to-code, error diagnosis (GLM-4.6V)
  - Search: real-time web search with domain/recency filtering
  - Reader: web page to markdown extraction (Provider Capability;
    Z.AI supplies it; MiniMax returns UNSUPPORTED_CAPABILITY without fallback)
  - Repo: GitHub code search and reading via ZRead (Provider Capability;
    Z.AI supplies it; MiniMax returns UNSUPPORTED_CAPABILITY without fallback)
  - Tools: MCP tool discovery, schemas, and raw calls (Z.AI)
  - Code: TypeScript tool chaining (Z.AI)
  - Provider selection: --provider <zai|minimax> for shared capabilities,
    repo, and read
  Use for visual content analysis, web search, page reading, or GitHub
  exploration. Requires Z_AI_API_KEY (default) or MINIMAX_API_KEY (with
  --provider minimax).
---

# Scoutline

Access Z.AI and MiniMax capabilities via `npx scoutline`. The CLI is
self-documenting — use `--help` at any level.

## Setup

```bash
# Z.AI (default Provider)
export Z_AI_API_KEY="your-api-key"

# OR MiniMax Token Plan
export MINIMAX_API_KEY="your-minimax-key"
export MINIMAX_REGION=global  # optional: defaults to "global"; alternative is "cn"
```

Get a Z.AI key at: https://z.ai/manage-apikey/apikey-list

## Provider Selection

Shared commands (`search`, `vision analyze`, `quota`, `doctor`), **`repo`**,
and **`read`** accept the global `--provider <zai|minimax>` flag. Precedence
is the flag, then the `SCOUTLINE_PROVIDER` environment variable, then the
default `zai`. Provider selection is never inferred from credentials.
Unknown values fail fast with `VALIDATION_ERROR`.

`tools`, `tool`, `call`, and `code` accept the flag but ignore it; they
remain Z.AI-only. MiniMax does not currently advertise the
`repository-exploration` or `reader` Capabilities — selecting MiniMax
(explicitly or via `SCOUTLINE_PROVIDER`) for any `repo` subcommand or for
`read` returns `UNSUPPORTED_CAPABILITY` before descriptor configuration,
Adapter creation, credential resolution for use, cache identity, or
transport construction, with no Z.AI fallback.

## Capability Matrix

| Capability | Z.AI | MiniMax | Command |
| --- | --- | --- | --- |
| Search | Yes | Yes (no domain/recency/content-size/location) | `scoutline search` |
| General single-image interpretation | Yes | Yes (JPG/JPEG/PNG/WebP ≤50 MiB) | `scoutline vision analyze` |
| Specialized Vision (UI-to-code, error diagnosis) | Yes | Available (live-attested; conformance-gated) | `scoutline vision ui-to-code`, `vision diagnose-error` |
| Specialized Vision (OCR, diagram, chart) | Yes | Pending (implemented, pending live conformance) | `scoutline vision extract-text`, `vision diagram`, `vision chart` |
| Two-image diff, video | Yes | No | `scoutline vision diff`, `vision video` |
| Quota (normalized) | Yes | Yes | `scoutline quota [--all-providers]` |
| Diagnostics | Yes | Yes | `scoutline doctor [--no-tools]` |
| Reader | Yes | **No** (UNSUPPORTED_CAPABILITY) | `scoutline read` |
| Repository exploration (search/read/tree) | Yes | **No** (UNSUPPORTED_CAPABILITY) | `scoutline repo ...` |
| Raw tools | Yes | No | `scoutline tools`, `tool`, `call` |
| Code Mode | Yes | No | `scoutline code` |

Vision results are never cached. Z.AI image limits are JPG/JPEG/PNG ≤5 MiB.
Search result count is applied locally after normalization and is never sent
to either Provider.

## Commands

| Command | Purpose | Help |
|---------|---------|------|
| vision | Analyze images, screenshots, videos | `--help` for 8 subcommands |
| search | Real-time web search | `--help` for filtering options |
| read | Fetch web pages as markdown | `--help` for format options |
| repo | GitHub code search and reading (Provider Capability) | `--help` for tree/search/read |
| quota | Provider-normalized plan usage dashboard | `--help` for `--all-providers` |
| tools | List available MCP tools (Z.AI) | |
| tool | Show tool schema | |
| call | Raw MCP tool invocation | |
| doctor | Provider-aware diagnostics | `--help` for `--no-tools` |
| cache | Inspect or clear the local cache | `--help` for stats/clear |
| code | TypeScript tool chaining (Z.AI) | |

## Quick Start

```bash
# Z.AI (default)
npx scoutline vision analyze ./screenshot.png "What errors do you see?"
npx scoutline search "React 19 new features" --count 5
npx scoutline read https://docs.example.com/api
npx scoutline read https://docs.example.com/api --with-images-summary --no-gfm
npx scoutline repo search facebook/react "server components"
npx scoutline repo search openai/codex "config" --language en
npx scoutline repo tree openai/codex --path codex-rs --depth 2
npx scoutline quota
npx scoutline doctor

# MiniMax Token Plan
npx scoutline --provider minimax search "AI policy news"
npx scoutline --provider minimax vision analyze ./diagram.png "Explain this"
npx scoutline --provider minimax quota
npx scoutline doctor --provider minimax

# All-Provider quota
npx scoutline quota --all-providers

# Local cache inspection and clearing
npx scoutline cache stats                 # inventory both subdirectories
npx scoutline cache clear                 # delete every file in cache/ and tools/
```

## Repository Exploration

`scoutline repo search`, `scoutline repo read`, and `scoutline repo tree`
participate in Provider selection. Z.AI advertises and supplies
`repository-exploration`; MiniMax does not, so selecting MiniMax returns
`UNSUPPORTED_CAPABILITY` with no fallback.

### v0.2 → v1 schema migration (breaking)

`repo` successes return **schema-version-1 structured values**, not the v0.2
raw ZRead text or depth-dependent raw Tree shape:

| Command | v1 schema |
| --- | --- |
| `repo search` | `{schemaVersion:1, repository, query, language, excerpts:[{text}], truncated, originalTextLength}` |
| `repo read` | `{schemaVersion:1, repository, path, content, truncated, originalContentLength}` |
| `repo tree` | `{schemaVersion:1, repository, path, depth, snapshots:[{repository, path, entries:[{name, path, kind}]}]}` (structured at every depth, including depth 1) |

Root Tree path is the empty string `""`. Default Search language is `"en"`
(pass `--language zh` for Chinese). Output modes for `repo` results:
`data` emits the raw schema-version-1 value as plain JSON with no
envelope; `json` and `pretty` emit the standard `{success, data,
timestamp}` envelope (indent 0 for `json`, indent 2 for `pretty`); and
the text-oriented modes (`compact`, `markdown`, `refs`, `tty`) receive
the JSON fallback — the same value as `data` mode — because `repo`
supplies no per-mode prose presentation override.

### `--max-chars` is deterministic and local

`--max-chars` never invokes a model — it is post-normalization projection:

- absent / zero / negative → no truncation;
- `repo search` → one total budget across `excerpts[].text`; the final
  retained excerpt is truncated, later excerpts are omitted;
- `repo read` → only `content` is truncated; `originalContentLength` and
  `truncated` describe the pre-truncation state;
- `repo tree` → never character-limited; metadata and JSON envelopes are not
  part of any budget.

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

`scoutline read` participates in Provider selection. Z.AI advertises and
supplies `reader`; MiniMax does not, so selecting MiniMax returns
`UNSUPPORTED_CAPABILITY` with no fallback.

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
returns a schema-version-1 `DiagnosticsReport` (which now includes a
one-line cache summary under `cache.summary`). Both are Provider-neutral.
`repo` returns the schema-version-1 objects documented above; the standard
envelope wraps them in `json`/`pretty` and the exact object is emitted in
`data`. `read` returns the schema-version-1 content-read or extract-read
envelope in `data`/`json`/`pretty`; text-oriented modes emit the `content`
string for content reads (prose) and fall back to JSON for extract reads
(data, not prose).

`cache stats` and `cache clear` return their raw JSON shape in `data`
mode (`{dir, enabled, ttlMs, sizeCapBytes, responseCache, toolCache}`
and `{responsesCleared, toolsCleared, bytesFreed}` respectively) and a
multi-line / one-line rendering in every text-oriented mode.

## Local Cache

The local cache lives at `~/.scoutline/` on every platform with two
sibling subdirectories: `cache/` (Provider responses) and `tools/`
(MCP tool discovery). Inspect or clear it with `scoutline cache stats`
and `scoutline cache clear`.

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