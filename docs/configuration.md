# Configuration

Scoutline reads configuration from environment variables. Set the API key
before using any network-backed command:

```bash
export Z_AI_API_KEY="your-api-key"
```

`ZAI_API_KEY` remains accepted for compatibility, but new setups should use
`Z_AI_API_KEY`.

## On-Disk Config Foundation

Scoutline reserves `~/.scoutline/config.json` for its versioned, hand-editable
user configuration. Set `SCOUTLINE_CONFIG_DIR` to move this file to a different
root; cache-directory variables (`SCOUTLINE_CACHE_DIR`, `ZAI_MCP_CACHE_DIR`, and
`ZAI_CACHE_DIR`) do not affect its location.

The version-1 shape is:

```json
{
  "version": 1,
  "fallbackEnabled": true,
  "hintShown": false,
  "providers": {
    "zai": {
      "apiKey": "...",
      "onboarded": true,
      "verification": {
        "status": "verified",
        "checkedAt": 1786000060000
      }
    }
  }
}
```

Supported provider IDs are `zai`, `minimax`, `tavily`, `exa`, `brave`,
`firecrawl`, `parallel`, `perplexity`, `jina`, `you`, `linkup`, and
`spider`. Unknown IDs are ignored
with a warning, and blank API keys are
treated as absent. Malformed files fail as corrupt configuration; unsupported
versions require a Scoutline upgrade. Writes use a private (`0600`) temporary
file followed by atomic replacement.

## File-Configured API Keys

A provider API key stored under `providers.<id>.apiKey` in `config.json`
flows to every command — both the shared commands (`search`, `read`,
`crawl`, `map`, `research`, `repo`, `vision`, `doctor`, `quota`) and the
raw Z.AI command families (`tools`, `tool`, `call`, `code`) — through the
real provider descriptor and handler boundary. This means a key
configured solely in the file — with no corresponding environment
variable — is sufficient to run any command, including the raw MCP tool
discovery and Code Mode paths that previously read credentials from
ambient `process.env`.

The on-disk response cache also fingerprints against the resolved
credential: a file-only Z.AI key produces a different cache namespace
than an environment-variable key with a different value, so cache
entries never collide across credentials. Existing cache entries
written under an environment-variable key remain valid until they
expire or are cleared; **migration of those entries to the new
credential view is deferred** (see `docs/roadmap.md` "Cache-entry
migration across credential sources"). Only the credential source
changes; the SHA-256 / filename algorithm is unchanged.

Precedence (highest first):

1. **`Z_AI_API_KEY`** (or the matching canonical env var for the provider)
2. **`ZAI_API_KEY`** (alias; accepted but lower priority than the canonical name)
3. **File key** (`providers.<id>.apiKey` in `config.json`)

Environment variables always override file keys. If a provider is already
configured through the environment (primary or alias), the file key for that
provider is not used. Whitespace-only values in either source are treated as
absent.

`process.env` is never mutated. The merged view is built fresh per
invocation and threaded through the handler boundary — including into
the raw Z.AI clients (`ZaiMcpClient`, `ZaiCodeModeClient`) and the cache
key builder. File keys are redacted at every outward boundary (output,
errors, diagnostics, quota failures, and cached metadata) exactly like
environment-variable keys.

Users without a `config.json` see byte-for-byte identical behavior to the
previous release — the environment-variable path is unchanged.

## Fallback Preference

The `fallbackEnabled` field in `config.json` controls provider fallback at
runtime. Provider fallback is resolved as:

1. **Invocation opt-out**: `--no-fallback` flag or `SCOUTLINE_NO_FALLBACK=1`
   environment variable — either disables the cross-provider candidate loop.
2. **`config.fallbackEnabled`**: the value from `config.json` (set by the
   onboarding wizard or hand-edited). `false` narrows the executor to the
   effective provider only.
3. **Default `true`**: the 0.11.0 always-on contract.

This makes the wizard's onboarding answer effective at runtime. An absent
`fallbackEnabled` field defaults to `true`.

## Routing Table

The optional `routing` key in `config.json` sets a standing per-capability
provider preference:

```json
{
  "version": 1,
  "routing": {
    "search": ["tavily", "brave"],
    "crawl": ["firecrawl"]
  }
}
```

When no explicit `--provider` / `SCOUTLINE_PROVIDER` pin exists, the first
configured-and-capable provider in the routed list is selected for that
capability — routing is an **instruction, not a hint**: it wins over quota
ranking. Routing never reduces availability (no eligible routed provider →
the existing quota-ranked path runs unchanged), and it routes only the
*first pick*: the runtime fallback chain stays registry-ordered.

**Validation is lenient at load time**: unknown provider ids
(`UNKNOWN_PROVIDER` warning) and unknown capability keys
(`UNKNOWN_CAPABILITY` warning) are dropped with a stderr warning; a broken
routing table never prevents config load. **Known trade-off:** an older
binary that rewrites the config drops the key entirely (older `parseConfig`
rebuilds from known fields only) — accepted over a schema-version bump,
which would hard-fail older binaries.

Set it interactively (`scoutline init` → re-config → "Edit routing table")
or scriptably:

```bash
scoutline config set routing.search tavily,brave   # STRICT: typos fail, not drop
scoutline config unset routing.search
```

## `config` Command Family

`scoutline config get [key]` / `set <key> <value>` / `unset <key>` is the
non-TTY settings surface (dotted paths: `routing`, `routing.<capability>`,
`fallbackEnabled`, read-only `providers.<id>`). Behavior:

- **`get` is always redacted** — credential values are masked by value match
  and by credential field name, so a file-stored API key is never printable
  in any output mode.
- **`set` is strict, deliberately asymmetric with load-time leniency**: an
  explicit single-value command must not silently store something different
  than typed, so `config set routing.search tavlly` fails with
  `VALIDATION_ERROR` (exit 1) naming the accepted provider list.
- **Credential paths refuse `set` outright** (`providers.<id>.apiKey` →
  `VALIDATION_ERROR` pointing at `scoutline init` / environment variables);
  API keys never belong in command arguments.
- Writes are atomic read-modify-write with a round-trip re-parse guarantee
  and take effect on the next command invocation.

## Provider Selection

Shared commands (`search`, `vision`, `quota`, `doctor`), **`repo`**,
**`read`**, **`crawl`**, **`map`**, and **`research`** accept the global
`--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider>` flag. When the flag
is omitted the value of the `SCOUTLINE_PROVIDER` environment variable is
consulted; when neither is supplied Scoutline falls back to the compatibility
default `zai`.

Resolution precedence (highest first):

1. `--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider>` on the command line
2. `SCOUTLINE_PROVIDER`
3. `zai` (default)

Provider selection is never inferred from which credentials happen to be
present. Unknown or empty values fail fast with `VALIDATION_ERROR` before any
Provider invocation.

`scoutline tools`, `scoutline tool`, `scoutline call`, and `scoutline code`
accept the flag but ignore it; they continue to use Z.AI and do not validate
the supplied value.

Provider fallback is **always-on** (0.11.0+). When the selected provider
does not supply the capability (for example, MiniMax does not advertise
`repository-exploration` or `reader`) or fails at runtime, scoutline
emits a stderr notice and silently tries the next eligible provider in
registry order `[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider]`. The
selected provider is still the *first* one tried, so the user-visible
behavior is the same when the pin works; the fallback only changes
what happens when it does not. See
[`docs/adr/0002-provider-fallback.md`](adr/0002-provider-fallback.md)
for the rationale and the accepted async double-charge risk on
`crawl` / `map` / `research`.

To restore the previous strict single-provider behavior, opt out with
the global `--no-fallback` flag or the `SCOUTLINE_NO_FALLBACK=1`
environment variable. Under the kill-switch the candidate plan is
reduced to the effective provider only and the **same** preflight
(capability → configuration → adapter handle) runs on it, so an
incapable effective throws `UNSUPPORTED_CAPABILITY` (exit 1) and an
unconfigured effective throws `CONFIGURATION_ERROR` (exit 3) before
any adapter work. This preserves the documented
capability-before-configuration ordering for strict workflows.

```bash
# 1. Flag wins
scoutline --provider minimax search "React 19 features"

# 2. Environment variable when no flag is supplied
export SCOUTLINE_PROVIDER=minimax
scoutline quota

# 3. Default Z.AI when nothing is supplied
scoutline search "TypeScript best practices"

# Default (0.11.0+): repo auto-reroutes to Z.AI when MiniMax is selected
scoutline repo search facebook/react "server components"
scoutline --provider minimax repo search owner/repo query  # auto-reroutes to zai; stderr notice

# Default (0.11.0+): read auto-reroutes to the next eligible reader supplier
scoutline read https://example.com
scoutline --provider minimax read https://example.com      # auto-reroutes; stderr notice

# Strict: opt out of fallback (matches 0.10.x error codes)
scoutline --no-fallback --provider minimax repo search owner/repo query
scoutline --no-fallback --provider minimax read https://example.com
```

## Core Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AI_API_KEY` | Required for Z.AI | Z.AI API key. |
| `ZAI_API_KEY` | Alias for `Z_AI_API_KEY` | Compatibility alias. |
| `Z_AI_MODE` or `PLATFORM_MODE` | `ZAI` | Selects `ZAI` or `ZHIPU` base URLs. |
| `Z_AI_BASE_URL` | Mode-specific URL | Overrides the API base URL. |
| `Z_AI_TIMEOUT` | `30000` | Request timeout in milliseconds. |
| `Z_AI_VISION_MODEL` | `glm-5v-turbo` | Vision model name. |
| `Z_AI_TEMPERATURE` | `0.8` | Vision generation temperature. |
| `Z_AI_TOP_P` | `0.6` | Vision generation top-p value. |
| `Z_AI_MAX_TOKENS` | `32768` | Vision response token limit. |
| `SCOUTLINE_PROVIDER` | (none) | Selects the effective Provider (`zai`, `minimax`, `tavily`, `exa`, `brave`, `firecrawl`, `parallel`, `perplexity`, `jina`, `you`, `linkup`, or `spider`) for shared capabilities. |
| `SCOUTLINE_NO_FALLBACK` | (unset) | When set to a non-empty value, restores the strict single-provider, fail-loud behavior for shared capabilities — `--no-fallback` on the CLI is the per-invocation equivalent. |

## MiniMax Token Plan Settings

The MiniMax Adapter is configured through three MiniMax-specific environment
variables. Scoutline does not read `~/.mmx/config.json`, reuse `mmx` OAuth
state, or persist MiniMax credentials anywhere on disk.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MINIMAX_API_KEY` | Required for MiniMax | MiniMax Token Plan API key. |
| `MINIMAX_REGION` | `global` | Selects the MiniMax region. Accepted values: `global`, `cn`. |
| `MINIMAX_BASE_URL` | Region URL | Absolute HTTPS override for the MiniMax endpoint. Overrides the region URL for every MiniMax operation. |

Region base URLs:

| Region | Base URL |
| --- | --- |
| `global` | `https://api.minimax.io` |
| `cn` | `https://api.minimaxi.com` |

Rules:

- `MINIMAX_API_KEY` is required and non-empty. Whitespace-only is invalid.
- `MINIMAX_REGION` defaults to `global` when unset. Empty or unknown values
  are invalid, not absent.
- `MINIMAX_BASE_URL` must be an absolute HTTPS URL. Exactly one trailing slash
  is removed.
- An explicit `MINIMAX_BASE_URL` overrides the region URL for Search,
  Vision, quota, and diagnostics.
- MiniMax environment names do not appear in shared `lib/config.ts`. They
  live exclusively under `providers/minimax/`.
- Scoutline does not invoke the `mmx` executable or require a global
  installation.

```bash
export MINIMAX_API_KEY="your-minimax-key"
export MINIMAX_REGION=cn             # optional: defaults to "global"
export MINIMAX_BASE_URL=https://api.example.test   # optional: HTTPS override

scoutline --provider minimax search "AI policy"
scoutline --provider minimax quota
scoutline doctor --provider minimax
```

## Brave Search Settings

The Brave Adapter is configured through Brave-specific environment variables.
Scoutline does not persist Brave credentials anywhere on disk.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` | Required for Brave | Brave Search API key (sent as the `X-Subscription-Token` header). |
| `BRAVE_TIMEOUT` | `30000` | Request timeout in milliseconds. |

Rules:

- `BRAVE_SEARCH_API_KEY` is required and non-empty. Whitespace-only is
  treated as absent; a missing credential for the effective Provider fails
  with `CONFIGURATION_ERROR` (`exit 3`).
- Brave has no `/usage` endpoint. Quota is read from `X-RateLimit-*`
  response headers on a 1-query probe and surfaces the monthly rate-limit
  window (used/limit/remaining/%/reset). This is a rate-limit window, **not**
  spend or credits consumed — Brave uses metered billing, so it is not a
  budget signal. A prominent caveat prints to stderr (and appears in the
  JSON output's `warnings` field).

> **Operational note:** Brave recently shifted from a pure free tier to $5
> monthly metered credits (a saved card is now billable).

```bash
export BRAVE_SEARCH_API_KEY="your-brave-key"
export BRAVE_TIMEOUT=30000            # optional: 30s default

scoutline --provider brave search "AI policy"
scoutline --provider brave search "rust talks" --type video
scoutline --provider brave quota
scoutline doctor --provider brave
```

## Firecrawl Settings

The Firecrawl Adapter is configured through environment variables. Firecrawl
is credit-based (quota unit `"credits"`), so costs differ from the
request-based providers.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | Required for Firecrawl | Firecrawl API key (`fc-`-prefixed). |
| `FIRECRAWL_TIMEOUT` | `30000` (ms) | Per-request client timeout. |
| `FIRECRAWL_CRAWL_POLL_INTERVAL_MS` | `2000` (ms) | Async-crawl poll interval. |

Rules:

- `FIRECRAWL_API_KEY` is required and non-empty. Whitespace-only is invalid.
- The endpoint is fixed to `https://api.firecrawl.dev` (v2 exclusively; no
  `/v1/` shim).
- `proxy:"basic"` is pinned on every scrape and crawl (avoids Firecrawl's
  default `auto` silently retrying with the 5-credit enhanced proxy). It
  cannot be overridden.
- Firecrawl bills per credit: ~1 per scrape, per-page crawl, and +1 per
  search result at `--content-size high`. The local response cache fully
  avoids charges on cache hits (distinct from Firecrawl's server-side cache,
  which still bills).
- Async crawl resumes after Ctrl-C via a state file under
  `~/.scoutline/crawl/`; a lost create-POST is reclaimed via
  `GET /v2/crawl/active` so a re-run polls the in-flight job instead of
  creating (and charging) a second one.
- `FIRECRAWL_API_KEY` is redacted in all output. The bare `fc-` prefix is
  intentionally NOT regex-matched (too short — it false-positives on prose
  like "FC-04"); the key value is redacted wherever it appears.

```bash
export FIRECRAWL_API_KEY="your-firecrawl-key"
export FIRECRAWL_TIMEOUT=45000               # optional: per-request timeout

scoutline --provider firecrawl search "AI news" --content-size high
scoutline --provider firecrawl crawl https://docs.example.com --limit 10
scoutline quota --provider firecrawl
scoutline doctor --provider firecrawl
```

## You.com Settings

The You.com Adapter is configured through one canonical environment
variable plus a legacy alias. Every request authenticates with the
`X-API-Key` header.

| Variable | Default | Purpose |
| --- | --- | --- |
| `YDC_API_KEY` | (none) | Required for You.com. You.com API key. |
| `YOU_API_KEY` | (none) | Compatibility alias; accepted but lower priority than `YDC_API_KEY`. |

- `YDC_API_KEY` (or `YOU_API_KEY`) is required and non-empty. Whitespace-only
  values are treated as absent.
- The key is redacted in all output, exactly like every other provider
  credential.
- Search and reader requests hit `https://ydc-index.io`; research requests
  hit `https://api.you.com`.
- You.com advertises no `quota` capability: quota ranking treats it as
  always-unknown and `scoutline quota` reports no signal for it.
- `scoutline doctor --provider you` sends one live `/v1/search` request with
  `count: 1`. The probe is billable. `init` discloses the cost before it runs.

```bash
export YDC_API_KEY="your-you-key"

scoutline --provider you search "AI policy news" --topic news
scoutline --provider you read https://example.com/
scoutline --provider you research "State of carbon capture 2025"
```

## Linkup Settings

The Linkup Adapter is configured through one environment variable. Every
request authenticates against `https://api.linkup.so` with an
`Authorization: Bearer` header.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LINKUP_API_KEY` | (none) | Required for Linkup. Linkup API key. |

- `LINKUP_API_KEY` is required and non-empty. Whitespace-only values are
  treated as absent.
- The key is redacted in all output, exactly like every other provider
  credential.
- Linkup supplies Search, Reader, Research, Quota, and Diagnostics. Search
  controls map to `includeDomains`, a `fromDate`/`toDate` UTC recency
  window, a `depth` parameter for content size, and query-keyword appends
  for topic/location; `--type` is rejected before any I/O.
- Reader fetches rendered markdown (`renderJs` defaults to on) and rejects
  every reader control with no Linkup wire equivalent (`--format text`,
  `--no-images`, and the Z.AI-only options) with `UNSUPPORTED_OPTION`.
- Research runs the async submit/poll lifecycle with crash-safe job state,
  so an interrupted run resumes the paid task instead of double-charging.
- Quota reports the credit balance from `GET /v1/credits/balance`. The
  authority is always-unknown: credits remaining with an unknown limit, so
  no percentage is ever fabricated.

```bash
export LINKUP_API_KEY="your-linkup-key"

scoutline --provider linkup search "AI policy news"
scoutline --provider linkup read https://example.com/
scoutline --provider linkup research "State of carbon capture 2025"
scoutline --provider linkup quota
scoutline doctor --provider linkup
```

## Spider.cloud Settings

The Spider.cloud Adapter is configured through one environment variable.
Every request authenticates against `https://api.spider.cloud` with an
`Authorization: Bearer` header.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPIDER_API_KEY` | (none) | Required for Spider.cloud. Spider.cloud API key. |

- `SPIDER_API_KEY` is required and non-empty. Whitespace-only values are
  treated as absent.
- The key is redacted in all output, exactly like every other provider
  credential.
- Spider.cloud supplies Search, Reader, Crawl, Map, Quota, and Diagnostics.
  Search controls map to a domain `whitelist`, Google-style `tbs` recency
  filters, `country_code` for location, and a topic keyword appended to
  the query; `--type` is rejected before any I/O.
- Reader POSTs the `/scrape` endpoint and rejects the Z.AI-only reader
  options with `UNSUPPORTED_OPTION` instead of silently dropping them.
- Crawl is a synchronous one-shot `POST /crawl` (no job file, no polling)
  that keeps only `status === 200` pages with non-empty content. Map uses
  `POST /links` and deduplicates discovered URLs.
- Quota reports credit remaining from `GET /data/credits`. The authority
  is always-unknown: credits remaining with an unknown limit, so no
  percentage is ever fabricated. The diagnostics probe costs no credit.

```bash
export SPIDER_API_KEY="your-spider-key"

scoutline --provider spider search "AI policy news"
scoutline --provider spider read https://example.com/
scoutline --provider spider crawl https://docs.example.com --limit 10
scoutline --provider spider map https://docs.example.com
scoutline --provider spider quota
scoutline doctor --provider spider
```

## Output Modes

The default is data-only output for pipelines and agents. When stdout is interactive, the CLI automatically uses a TTY-oriented presentation unless an explicit mode is supplied.

```bash
scoutline --output-format json search "MCP protocol"
scoutline -O markdown search "MCP protocol"
scoutline --pretty-output read https://example.com
```

Use `scoutline --help` for the complete list of output aliases and command-specific format support.

## Vision MCP

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AI_VISION_MCP` | enabled | Set to `0` or `false` to disable the vision server. |
| `Z_AI_VISION_MCP_COMMAND` | `npx` | Command used to start the vision MCP server. |
| `Z_AI_VISION_MCP_ARGS` | `-y @z_ai/mcp-server@latest` | Arguments passed to the vision server command. |
| `Z_AI_VISION_MCP_CWD` | Current directory | Working directory for the vision server. |
| `ZAI_MCP_VISION_RETRY_COUNT` | `2` | Retries for vision tool calls. |
| `ZAI_MCP_RETRY_COUNT` | `1` | Retries for other MCP tool calls. |

## Specialized MiniMax Vision Mappings

The five specialized MiniMax Vision operations are implemented as
operation-specific prompt-composition Modules under
`packages/scoutline/src/providers/minimax/vision-mappings/`:

| Operation | CLI subcommand | Module |
| --- | --- | --- |
| `ui-artifact` | `scoutline vision ui-to-code` | `ui-artifact.ts` |
| `extract-text` | `scoutline vision extract-text` | `extract-text.ts` |
| `diagnose-error` | `scoutline vision diagnose-error` | `diagnose-error.ts` |
| `diagram` | `scoutline vision diagram` | `diagram.ts` |
| `chart` | `scoutline vision chart` | `chart.ts` |

Each Module composes a prompt that the Adapter sends through the direct
VLM transport (`fetchMiniMaxVlm`) with one image — there is no dedicated
MiniMax operation and no SDK. The shared prompt composition helpers
live in `vision-mappings/common.ts`; changing that file intentionally
invalidates every mapping's revision.

### Conformance gating

Runtime support for a specialized operation is decided by the compiled
conformance registry (`src/providers/minimax/vision-conformance.ts`). A
mapping becomes routable through MiniMax only when **every** condition
holds:

- offline conformance state is `pass`,
- live conformance state is `pass`,
- a sanitized compiled attestation matches the operation, fixture
  version, Implementation identity (`scoutline-direct@0.5.0`), and
  generated mapping revision.

In the current release, `ui-artifact`, `extract-text`, `diagnose-error`,
and `diagram` are live-attested and supported at runtime. The remaining
operation (`chart`) has offline `pass` and live `pending` — its fixture
image has a rotated, low-resolution Y-axis label that VLMs read
inconsistently, which is a fixture-image-quality blocker rather than an
evaluator issue. By default (0.11.0+), an explicit MiniMax selection
for `chart` emits a stderr notice and auto-reroutes to Z.AI, which
supports every specialized operation. Under `--no-fallback` the
candidate plan is reduced to the effective provider only and the
preflight surfaces `UNSUPPORTED_CAPABILITY` for `chart` before
credentials, media, transport, cache, or any other Provider is touched
(FR-023, FR-024). Pass `--no-fallback` to restore the strict
single-provider behavior.

**No environment variable, flag, or configuration value can promote a
mapping to supported.** Support is driven exclusively by the compiled
registry state. Re-running `npm run build` does not change support on
its own — a live attestation must be recorded first.

### Live attestation

Live attestation requires explicit opt-in and a real `MINIMAX_API_KEY`:

```bash
SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs --operation chart
```

Replace `chart` with one of the other specialized operations. The script:

1. Loads the operation's fixture image and the matching Module.
2. Calls the live Provider with the composed prompt.
3. Evaluates the fixture's semantic assertions in memory against the
   returned text (the text itself is never written to disk).
4. On success, appends a sanitized attestation entry to
   `src/providers/minimax/vision-attestations.ts`, flips the registry's
   `live` state to `pass`, and verifies that
   `isMiniMaxVisionOperationSupported(op)` returns `true`.
5. On failure, sets the registry's `live` state to `fail`. No
   attestation is committed and the mapping remains unsupported.

Re-run `npm run build` after a successful attestation so the registry
is recompiled with the new attestation and the operation becomes
routable at runtime.

The diff (`vision.diff`) and video (`vision.video`) operations are
intentionally **not** registry entries and remain Z.AI-only in the base
release.

## Local Cache

Search, reader, and ZRead responses are cached locally unless a command
receives `--no-cache`. Tool discovery (the MCP tool list `tools`/`tool`/
`doctor` consume) is cached separately. Both caches share one on-disk
root and one environment-variable policy. The cache is best-effort,
keyed by API-key hash plus request-affecting arguments, and stores no
cleartext API key.

### Directory layout

The cache root is `~/.scoutline/` on every platform. Two sibling
subdirectories live underneath:

```text
~/.scoutline/
  ├── cache/    response cache entries (Provider responses)
  └── tools/    tool discovery cache (MCP tool lists)
```

The same convention is used on Linux, macOS, and Windows — there is no
`~/Library/Caches/` branch and no `$XDG_CACHE_HOME` consultation. Both
subdirectories are created automatically on first use.

### Inspecting and clearing

```bash
scoutline cache stats   # inventory both subdirectories
scoutline cache clear   # delete every file in both subdirectories
```

`scoutline doctor` also embeds a one-line cache summary in its
`DiagnosticsReport` under the `cache.summary` field. The summary is
formatted by the dispatcher (`src/index.ts`) from `cacheStats()` output;
the report builder only embeds it (L1 fix).

### Canonical environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SCOUTLINE_CACHE` | `1` (enabled) | `0` or `false` disables both caches. |
| `SCOUTLINE_CACHE_TTL_MS` | `86400000` (24h) | TTL for both response and tool entries. |
| `SCOUTLINE_CACHE_SIZE_MB` | `100` | Size cap (MB) for the response cache; LRU eviction. |
| `SCOUTLINE_CACHE_DIR` | `~/.scoutline/` | Overrides the root directory; `cache/` and `tools/` are created underneath. |
| `SCOUTLINE_ARTIFACTS_DIR` | `~/.scoutline/artifacts/` | Root for saved `--save` reports and the `index.json` metadata log that `scoutline history` reads. Never touched by cache operations; no legacy alias. |

### Legacy aliases

The previous `ZAI_CACHE*`, `ZAI_MCP_TOOL_CACHE*`, and `ZAI_MCP_CACHE_DIR`
variables are accepted silently as lower-precedence aliases. New
`SCOUTLINE_CACHE*` names take precedence when both are set. A future
release may emit a one-time deprecation notice for the aliases.

| Old variable | Maps to | Note |
| --- | --- | --- |
| `ZAI_CACHE` | `SCOUTLINE_CACHE` | Response-cache enable flag. |
| `ZAI_CACHE_TTL_MS` | `SCOUTLINE_CACHE_TTL_MS` | Response-cache TTL. |
| `ZAI_CACHE_SIZE_MB` | `SCOUTLINE_CACHE_SIZE_MB` | Response-cache size cap. |
| `ZAI_CACHE_DIR` | `SCOUTLINE_CACHE_DIR` | Response-cache root override. |
| `ZAI_MCP_TOOL_CACHE` | `SCOUTLINE_CACHE` | Was tool-only; now unified. |
| `ZAI_MCP_TOOL_CACHE_TTL_MS` | `SCOUTLINE_CACHE_TTL_MS` | Was tool-only; now unified. |
| `ZAI_MCP_CACHE_DIR` | `SCOUTLINE_CACHE_DIR` | Was the documented tool-cache override in `src/lib/mcp-client.ts`; now unified. |

### `XDG_CACHE_HOME` removal

Earlier releases consulted `XDG_CACHE_HOME` on Linux and fell back to
`~/.cache/zai-cli/`. The unified cache no longer reads `XDG_CACHE_HOME`
on any platform. The old `~/.cache/zai-cli/` directory is **orphaned**:
the new code never reads from or writes to it, never migrates entries
out of it, and never deletes it. Operators can clean it up manually
with `rm -rf ~/.cache/zai-cli/`.

### Cache key shape

Cache keys are partitioned by Provider: new keys have the shape
`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`. The
credential hash is supplied by the Adapter (a SHA-256 fingerprint); it is
never re-hashed by cache code. Z.AI entries written before the Provider
partitioning remain readable as Adapter-owned candidates; their decoder is
Provider-owned because the old entries contain Provider response fields.

### Repository Cache

Repository results share the partitioned namespace and use a composite
operation suffix to prevent File and Directory listings from colliding:

```text
v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json
```

The Adapter resolves its credential once. That single credential drives both
the fingerprint and the legacy-key reconstruction; no ambient environment
is reread. A valid legacy v0.2 hit is written through to the new key; legacy
files are never migrated, rewritten, or deleted. `--no-cache` performs no
reads or writes — the operation validates, computes the identity, invokes
the Adapter, projects the result, and returns.

### Reader Cache

Reader results share the partitioned namespace and use the single
`reader-fetch` operation suffix:

```text
v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json
```

The Adapter resolves its credential once. The canonical request URL is the
**rewritten** URL (e.g. `gist.github.com/<id>` → `gist.github.com/<id>/raw`),
so two requests that normalize to the same fetched URL share one cache entry.
That same credential drives both the new fingerprint and the legacy-key
reconstruction; no ambient environment is reread. A valid legacy v0.2 hit is
written through to the new key; legacy files are never migrated, rewritten,
or deleted. `--no-cache` performs no reads or writes — the operation
validates, computes the identity, invokes the Adapter, projects the result,
and returns.

`--extract`, `--max-chars`, `--full-envelope`, and output mode never enter
the cache identity — they are projections applied after the cached normalized
content-read envelope is produced. A cache hit returns the full content;
projection applies on every read. Extract reads share the same cache entries
as content reads (the cache stores the normalized content; `--extract`
slices it on the way out).

## Usage Ledger

Every billable invoke also appends counters to a local usage ledger at
`~/.scoutline/usage.json` — a sibling of `config.json` under the config
root. `SCOUTLINE_CONFIG_DIR` moves the ledger with the config root. The
cache-directory variables (`SCOUTLINE_CACHE_DIR` and aliases) relocate
only the response caches, which otherwise default to the same
`~/.scoutline/` root; they never affect the ledger's location.

What records a row: `search` (fan-out arms and `--merge` sub-queries each
record their own invoke), `read`, `crawl`, `map`, `research`, `repo`, and
`vision`. Each transport attempt counts — a retry adds a second attempt —
and cache hits record nothing. Rows are keyed by UTC calendar date (taken
from the event timestamp, so bucketing is deterministic across time zones),
then by provider, then by capability id (`search`, `reader`, `crawl`, `map`,
`research`, `repository-exploration`, `vision.*`, …), each holding counters:
`attempts` (every event), `firstTries` (first attempts only), `exactUnits`
(reserved; 0 today), `estimateUnits` (single-call-cost capabilities:
search/reader/repository-exploration/map = 1 per call), and `unknownCount`
(variable-cost capabilities: vision, crawl, research).

Retention is 90 days: on the first write of a new UTC day, day keys older
than 90 days are pruned in the same write. There is no configuration
surface for retention in v1. Writes are serialized through a lock file
(`usage.json.lock`) and applied as an atomic temp-file rename; a ledger
read or write failure degrades to one fixed, detail-free warning and never
fails the command.

Read the ledger with `scoutline usage [--days N] [--provider <id>]`
(default window: 7 days). The command is credential-free and makes no
network calls.

**Privacy:** the ledger stores counters only. Queries, URLs, prompts,
results, credentials, and API keys are never written to it. A corrupt or
version-mismatched ledger is treated as empty (fail-open) rather than
blocking any command; the `usage` command reports an empty window with
exit 0 in that case.

## MiniMax Unsupported Reader

MiniMax does not advertise the `reader` Capability in the current release.
By default (0.11.0+) provider fallback handles this automatically:
selecting MiniMax (explicitly or via `SCOUTLINE_PROVIDER`) for `read`
emits a stderr notice and reroutes to the next eligible provider
(Z.AI, Tavily, Exa, Firecrawl, Parallel, Jina, You.com, Linkup, or
Spider.cloud) that supplies the `reader` Capability.
To restore the previous strict single-provider behavior, opt out with
`--no-fallback` (or `SCOUTLINE_NO_FALLBACK=1`) — under the kill-switch
the preflight surfaces `UNSUPPORTED_CAPABILITY` for MiniMax before
descriptor configuration, Adapter creation, credential resolution for
use, cache identity, or transport construction.

```bash
# Default (0.11.0+): auto-reroutes to the next eligible reader Provider
scoutline read https://example.com                       # Z.AI (default)
scoutline --provider zai read https://example.com        # explicit Z.AI
scoutline --provider minimax read https://example.com    # auto-reroutes; stderr notice

# Strict (killswitch): fails closed (UNSUPPORTED_CAPABILITY) for MiniMax
scoutline --no-fallback --provider minimax read https://example.com
```

## Quota Capability Mapping

Quota-aware provider selection (Plan B, shipped) ranks providers by
**remaining quota** for the capability being invoked. Because each
provider normalizes its native quota payload into its own named
categories, scoutline derives the selection score from an explicit
static mapping: `(provider, capability) → quota category`. The mapping
is table-driven (no `if (provider === ...)` branches through selection)
and lives in `packages/scoutline/src/lib/quota-mapping.ts`. The same
table drives selection (PB-T4) and dashboard display (PB-T5).

### Authority tiers

Authority and score are kept on separate axes. A provider is either:

- **Mapped** — exposes real credit/token signals. Its categories map to
  capabilities via the table, and the matched category's
  `remainingPercent` (already normalized 0..100 by `buildQuotaWindow`)
  is the selection score.
- **Always-unknown** — has no authoritative spend signal. Always
  reported as `authority:"unknown"` regardless of whether a snapshot
  exists. Eligible as fallback, but never wins over a mapped provider,
  even one at 5% remaining. (Encoding unknown as a numeric `50` would
  let it win over a low-scored known provider, contradicting "never
  fullest"; the explicit tier is the fix.)

| Provider | Tier | Reason |
| --- | --- | --- |
| `zai`, `minimax`, `tavily`, `firecrawl` | mapped | Real credit/token signal. |
| `brave` | always-unknown | Reports a rate-limit window, not spend or credits. Brave uses metered billing; the numeric window is displayed for telemetry but is not a budget signal. |
| `jina` | always-unknown | Rate-limit telemetry (`X-RateLimit-Remaining-*` headers), not spend; not a budget signal. |
| `linkup` | always-unknown | USD remaining balance (limit unknown; `unit: "USD"` — Linkup's "credits" are dollars); not a percentage-bounded plan signal. |
| `spider` | always-unknown | Credit remaining balance (limit unknown); not a percentage-bounded plan signal. |
| `exa`, `parallel`, `perplexity` | always-unknown | Advertise no `quota` capability; nothing to map. |
| `you` | always-unknown | Advertises no `quota` capability; You.com exposes no spend endpoint. Nothing to map. |

### Capability → category table

| Provider | Capability | Mapped category | Provider-level fallback |
| --- | --- | --- | --- |
| `zai` | `search`, `reader`, `repository-exploration` | `requests` | — |
| `zai` | every `vision.*` operation | `tokens` | — |
| `minimax` | `search` | MiniMax model alias (default: `zorla-x`, `MiniMax-Text-01`, `coding-plan`, `general`) | — |
| `minimax` | every attested `vision.*` operation | MiniMax VLM alias (default: `abab6.5-vl`, `MiniMax-VL-01`, `abab6.5s-chat`, `vlm`) | — |
| `tavily` | `search` | `search` | `requests` |
| `tavily` | `reader` | `extract` | `requests` |
| `tavily` | `crawl`, `map`, `research` | same-named endpoint category | `requests` |
| `firecrawl` | `search`, `reader`, `crawl`, `map` | `Credits` | — |

`quota` and `diagnostics` are observational on every provider and are
intentionally absent — they are not selection candidates. Aliases are
matched **case-sensitively** against the live normalizer's emission
(Tavily emits lowercase endpoint names; Firecrawl emits a
case-sensitive `Credits`); a case change is treated as drift and
surfaces through the fail-open path.

### MiniMax model aliases

MiniMax's `/remains` normalizer emits one category per live
`model_name` string, and `model_name` values are arbitrary (the live
schema does NOT emit a stable `general` label — the existing fixtures
include `zorla-x` and `abab6.5s-chat`). The default alias list above is
the documented mapping policy: the first alias that matches a live
category wins. If none match (the live API renames the model), the
score degrades to unknown + a `CATEGORY_NOT_FOUND` warning — never a
throw, never a synthesized score.

PB-T4 / tests can override the alias list via the
`minimaxModelAliases` option on `scoreCapability` /
`rankProvidersForCapability` when a deployment uses a different model
name.

### Fail-open paths

The scorer is total: every failure returns an `authority:"unknown"`
result with a machine-readable `reason`, and the caller never observes
a throw. Each path emits a structured warning through the injected
`onWarning` callback (the pure module never writes to stderr directly;
production wires a stderr writer, tests inject a recorder):

| Reason / warning code | Trigger |
| --- | --- |
| `PROVIDER_NON_AUTHORITATIVE` | Brave, Exa, Parallel, Perplexity, Jina, You.com, Linkup, and Spider.cloud — always-unknown by policy, regardless of snapshot. |
| `MAPPING_MISSING` | `(provider, capability)` has no row in the table (e.g. `quota`, `diagnostics`). |
| `SNAPSHOT_MISSING` | Provider has no snapshot in `~/.scoutline/state.json`. |
| `SNAPSHOT_EMPTY` | Snapshot exists but its `categories` array is empty. |
| `PROVIDER_FALLBACK_USED` | No alias matched; a provider-level fallback (Tavily aggregate `requests`) was used instead. |
| `CATEGORY_NOT_FOUND` | No alias and no fallback matched — likely provider-side rename. |
| `PERCENT_CORRUPT` | Matched category's `remainingPercent` is non-finite or outside 0..100. PB-T1 should prevent this, but a hand-edited `state.json` could violate it; the scorer treats corrupt input as unknown rather than synthesizing a score. |

A depleted category (`remainingPercent: 0`) is **not** corrupt — a
known-tier provider at 0% still ranks above any unknown-tier provider.

### Ranking output

`rankProvidersForCapability(state, capability, candidates)` returns an
ordered list:

1. **Known tier** first, sorted by score descending.
2. **Unknown tier** after every known entry, in registry order.
3. Ties within a tier break by registry order
   (`[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider]` by default;
   overridable via the `registryOrder` option).

The ranking is deterministic for identical inputs — same `state` +
same `candidates` + same `registryOrder` always produces the same
output order.

## Quota snapshot integration

`scoutline quota` and `scoutline doctor` surface the same PB-T1
snapshot that drives quota-balanced selection (PB-T4), so a user can
see and trust the quota state behind a selection pick. Both commands
stay on their existing schema versions — the new fields are additive
and optional.

### Schema decision (PB-T5, review item 14)

**Additive under existing schema versions**, not a version bump:

| Output | Schema | New fields |
| --- | --- | --- |
| `QuotaDashboard` | `schemaVersion: 1` (unchanged) | `ProviderQuotaSuccess.quotaSource?: { source, observedAt, authoritative }`; new union member `ProviderQuotaNone { status: "none", reason: "no-capability" }` |
| `DiagnosticsReport` | `schemaVersion: 2` (unchanged) | `ProviderDiagnostic.quota?: { source, observedAt?, authoritative }`; `ProviderDiagnostic.verification?: { status, checkedAt, reason? }` |

Rationale: quota/doctor are observational; additive optional fields
don't break consumers structurally. The new `"none"` union member is
handled by every existing consumer's fall-through (the TTY renderer
treats it as a single dim line; the exit-code computation ignores it;
the warnings loop skips it). The precedent is `ProviderQuotaSuccess.warnings`
(additive under the same schema) and `DiagnosticsReport.cache` (additive
under schema v2).

### `quota` source labels

Each successful row carries a `quotaSource` label:

| `source` | Meaning | `authoritative` |
| --- | --- | --- |
| `"snapshot"` | Read from `~/.scoutline/state.json` and within the freshness threshold. | `true` iff `observedAt` is within `DEFAULT_QUOTA_STALE_THRESHOLD_MS` (10 min). |
| `"live"` | The snapshot was stale/missing/corrupt; the dashboard fell back to a live probe. | Always `true` (just observed). |
| _omitted_ | Pre-PB-T5 caller path — no snapshot was injected. The row is a direct live probe whose freshness is implicit. | _n/a_ |

The dashboard awaits `quotaStore.writeObserved(...)` after every
successful live-probe fallback so the next dashboard reflects fresh
data. A store write failure is isolated (the row is still returned
with `source: "live"`); the store's own warning sink emits the stderr
notice.

### Exa no-signal row

In default (multi-provider) mode, a configured provider without a
`quota` capability (today: Exa, Parallel, Perplexity, and You.com) now
appears as:

```json
{ "provider": "exa", "status": "none", "reason": "no-capability" }
```

with **zero adapter/transport calls** — no live-probe fallback is
attempted. Pre-PB-T5 the multi-provider dashboard excluded Exa via
a capability filter; the no-signal row is the new contract.

A single-provider pin to a no-quota provider still throws
`UnsupportedCapabilityError` — pinning `--provider exa quota` is a
user error (the user explicitly asked for one provider's quota), so a
no-signal row would hide it. The no-signal row appears only in
multi-provider mode (the default).

### Brave rate-limit caveat

Brave's snapshot stores categories only (PB-T1's contract).
Provider-authored `warnings` (e.g. Brave's rate-limit caveat) are
**not** carried through the snapshot — they surface only when a live
probe runs (stale/missing). When the snapshot is fresh, the dashboard
shows Brave's numbers without the caveat. A user who needs the caveat
can wait for staleness (10+ min) or run a pinned query that bypasses
the snapshot. Extending the snapshot schema to carry warnings is out
of scope for PB-T5 (PB-T1 owns the schema).

### `doctor` quota + verification summaries

Each provider entry in the diagnostics report carries:

- `quota`: `{ source: "snapshot" | "none", observedAt?, authoritative }`
  derived from the snapshot — **never** via a live quota probe (Doctor
  is observational). The summary appears even under `--no-tools` (a
  snapshot read is local state, not transport) and even when the
  diagnostics probe fails (the snapshot is independent of the probe).
  `source` is `"snapshot"` only when the provider advertises the
  `quota` capability and the snapshot holds a real entry for it
  (`observedAt > 0`). Otherwise — no `quota` capability, no snapshot
  entry, or a bare scaffold entry (`observedAt: 0`, created but never
  observed) — the block is `{ source: "none", authoritative: false }`
  with `observedAt` omitted (#92): Doctor never reports an
  unobserved scaffold as provider ground-truth.
- `verification`: mirrors Plan A's `config.providers[id].verification`
  record so the user can see when each provider was last verified by
  a successful `doctor` probe.

### Correlating selection with the dashboard

The `quotaSource.authoritative` flag is the **same flag** PB-T4's
selection resolver uses. A non-authoritative row means the selection
treated the provider as eligible-but-neutral. The dashboard surfaces
the same flag so a user can correlate a selection pick with the data
that drove it — without misattributing the pick to data fresher than
it is.

Freshness is judged solely from `observedAt` — the snapshot's
ground-truth clock. `locallyUpdatedAt` (PB-T2's local decrement)
**never** resets the staleness clock; a snapshot with a stale
`observedAt` and a fresh `locallyUpdatedAt` is still
non-authoritative. Local decrements between harvests are tracked as
`decrementedSinceObserved` and re-applied on refresh only for the
portion the provider `used` count has not yet absorbed.

## Security

Keep credentials in your shell profile, secret manager, or CI secret store.
Do not put them in command arguments, committed files, generated reports, or
bug reports. Scoutline applies recursive, case-insensitive redaction of every
configured credential (`Z_AI_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`,
`YDC_API_KEY`, `YOU_API_KEY`, `LINKUP_API_KEY`, `SPIDER_API_KEY`,
Bearer / `x-api-key` values, embedded credential strings) at every outward
boundary: output, errors, diagnostics, quota failures, cached metadata, and
fatal shell errors.
