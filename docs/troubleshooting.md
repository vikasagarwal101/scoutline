# Troubleshooting

## Missing Provider Credential

```
Z_AI_API_KEY environment variable is required
```

Set the credential for the Provider you intend to use:

```bash
# Z.AI
export Z_AI_API_KEY="your-api-key"
scoutline doctor

# MiniMax Token Plan
export MINIMAX_API_KEY="your-minimax-key"
scoutline doctor --provider minimax

# Brave
export BRAVE_SEARCH_API_KEY="your-brave-key"
scoutline doctor --provider brave
```

Provider selection is never inferred from which credentials are present. An
unconfigured effective Provider is a configuration failure (`exit 3`) for the
default quota command and a diagnostic failure (`exit 1`) for `doctor`.

## Unknown Provider ID

```
Unknown provider "<value>". Accepted provider IDs: zai, minimax, tavily, brave.
```

`--provider` and `SCOUTLINE_PROVIDER` accept `zai`, `minimax`, `tavily`, or
`brave`. Unknown or empty values fail with `VALIDATION_ERROR` (`exit 1`) before
any Provider invocation. `read`, `repo`, `crawl`, `map`, and `research`
participate in selection but are supplied by different subsets of Providers
(see the Capability Matrix). `tools`, `tool`, `call`, and `code` accept the
flag but ignore it — they remain Z.AI-only.

## Unsupported MiniMax Reader

```
Provider "minimax" does not support capability "reader"
```

Selecting MiniMax (explicitly or via `SCOUTLINE_PROVIDER`) for `read` returns
`UNSUPPORTED_CAPABILITY` (`exit 1`) **before** descriptor configuration,
Adapter creation, credential resolution for use, cache identity, or transport
construction. There is no implicit fallback to Z.AI, no heuristic, and no env
rerun. Drop the Provider selection to use the default Z.AI:

```bash
# This fails closed (UNSUPPORTED_CAPABILITY):
scoutline --provider minimax read https://example.com

# These succeed through Z.AI (the only built-in Provider that supplies the
# reader Capability today):
scoutline read https://example.com
unset SCOUTLINE_PROVIDER  # if a previous shell set it to minimax
scoutline --provider zai read https://example.com
```

If `SCOUTLINE_PROVIDER` is set to `minimax` in your shell, simply dropping
`--provider` is not enough — either `unset SCOUTLINE_PROVIDER` or pass
`--provider zai` explicitly.

The failure intentionally occurs in the same probe path used for `repo`,
`vision.diff`, `vision.video`, and unsupported specialized Vision mappings —
descriptor metadata is the support truth and the descriptor is the only
thing consulted before configuration, Adapter construction, or transport
activity.

## Unsupported MiniMax Repository Exploration

```
Provider "minimax" does not support capability "repository-exploration"
```

Selecting MiniMax (explicitly or via `SCOUTLINE_PROVIDER`) for any `repo`
subcommand returns `UNSUPPORTED_CAPABILITY` (`exit 1`) **before** descriptor
configuration, Adapter creation, credential resolution for use, cache identity,
or transport construction. There is no implicit fallback to Z.AI, no
heuristic, and no env rerun. Drop the Provider selection to use the default
Z.AI:

```bash
# This fails closed (UNSUPPORTED_CAPABILITY):
scoutline --provider minimax repo search facebook/react "server components"

# These succeed through Z.AI (the only built-in Provider that supplies the
# repository-exploration Capability today):
scoutline repo search facebook/react "server components"
unset SCOUTLINE_PROVIDER  # if a previous shell set it to minimax
scoutline --provider zai repo read facebook/react README.md
```

If `SCOUTLINE_PROVIDER` is set to `minimax` in your shell, simply dropping
`--provider` is not enough — either `unset SCOUTLINE_PROVIDER` or pass
`--provider zai` explicitly.

The failure intentionally occurs in the same probe path used for `vision.diff`,
`vision.video`, and unsupported specialized Vision mappings — descriptor
metadata is the support truth and the descriptor is the only thing consulted
before configuration, Adapter construction, or transport activity.

## Unsupported MiniMax Search Control

```
Unsupported option "domain" for minimax.search
```

MiniMax does not accept domain, recency, content-size, or location search
controls. Drop the unsupported control and re-run. The `--count` and
`--max-summary` flags are still applied locally after normalization.

## Unsupported MiniMax Vision Operation

```
Unsupported capability "vision.diff" for provider minimax
```

MiniMax supports general single-image interpretation (`scoutline vision
analyze`) in the base release. Two-image comparison (`vision diff`) and
video analysis (`vision video`) are **permanently** Z.AI-only and are
never registry entries.

The five specialized mappings (`ui-artifact`, `extract-text`,
`diagnose-error`, `diagram`, `chart`) are **implemented** but their
runtime support is gated by the compiled conformance registry. Four are
currently live-attested and supported (`ui-artifact`, `extract-text`,
`diagnose-error`, `diagram`); `chart` is not. A mapping is unsupported
until a live attestation records a passing `live` state plus a sanitized
compiled attestation that matches the operation, fixture version,
Implementation identity, and generated mapping revision.

The most common reason a specialized mapping is reported as
`UNSUPPORTED_CAPABILITY`:

| Cause | What to check |
| --- | --- |
| Live attestation has not been recorded | `MINIMAX_VISION_CONFORMANCE_REGISTRY[op].live === "pending"` |
| Live semantics failed | `MINIMAX_VISION_CONFORMANCE_REGISTRY[op].live === "fail"` — the previous attestation was rejected |
| SDK Implementation identity changed | The compiled attestation's `implementationId` no longer matches `scoutline-direct@0.5.0` |
| Mapping revision changed | The compiled attestation's `mappingRevision` no longer matches `MINIMAX_VISION_MAPPING_REVISIONS[op]` |
| Fixture version bumped | The compiled attestation's `fixtureVersion` no longer matches the entry's `fixtureVersion` |

`MINIMAX_VISION_CONFORMANCE_REGISTRY` and `MINIMAX_VISION_MAPPING_REVISIONS`
are exposed from the built package, so you can inspect every entry:

```bash
node -e 'import("./packages/scoutline/dist/providers/minimax/vision-conformance.js").then(m => console.log(m.MINIMAX_VISION_CONFORMANCE_REGISTRY))'
```

### Rerunning live conformance

Live conformance is opt-in and requires a real `MINIMAX_API_KEY`. From
`packages/scoutline`:

```bash
SCOUTLINE_LIVE_TESTS=1 node scripts/attest-minimax-vision.mjs --operation chart
```

Replace `chart` with the operation you want to attest. The script
evaluates the fixture semantics in memory and either commits a sanitized
attestation (success) or sets the registry's `live` state to `fail`
(failure). Run `npm run build` afterwards so the registry is recompiled
with the new state.

No environment value can promote a mapping to supported on its own —
only the attestation script can write the attestation entry that the
registry validates.

### Adapter routing

When a specialized mapping's live state is `pass` and the compiled
attestation matches, the MiniMax Adapter routes the request through the
matching `vision-mappings/<op>.ts` Module. The Module composes the
prompt, the Adapter resolves the image to a data URI and invokes the
direct VLM transport (`fetchMiniMaxVlm`), and the Module's normalizer
extracts the `{ content }` envelope.
If the Module is somehow missing while the registry gate is open, the
Adapter surfaces `API_ERROR` — this should not happen at runtime and
indicates a coding bug rather than runtime drift.

## Repository Search/Read/Tree Returns a Malformed Provider Response

```
{ "success": false, "error": "Z.AI repository request failed", "code": "API_ERROR", "statusCode": 502 }
```

Encoded MCP errors and malformed ZRead grammar are mapped deterministically
before success parsing:

| Provider condition | Public code | Status | Retry |
| --- | --- | --- | --- |
| Exhausted quota (code `1310` or explicit "exhausted limit") | `QUOTA_ERROR` | 429 | terminal |
| Transient 429 / "rate limited" | `API_ERROR` | 429 | one retry |
| Auth 401 / 403 | `AUTH_ERROR` | matching | terminal |
| Provider 5xx | `API_ERROR` | matching | one retry |
| Other 4xx (including 404) | `API_ERROR` | matching | terminal |
| Malformed envelope or success wrapper | `API_ERROR` | 502 | one retry |

Raw Provider body, reset metadata, error code text, and encoded message
strings are discarded. The retry taxonomy gives each repository operation
exactly one retry (matching the current single-retry non-Vision policy). A
retry creates a fresh Adapter transport attempt with one best-effort close;
cache hits construct and close no transport.

## Reader Returns a Malformed Provider Response

```
{ "success": false, "error": "Z.AI reader request failed", "code": "API_ERROR", "statusCode": 502 }
```

Encoded MCP errors and malformed WebReader responses are mapped
deterministically before success parsing using the same taxonomy that
governs `repo`:

| Provider condition | Public code | Status | Retry |
| --- | --- | --- | --- |
| Exhausted quota (code `1310` or explicit "exhausted limit") | `QUOTA_ERROR` | 429 | terminal |
| Transient 429 / "rate limited" | `API_ERROR` | 429 | one retry |
| Auth 401 / 403 | `AUTH_ERROR` | matching | terminal |
| Provider 5xx | `API_ERROR` | matching | one retry |
| Other 4xx (including 404) | `API_ERROR` | matching | terminal |
| Malformed envelope or empty content | `API_ERROR` | 502 | one retry |

Raw Provider body, reset metadata, error code text, and encoded message
strings are discarded. The retry taxonomy gives each reader operation exactly
one retry (matching the current single-retry non-Vision policy). A retry
creates a fresh Adapter transport attempt with one best-effort close; cache
hits construct and close no transport. Transport close failure never masks a
primary success or replaces a primary failure.

## `--extract` Looks Unexpected

`scoutline read` ships two result schemas, both `schemaVersion: 1`. The
content read (default) and the extract read (`--extract <mode>`) intentionally
diverge in how the text-oriented output modes present them:

| Mode | Content read (`https://...`) | Extract read (`--extract code`) |
| --- | --- | --- |
| `data` / `json` / `pretty` | The envelope object | The envelope object |
| `compact` / `markdown` / `refs` / `tty` | The `content` string directly | **JSON fallback** (the envelope object) |

If you ran `scoutline read URL --extract code -O compact` expecting the
extract items as prose, the JSON envelope you see is intentional — extracted
items are data, not prose. Use `-O data` (or `json`/`pretty`) for the
structured shape every time.

The four `--extract` modes (`code`, `links`, `tables`, `headings`) and the
shape of each item are unchanged from v0.2; only the outer envelope changed
(bare array → schema-versioned object with `items`). To get the bare-array
shape back, slice it: `scoutline read URL --extract code -O data | jq -c .items[]`.

`--max-chars` is **ignored on extract reads** — extract reads are not
character-truncated. Extract reports `originalItemCount` instead; see the
next section for the content-read behavior.

## Repository Search Returns 0 Excerpts or Reports "Empty Result"

The Z.AI Adapter requires at least one well-formed `<excerpt>` block to
recognize a Search response. An unwrapped response — even one with valid
plain text — is malformed (see the table above) rather than an empty result.

`repo tree` and `repo read` accept and surface an explicit empty `entries` or
zero-content result from any future Adapter that exposes a valid empty state.
ZRead does not currently produce a characterized empty Search or a
zero-content File, so a zero-excerpt Z.AI response is malformed.

## `--max-chars` Looks Unexpected

`--max-chars` is a deterministic local projection applied **after** caching
and validation. It never invokes a model:

- absent, zero, or negative → no truncation;
- `repo search` → one total budget across `excerpts[].text`; the final
  retained excerpt is truncated with the existing ellipsis rule and later
  excerpts are omitted;
- `repo read` → only `content` is truncated; `originalContentLength` and
  `truncated` always describe the pre-truncation length;
- `repo tree` → never character-limited; metadata, JSON envelopes, and
  snapshots are not part of any budget;
- `read` (content read) → truncates the envelope's `content`; sets
  `truncated: true` and preserves `originalContentLength`;
- `read --extract <mode>` → **ignored**. Extract reads are not
  character-truncated; the extract envelope reports `originalItemCount`
  instead. Truncating a code block or link list mid-item would be harmful.

If your consumer expected a smaller content-read result, lower `--max-chars`;
if you expected the full result, drop the flag or pass a larger value.
Cached results are always the complete normalized result — projection is the
only place `--max-chars` ever appears.

## Cache Hits Don't Refresh

Repository cache hits return before any Adapter invocation and construct no
transport. To force a fresh call, pass `--no-cache` (the operation still
validates, computes the identity, invokes, and projects the result, but
performs no reads or writes). To wipe the local cache, run
`scoutline cache clear`; `scoutline` never rewrites, migrates, or deletes
legacy v0.2 `zai-cli` cache files in the orphaned `~/.cache/zai-cli/`
directory.

## Cache Stats and Clearing

```bash
scoutline cache stats   # inventory both cache/ and tools/ subdirectories
scoutline cache clear   # delete every file in both subdirectories
```

`cache stats` prints the cache root, status (enabled/disabled, TTL, size
cap), and per-subdirectory entry count and total size. The output
matches the `data`-mode JSON shape `{dir, enabled, ttlMs, sizeCapBytes,
responseCache: {entries, totalBytes}, toolCache: {entries, totalBytes}}`
in `data` mode and a multi-line inventory in any text-oriented mode
(`tty`, `compact`, `markdown`, `refs`).

`cache clear` deletes every file under `<root>/cache/` and
`<root>/tools/`. The directories themselves are preserved so the next
invocation recreates entries without a directory-creation race. It
never touches the orphaned legacy `~/.cache/zai-cli/` directory. The
default cache root is `~/.scoutline/` on every platform; override it
with `SCOUTLINE_CACHE_DIR`. See
[Configuration](configuration.md#local-cache) for the full
environment-variable surface and the legacy-alias table.

## Close Failure Doesn't Surface

`close()` after a repository operation is best-effort and bounded by the
existing `ZaiMcpClient.close` 2000 ms semantic. Close rejection or timeout
is silently swallowed: it never replaces successful data, never masks a
primary operation failure, and never emits a final stderr notice. The
operation's outward result (success or primary failure) is the only thing
the caller sees. If you need to confirm whether a close actually
completed, instrument the Adapter side directly — the CLI surface will
not report it.

## The executable reports `LOAD_ERROR`

The package has not been built, or its compiled output is missing. From
`packages/scoutline` run:

```bash
npm ci
npm run build
```

The published executable loads `dist/index.js`, not TypeScript source files.

## Build cannot resolve Node or UTCP types

Dependencies are missing or incomplete. Remove any partial install only if it
is safe to do so, then run `npm ci` from `packages/scoutline`. The package
requires Node 22 or later.

## A command times out

Increase the timeout for the process:

```bash
export Z_AI_TIMEOUT=60000
scoutline read https://example.com
```

The value is milliseconds. Retrying is limited to transient failures;
authentication, validation, unsupported, and exhausted-quota failures are
terminal.

## Results appear stale

Bypass the response cache for one request:

```bash
scoutline search "latest MCP specification" --no-cache
```

To disable caching for the process, set `SCOUTLINE_CACHE=0` (legacy
alias: `ZAI_CACHE=0`). See
[Configuration](configuration.md#local-cache) for TTL, size cap, and
directory controls. Note that Vision results are never cached regardless.

## Vision startup is slow or fails for non-vision commands

Skip the optional vision MCP server:

```bash
scoutline doctor --no-vision
scoutline tools --no-vision
```

Set `Z_AI_VISION_MCP=0` when the environment should never start the server.

## A URL is rejected by `read`

`read` accepts absolute `http://` or `https://` URLs only. GitHub Gist URLs
are rewritten to their raw form automatically and the rewritten URL is
surfaced as `finalUrl` in the v1 result (the v0.2 stderr rewrite notice is
removed).

## `quota --all-providers` exits 1

That is the documented exit semantics: any configured Provider failure
preserves the successful entries and yields exit 1. Inspect the dashboard to
find the failing entry — the failure is reported as a normalized redacted
error alongside the successful entries.

## `doctor` exits 1

`doctor` exits 1 when the effective Provider is unconfigured or any
configured probe fails. Inspect the report: missing non-effective credentials
appear as `skipped` and do not fail the report. Under `--no-tools` every
configured Provider is reported as `skipped` (reason `tools-disabled`) and
does not fail the report either.

## Need more information

Run command-local help, which is the canonical option reference:

```bash
scoutline <command> --help
```

For Provider setup and connectivity, run `scoutline doctor`. To list every
configured Provider's quota, run `scoutline quota --all-providers`.