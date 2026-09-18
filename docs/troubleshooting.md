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

Alternatively, run `scoutline init` to record API keys in
`~/.scoutline/config.json` interactively. The wizard validates each key
with a single inline probe and writes the file with mode 0600.

## Corrupt `config.json` — `init` is the recovery path

```
config.json is corrupt
```

`scoutline init` offers to back up the corrupt file and rewrite a fresh
config. The backup is named `<config.json>.corrupt-<timestamp>.bak` and is
never deleted by scoutline. Declining the repair exits without modifying
the live file.

```bash
scoutline init   # offers backup + rewrite on a corrupt config
```

Credential-free commands (`--help`, `--version`, `cache`, `<command> --help`)
never read the config file, so a corrupt config never blocks help rendering.
Credentialed commands (`search`, `read`, `vision`, `tools`, etc.) refuse
with `CONFIGURATION_ERROR` exit 3 until the config is repaired.

## "Using credentials from the environment" one-time hint

When a credentialed command runs with environment-variable credentials but
no `~/.scoutline/config.json`, scoutline emits a one-time stderr hint
pointing at `scoutline init`:

```
scoutline: using credentials from the environment. Run `scoutline init` ...
```

The hint is persisted as `config.json.hintShown` so it does not repeat. The
command runs normally afterward with its natural output and exit code. Run
`scoutline init` to record the keys, or ignore the hint — it fires at most
once until the config is removed or `hintShown` is reset (which a fresh
`init` run does).

## Unknown Provider ID

```
Unknown provider "<value>". Accepted provider IDs: zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider, bocha, searchapi, arxiv, openalex, crossref, pubmed, europepmc.
```

`--provider` and `SCOUTLINE_PROVIDER` accept `zai`, `minimax`, `tavily`,
`exa`, `brave`, `firecrawl`, `parallel`, `perplexity`, `jina`, `you`,
`linkup`, `spider`, `bocha`, `searchapi`, `arxiv`, `openalex`, `crossref`, `pubmed`, or
`europepmc`. Unknown or empty values fail with `VALIDATION_ERROR` (`exit 1`) before
any Provider invocation. `read`, `repo`, `crawl`, `map`, and `research`
participate in selection but are supplied by different subsets of Providers
(see the Capability Matrix). `tools`, `tool`, `call`, and `code` accept the
flag but ignore it — they remain Z.AI-only.

## Unsupported MiniMax Reader

```
Provider "minimax" does not support capability "reader"
```

By default (0.11.0+) provider fallback handles this automatically:
selecting MiniMax (explicitly or via `SCOUTLINE_PROVIDER`) for `read`
emits a stderr notice and reroutes to the next eligible Provider
(Z.AI, Tavily, Exa, or Firecrawl) that supplies the `reader`
Capability. To restore the previous strict single-provider behavior,
opt out with `--no-fallback` (or `SCOUTLINE_NO_FALLBACK=1`):

```bash
# Default (0.11.0+): falls back to the next capable, configured Provider
scoutline --provider minimax read https://example.com

# Strict (killswitch): fails closed (UNSUPPORTED_CAPABILITY), no adapter work
scoutline --no-fallback --provider minimax read https://example.com
```

The failure under `--no-fallback` intentionally occurs **before**
descriptor configuration, Adapter creation, credential resolution for
use, cache identity, or transport construction — descriptor metadata
is the support truth and the descriptor is the only thing consulted
before any other Provider is touched.

## Unsupported MiniMax Repository Exploration

```
Provider "minimax" does not support capability "repository-exploration"
```

By default (0.11.0+) provider fallback handles this automatically:
selecting MiniMax (explicitly or via `SCOUTLINE_PROVIDER`) for any
`repo` subcommand emits a stderr notice and reroutes to the next
eligible Provider (Z.AI is the only built-in Provider that supplies
`repository-exploration`). To restore the previous strict
single-provider behavior, opt out with `--no-fallback` (or
`SCOUTLINE_NO_FALLBACK=1`):

```bash
# Default (0.11.0+): falls back to Z.AI (the only supplier of
# repository-exploration)
scoutline --provider minimax repo search facebook/react "server components"

# Strict (killswitch): fails closed (UNSUPPORTED_CAPABILITY)
scoutline --no-fallback --provider minimax repo search facebook/react "server components"
```

The failure under `--no-fallback` intentionally occurs **before**
descriptor configuration, Adapter creation, credential resolution for
use, cache identity, or transport construction — descriptor metadata
is the support truth and the descriptor is the only thing consulted
before any other Provider is touched.

## Why did I get charged twice on a single `crawl` / `map` / `research`?

Provider fallback is always-on by default. For the cost-bearing
asynchronous capabilities, a runtime failure on the selected provider
may fall back to another provider **even if the failed provider had
already accepted or charged a job** — because the providers (Firecrawl,
Tavily, Exa) do not offer an idempotency key, an explicit pre-charge
acknowledgement, or a refund for accepted-then-failed work. This is a
documented, accepted tradeoff (see
[`docs/adr/0002-provider-fallback.md`](https://github.com/vikasagarwal101/scoutline/blob/main/docs/adr/0002-provider-fallback.md)
and the help text for `crawl` / `map` / `research`).

Worst-case charged-request counts under retry+fallback with both
candidates configured:

| Command   | Per-provider `maxRetries` | Worst-case charged POSTs (retry + fallback) | Default (winner only) | Under `--no-fallback` |
| --------- | ------------------------- | -------------------------------------------- | --------------------- | --------------------- |
| `crawl`   | 0                         | ≤ 2                                          | 1                     | 1                     |
| `map`     | 0                         | ≤ 2                                          | 1                     | 1                     |
| `research`| 0                         | ≤ 2                                          | 1                     | 1                     |

If you need a strict cost ceiling for these commands, set
`SCOUTLINE_NO_FALLBACK=1` (or pass `--no-fallback` per invocation).
Under the kill-switch the candidate plan is reduced to the effective
provider only, so the double-charge path is unreachable.

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

`--max-chars` budgets the whole envelope on extract reads too — but it
trims field **values** only, never dropping field names or URLs. Extract
reports `originalItemCount`; see "`--max-chars` Looks Unexpected" below for the
budget behavior.

## Repository Search Returns 0 Excerpts or Reports "Empty Result"

The Z.AI Adapter requires at least one well-formed `<excerpt>` block to
recognize a Search response. An unwrapped response — even one with valid
plain text — is malformed (see the table above) rather than an empty result.

`repo tree` and `repo read` accept and surface an explicit empty `entries` or
zero-content result from any future Adapter that exposes a valid empty state.
ZRead does not currently produce a characterized empty Search or a
zero-content File, so a zero-excerpt Z.AI response is malformed.

## `--max-chars` Looks Unexpected

`--max-chars` is a deterministic local whole-envelope Output Budget applied
**after** caching, validation, `--count`, and `--max-summary`. It never
invokes a model:

- absent, zero, or negative → no budget;
- `search` → summaries trim, then source/date drop, then lowest-ranked
  results drop; URLs and titles are never cut;
- `read` (content read) → later paragraphs trim first, bottom sections
  drop late; headings are never cut mid-value, but whole sections
  (headings included) can drop at crush budgets; sets `truncated: true`
  and preserves `originalContentLength`;
- `read --extract <mode>` → trims field **values** only; field names and
  URLs are never dropped. The extract envelope reports `originalItemCount`;
- `crawl` → page contents trim, trailing pages drop late; page URLs never
  cut;
- `research` → report body trims first; the citations block survives
  longest;
- `repo search` → excerpts trim, trailing excerpts drop; URLs never cut;
- `repo read` → file content trims; `originalContentLength` and
  `truncated` always describe the pre-truncation length;
- `repo brief` → applied once to the assembled brief; README excerpts and
  file bodies trim, file inventory drops late; repository name and
  structure summary never cut;
- `repo tree` → **rejects** the flag (`UNSUPPORTED_OPTION`);
- `science search` → summaries trim, authors tail halves, venue drops,
  trailing works drop down to one; titles, URLs, and identifiers never cut;
- `science get` → summaries trim, authors tail halves, venue drops; titles,
  URLs, and identifiers never cut.

If the budget fired, nothing is lost: the payload carries `compaction:
{budget, ref}` and the full untrimmed envelope is in the artifacts store —
recover it with `scoutline history show <ref>`. If your consumer expected
a smaller result, lower `--max-chars`; if you expected the full result,
drop the flag or pass a larger value. Cached results are always the
complete normalized result — projection is the only place `--max-chars`
ever appears.

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

## `quota` shows `stale · non-authoritative`

Each row carries a `quotaSource.authoritative` flag (PB-T5). A
non-authoritative row means the snapshot's `observedAt` is older than
the 10-minute staleness threshold — the dashboard read the snapshot
but flagged that it may not reflect current spend. Selection (PB-T4)
treated this provider as eligible-but-neutral.

To force fresh data:

```bash
scoutline quota            # the explicit command force-refreshes BEFORE the dashboard
```

The pre-command refresh bypasses the staleness threshold (the user
asked for fresh data). If a provider's transport fails, the refresh
is isolated — the snapshot stays stale, the row stays
non-authoritative, and a stderr notice identifies the failing
provider.

## `quota` shows a provider with `status: "none"`

A `{ status: "none", reason: "no-capability" }` row (PB-T5) is a
configured provider that does not advertise a `quota` capability —
today, only Exa. The row appears in default (multi-provider) mode
with zero transport calls. Pinning the same provider explicitly
(`--provider exa quota`) throws `UnsupportedCapabilityError` instead:
a single-provider pin is a user request for one provider's quota,
so a no-signal row would hide the user error. To see Exa's
inventory without the no-signal row, use `scoutline doctor` (its
`capabilityMatrix` lists every provider's capabilities).

## `quota` is missing Brave's rate-limit caveat

Brave's snapshot stores categories only (PB-T1's contract).
Provider-authored warnings (Brave's rate-limit caveat) surface only
on a live probe — when the snapshot is fresh, the dashboard shows
Brave's numbers without the caveat. Wait for staleness (10+ min) or
force a refresh via `scoutline quota`. Extending the snapshot schema
to carry warnings is tracked as future work.

## Tavily fails while `plan` still shows remaining quota

Tavily's quota dashboard carries two independent windows, and only
one of them gates calls. The key-level `requests` aggregate — shared
by the per-endpoint `search`, `extract`, `crawl`, `map`, and
`research` categories — is the pool the API actually draws from; the
account-level `plan` category is only the monthly billing window.
When the key pool is exhausted, calls fail (and `doctor` surfaces the
provider as `exhausted`/`error`) even though `plan` still reads a
healthy percentage — for example a "plan limit exceeded" error
alongside a fresh snapshot showing `plan` at 4.5% remaining. Doctor's
availability verdict and quota-based selection derive from the
key-pool `requests` category, never `plan`.

## Science Supplier Keys and Rate-Limit Tiers

Science suppliers (arXiv, Crossref, Europe PMC, OpenAlex, PubMed) are
keyless-by-default — none of them requires a paid subscription or billing
account:

- **arXiv**, **Crossref**, and **Europe PMC** are permanently keyless. No
  credential environment variables exist (`credentialEnvVars: []`). Crossref
  automatically sends a polite-pool contact in the User-Agent header
  (`scoutline/<version> (mailto:scoutline@localhost)`); Europe PMC and arXiv
  send the standard User-Agent header.
- **OpenAlex** and **PubMed** accept optional, free API keys that elevate
  rate limits rather than bill for usage:
  - `OPENALEX_API_KEY`: keyless requests ride OpenAlex's anonymous tier
    with polite `mailto=scoutline@localhost` query attribution (the shipped
    `scoutline init` summary: "keyless 1000 credits/day (~100 searches;
    doi:get free); free key recommended" — OpenAlex's published pricing
    currently prices search around $1/day ≈ 1,000 searches). Setting an
    API key routes requests via `api_key=<key>` instead, and per OpenAlex's
    docs authenticated traffic uses a separate pool not subject to the
    anonymous search pause.
  - `NCBI_API_KEY`: scoutline applies NO client-side rate limiting — it
    sends every request immediately. The key, when set, rides the request
    as an `api_key=<key>` query parameter, and per NCBI's own docs a
    registered key raises your SERVER-SIDE allowance (the commonly quoted
    tier moves from ~3 to ~10 requests/second). Those numbers are
    NCBI-side facts, not limits scoutline enforces.

API keys can be supplied via environment variables or stored interactively:

```bash
# Optional upgrade keys (free rate-limit tiers)
export OPENALEX_API_KEY="your-openalex-key"
export NCBI_API_KEY="your-ncbi-key"

# Or configure interactively
scoutline init
```

To check every configured science supplier, run:

```bash
scoutline doctor
```

Note: with the OpenAlex probe exercising the search surface, `doctor`
issues ONE real search (`search=test`). Without `OPENALEX_API_KEY` this
ride is anonymous — it draws on the same small anonymous budget as your
searches (see the OpenAlex tier note above), not a separate free lane.
With a configured key the probe passes `api_key` and uses the
authenticated tier instead. The other suppliers' probes are keyless
reads with no billing surface.

Science suppliers are excluded from quota spend dashboards (`scoutline quota`)
because they carry no usage billing pool.

## OpenAlex Anonymous Search 503 or `doctor` Probe Is Red

```
OpenAlex request failed (anonymous search may be paused under load — a free API key via `scoutline init` restores it)
```

Under heavy upstream server load, OpenAlex may temporarily pause anonymous
search requests by returning HTTP 503, even while entity endpoints or bare
works queries respond normally.

In `scoutline doctor`, the OpenAlex diagnostic probe exercises the search
surface (`search=test`, `per-page=1`). A red probe row during an anonymous
pause is intentional — doctor verifies capability health (search functionality),
not bare network connectivity.

Unauthenticated search requests that encounter this pause fail with `API_ERROR`
(`exit 1`). To resolve this:

1. Obtain a free OpenAlex API key from <https://openalex.org/users/me>.
2. Configure it via `export OPENALEX_API_KEY="..."` or run `scoutline init`.

Requests with an API key carry `api_key=` instead of `mailto=`; per
OpenAlex's docs, authenticated requests use a separate pool that is not
subject to the anonymous search pause.

## Science Fan-Out Reports "arm failed (…) — dropped from this fan-out"

```
scoutline: <supplier> arm failed (<message>) — dropped from this fan-out.
```

When running `scoutline science search <query>` without pinning a single
provider, scoutline fans out the search concurrently across all eligible
science suppliers.

If an individual supplier fails at invocation time (for example, HTTP 503,
transient network drop, or upstream timeout), scoutline emits a stderr notice
identifying the failed arm and message, then drops that arm from the merge.

Exit codes and partial fan-out:
- **Partial success (`exit 0`):** As long as at least one arm fulfills (even
  if that arm returns an empty works list), the fan-out succeeds with `exit 0`.
  The surviving arms are merged, deduplicated by persistent identifiers (DOI
  first, then normalized URL), and returned. The history journal records
  `{ mode: "fanout", arms: [...] }` listing only the survivor arms that
  actually served.
- **Complete failure (`exit 1`):** `science search` fails if and only if
  **every** attempted arm rejects. In this case, scoutline throws the error
  from the first attempted arm in priority order.

## arXiv Multi-Word Search and Unsupported Controls

```
Provider "arxiv" does not support option "<option>" for capability "science.search"
```

The arXiv Atom API query parser treats unquoted space-separated terms as
an implicit-OR expression across fields, which causes multi-word queries
to return unrelated matches for individual words.

To ensure exact topic matching and prevent result flooding, scoutline wraps
multi-word search queries in a single quoted phrase under the `all:` field
operand (`all:"<phrase>"`), folding internal double quotes to spaces and
collapsing whitespace.

Key syntax considerations:
- **Raw boolean and field syntax:** Because scoutline wraps the input in
  `all:"..."`, explicit arXiv boolean operators (such as `AND`, `OR`, `ANDNOT`)
  or field prefixes (such as `ti:`, `au:`) typed into the query string are
  interpreted as literal text within the phrase rather than evaluated by
  arXiv as query operators.
- **Unsupported CLI controls (`exit 1`):** The arXiv adapter rejects all
  structured science controls (`--author`, `--year`, `--venue`, `--type`)
  at validation time with `UNSUPPORTED_OPTION` (`exit 1`). arXiv's API does
  not support exact equivalents (e.g. arXiv filters `submittedDate`, not
  publication year). To search by author or keyword on arXiv, include the
  terms directly in the query text.

## `--max-chars` on Science Commands

`--max-chars` applies a deterministic local Output Budget to both
`scoutline science search` and `scoutline science get` envelopes after
results are retrieved.

The science budget ladder (internally `SCIENCE_LADDER`) applies lossy
reductions in strict priority order:
1. `trim-summaries`: Cuts `summary` text in half, prefixing an ellipsis
   (unless the halved remainder is empty, which stays empty).
2. `drop-authors-tail`: Halves the `authors` list, keeping the first half.
3. `drop-venue`: Drops the `venue` field entirely.
4. `drop-last-work`: Drops trailing works from the result array, down to a
   floor of one work.

Guaranteed survivals:
- `title`, `url`, and persistent `identifiers` (`doi`, `pmid`, `arxivId`) are
  **never** cut or dropped by any budget step.
- For `science get`, the single-work envelope is budgeted with the same ladder
  steps (summaries trim, authors halve, venue drops).

Envelope recovery and text rendering:
- When compaction triggers, scoutline emits a stderr notice:
  ```
  output budget: <maxChars> chars — full untrimmed envelope saved (<ref>)
  ```
- The full untrimmed envelope is stored in the local artifacts store and can
  be inspected or recovered using:
  ```bash
  scoutline history show <ref>
  ```
- Terminal and Markdown presentations (`tty`, `markdown`, `compact`,
  `refs`) are re-rendered directly from the projected data to guarantee
  that displayed text matches the compacted envelope.

## Science Journal Records Carry Persistent Identifiers

`scoutline science search` writes entries to the persistent history
journal (`~/.scoutline/artifacts/`) alongside standard `search`, `read`,
and `research` commands.

Skeleton rows recorded in the journal carry optional persistent
identifiers in `SkeletonItem.identifiers`:

```json
{
  "url": "https://doi.org/10.5555/3295222",
  "title": "Attention Is All You Need",
  "identifiers": {
    "doi": "10.5555/3295222",
    "pmid": "31672840",
    "arxivId": "1706.03762"
  }
}
```

Key behaviors:
- **Cross-supplier identity:** Because science suppliers emit differing URLs
  for identical works (e.g. OpenAlex work URL vs. DOI landing URL vs. PubMed
  record), persistent identifiers anchor the canonical identity across
  providers.
- **Backward compatibility:** Journal entries recorded without `identifiers`
  (older entries and non-science commands) continue to validate and parse
  without error or corruption warnings.
- **Content hash:** The journal's `contentHash` is the SHA-256 digest of
  the normalized skeleton serialization. It is per-entry display metadata,
  not a cross-entry deduplication anchor; new entries with identifiers hash
  differently from legacy entries.
- **Surviving arms in fan-out:** The journal entry's `provider.arms` array
  records only the supplier arms that actually fulfilled the request, rather
  than all attempted arms.

## Need more information

Run command-local help, which is the canonical option reference:

```bash
scoutline <command> --help
```

For Provider setup and connectivity, run `scoutline doctor`. To list every
configured Provider's quota, run `scoutline quota --all-providers`.