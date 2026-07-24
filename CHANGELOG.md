# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Firecrawl Provider** as the sixth built-in Provider. New module
  `src/providers/firecrawl/` with a direct-HTTP v2 transport Adapter
  (`Authorization: Bearer`, injectable fetch/timers) and an error-envelope
  dual-check (Firecrawl returns HTTP 200 with `{success:false}` for some
  business errors → terminal `API_ERROR` 422). Default endpoint
  `https://api.firecrawl.dev`; credential `FIRECRAWL_API_KEY`. The
  production registry grows from `[zai, minimax, tavily, exa, brave]` to
  `[zai, minimax, tavily, exa, brave, firecrawl]`.
- **Firecrawl capabilities** (4 data + 2 operational):
  - `search` — `/v2/search`; `--content-size high` requests scraped
    markdown summaries (+1 credit/result); `--topic`→`sources`,
    `--recency`→`tbs`, `--domain`→`includeDomains`; rejects `--location`.
  - `reader` — `/v2/scrape` with native markdown/text; returns genuine
    page titles (richer than Tavily's null); `--no-images`→
    `removeBase64Images`; `proxy:"basic"` pinned.
  - `crawl` — asynchronous `/v2/crawl` (create→poll→resume). Resumes
    after Ctrl-C via a state file (reuses the generalized
    `lib/async-job-state.ts`) and reclaims an in-flight job on a lost
    create-POST via `GET /v2/crawl/active` (cost-safety). Rejects
    `--breadth`. Zero-retry create (shared execution).
  - `map` — `/v2/map`; `links[]`→urls.
  - `quota` — `/v2/team/credit-usage` → one "Credits" category via the
    widened `unit:"credits"` enum (additive; existing providers
    unaffected).
  - `diagnostics` — a single basic `/v2/scrape` probe (1 credit), not
    the quota endpoint (rate-limit safety).
- Firecrawl does NOT advertise `research` (`/deep-research` is
  deprecated); `--provider firecrawl research` returns
  `UNSUPPORTED_CAPABILITY`.

### Changed
- `defaultRetryPolicy("crawl")` is now `maxRetries:0` (grouped with
  `research`) — crawl is per-page cost-bearing; an auto-retried create
  could double-charge. Recovery is via state-file resume / reclaim-on-
  miss on the next user invocation. Affects Tavily crawl too (was 1).
- `lib/research-state.ts` generalized to `lib/async-job-state.ts`
  (reusable async-job resume); the persisted `requestId` field is
  unchanged for wire compatibility.

## [0.9.0] - 2026-07-24

### Added
- **Brave Provider** as the fifth built-in Provider. New module
  `src/providers/brave/` with the direct-HTTP Adapter, credentials
  module, and a shared `BraveTransportDeps` injection seam (fetch +
  timers). Default endpoint `https://api.search.brave.com`; auth via
  the `X-Subscription-Token` header; credential
  `BRAVE_SEARCH_API_KEY` (whitespace-only = absent; missing →
  `CONFIGURATION_ERROR`, exit 3). The production registry at
  `src/providers/registry.ts` now includes brave:
  `[zai, minimax, tavily, exa, brave]`.
- **Brave capabilities**:
  - `search` — default → web search (`/res/v1/web/search`);
    `--topic news` → dedicated news endpoint (`/res/v1/news/search`);
    `--topic finance` → keyword append (no Brave finance vertical);
    `--topic general` → web. `--domain` → `site:`, `--recency` →
    `freshness` (pd/pw/pm/py), `--location` → `country` (US/CN).
    `--count` is client-side (never sent to Brave). Brave is the
    **only** Provider that advertises `--type video`
    (`/res/v1/videos/search`); `--type` is mutually exclusive with
    `--topic`. `--content-size high` maps to the Brave LLM Context
    endpoint (`/res/v1/llm/context`, extracted passages joined into
    summaries); `medium`/default → web (no-op depth). Dispatch
    precedence: `video > high > news > web`. `--content-size` is a
    deliberate per-provider overload (Z.AI `content_size`; Tavily
    `search_depth=advanced`; Brave → LLM Context; MiniMax rejected as
    `UNSUPPORTED_OPTION`).
  - `quota` — Brave has no `/usage` endpoint. Quota is read from
    `X-RateLimit-*` response headers on a 1-query probe and surfaces
    the monthly rate-limit window (used/limit/remaining/%/reset); the
    per-second window is dropped. A prominent caveat warns this is a
    **rate-limit window, not spend or credits consumed** — Brave uses
    metered billing, so it is not a budget signal. The caveat prints
    to stderr and appears in the JSON output's `warnings` field.
  - `diagnostics` — 1-query web-search probe; unconfigured Brave is
    listed but skipped.
- Brave does **not** supply Reader, Crawl, Map, Research, or Vision.
  Selecting Brave for any of those returns `UNSUPPORTED_CAPABILITY`
  with no fallback.
- New environment variables: `BRAVE_SEARCH_API_KEY` (required for
  Brave), `BRAVE_TIMEOUT` (default `30000` ms).
- Operational note: Brave recently shifted from a pure free tier to
  $5 monthly metered credits (a saved card is now billable).
- **`BRAVE_SEARCH_API_KEY` redaction** — added to `CREDENTIAL_KEYS`,
  the assignment regex, and `configuredSecrets` in `lib/redact.ts`.

### Changed
- `scoutline --help` advertises `--provider <zai|minimax|tavily|exa|brave>`
  and lists Brave alongside the shared search Providers.
- `scoutline search --help` documents `--type video` (Brave-only) and
  the per-Provider `--content-size` overload including Brave's LLM
  Context mapping.
- Provider documentation across `README.md`, `docs/architecture.md`,
  `docs/configuration.md`, `docs/troubleshooting.md`, `docs/roadmap.md`,
  and `skills/scoutline/` updated to include Brave.

## [0.8.0] - 2026-07-24

### Added
- **Exa Provider** as the fourth built-in Provider. New module
  `src/providers/exa/` with the direct-HTTP Adapter, credentials
  module, and a shared `ExaTransportDeps` injection seam (fetch +
  timers). Default endpoint `https://api.exa.ai`; credential
  `EXA_API_KEY`. The production registry at
  `src/providers/registry.ts` grows from `[zai, minimax, tavily]` to
  `[zai, minimax, tavily, exa]`.
- **Exa capabilities** (3):
  - `search` — same normalized `SearchSource[]` shape; accepts
    `domain`, `recency`, `content-size`, and `topic` natively (Exa
    maps topic to a `category` parameter); rejects `location` with
    `UNSUPPORTED_OPTION`. Exa uses camelCase JSON bodies and always
    sends `contents: { highlights: true }`; `highlights[]` are
    space-joined into the `summary` field.
  - `reader` — backed by the Exa `/contents` endpoint. Implements a
    per-URL status total function: `/contents` returns HTTP 200 even
    on per-URL failure, so the adapter inspects `statuses[]` (matched
    by `id == request.url`) before reading results. Timeout conversion:
    `livecrawlTimeout = request.timeout * 1000` (CLI seconds → Exa
    milliseconds). `--format text` triggers a best-effort markdown
    strip. Z.AI-only reader options are rejected.
  - `research` — backed by the Exa Agent API (`POST /agent/runs` +
    `GET /agent/runs/{id}` poll). Requires the pinned
    `Exa-Beta: agent-2026-05-07` header on Agent endpoints only.
    State-file resume reuses the shared `lib/research-state.ts`
    (Ctrl-C + re-run polls the existing run, no second POST). Model
    mapping: `auto`→auto, `mini`→low, `pro`→high (result echoes the
    requested model). `--output-length`, `--citation-format`, and
    `--domain` are rejected (concepts the Agent lacks). `cancelled`
    status is terminal (Exa-specific).
- **Exa operational capability** (1):
  - `diagnostics` — lightweight `/search` probe with a stub query,
    fed into the existing doctor pipeline.
- **`--all-providers` quota filter** — `buildAllProvidersDashboard`
  now filters configured descriptors by advertised `quota`
  capability, so a provider without quota (Exa) is cleanly omitted
  from `scoutline quota --all-providers` (no failure entry, no exit 1).
- **`EXA_API_KEY` redaction** — added to `CREDENTIAL_KEYS`, the
  assignment regex, and `configuredSecrets` in `lib/redact.ts`.
- **CONTEXT.md** — Exa glossary entry as the fourth Provider;
  Research Flagged Ambiguity updated to reflect the Tavily+Exa
  sharing; example dialogue updated.

## [0.7.0] - 2026-07-23

### Added
- **Tavily Provider** as the third built-in Provider. New module
  `src/providers/tavily/` with the direct-HTTP Adapter, credentials
  module, and a shared `TavilyTransportDeps` injection seam (fetch +
  timers). Default endpoint `https://api.tavily.com`; credential
  `TAVILY_API_KEY`. The production registry at
  `src/providers/registry.ts` grows from `[zai, minimax]` to
  `[zai, minimax, tavily]`.
- **Tavily capabilities** (5):
  - `search` — same normalized `SearchSource[]` shape; accepts
    `domain`, `recency`, `content-size`, and `topic` natively; rejects
    `location` with `UNSUPPORTED_OPTION`.
  - `reader` — backed by the Tavily `/extract` endpoint; same
    normalized `ReaderFetchResult` shape; Z.AI-only options
    (`--with-links`, `--no-gfm`, `--keep-img-data-url`,
    `--with-images-summary`) are rejected with `UNSUPPORTED_OPTION`
    when set to `true`.
  - `crawl` — multi-page website traversal (depth 1-5, breadth 1-500,
    limit, path regex filters, natural-language `instructions`,
    per-page `--max-chars` projection). New `CrawlCapability` and
    `CrawlRequest` / `CrawlResult` contracts under
    `src/capabilities/crawl.ts`; new `scoutline crawl` command.
  - `map` — URL-set discovery without fetching pages. New
    `MapCapability` and `MapRequest` / `MapResult` contracts under
    `src/capabilities/map.ts`; new `scoutline map` command.
  - `research` — asynchronous deep research with citations (model
    `mini` / `pro` / `auto`, output length, citation format, optional
    domain restriction). Costs 4-250 credits per request. New
    `ResearchCapability` and `ResearchRequest` / `ResearchResult`
    contracts under `src/capabilities/research.ts`; new
    `scoutline research` command.
- **Tavily operational capabilities** (2):
  - `quota` — normalized `QuotaDashboard` against the Tavily account
    endpoint.
  - `diagnostics` — raw quota probe without a generative request,
    fed into the existing doctor pipeline.
- **Shared search control `--topic <general|news|finance>`** —
  accepted by every Provider. Tavily passes the topic natively to its
  API; Z.AI and MiniMax lack a native topic parameter, so the Adapter
  appends a small keyword to the query string inside `invoke()` (see
  `lib/search-topic.ts`). The appendage is skipped when the query
  already ends with the topic word (case-insensitive).
- **Research state file** at `~/.scoutline/research/<state-hash>.json`
  for resume-on-Ctrl-C. A research task runs asynchronously server-side
  (POST then poll). If the CLI exits mid-poll, the task keeps running
  and consuming credits; without persistence the next identical
  request would POST a SECOND task (a double charge). The state file
  records `{ requestId, identityHash, createdAt, status }` so the
  next invocation polls the existing task instead. Atomic creation
  via `{ flag: "wx" }`; corrupt files are deleted on read; ENOENT is
  swallowed on remove.

### Added (commands)
- `scoutline crawl <url> [options]` — multi-page website traversal.
  Options: `--depth`, `--breadth`, `--limit`, `--select-paths`,
  `--exclude-paths`, `--instructions`, `--format`, `--content-size`,
  `--timeout`, `--max-chars`, `--no-cache`. Tavily-only at launch.
- `scoutline map <url> [options]` — URL-set discovery without
  fetching pages. Options: `--depth`, `--breadth`, `--limit`,
  `--select-paths`, `--exclude-paths`, `--instructions`, `--no-cache`.
  Tavily-only at launch.
- `scoutline research <query> [options]` — deep research with
  citations. Options: `--model`, `--output-length`,
  `--citation-format`, `--domain`, `--max-chars`, `--timeout`,
  `--no-cache`. **CREDIT-INTENSIVE** (4-250 credits) — help text
  carries an explicit disclaimer. Ctrl-C preserves the in-flight task
  via the research state file; re-running the same command resumes
  polling instead of creating a new task. Tavily-only at launch.

### Changed
- `scoutline --help` now lists `crawl`, `map`, and `research` as
  top-level commands and advertises `--provider <zai|minimax|tavily>`
  for shared capabilities.
- `scoutline search --help` documents `--topic` and the per-Provider
  control map; `--domain`/`--recency`/`--content-size`/`--location`
  are explicitly Z.AI-only.
- `scoutline read --help` documents Tavily as the second Reader
  Provider and lists the Z.AI-only options it rejects.
- `scoutline doctor --help` documents the schema-v2 `capabilityMatrix`
  field and names Z.AI/MiniMax as unsupported for `crawl`/`map`/
  `research`.

### Breaking (data-mode)
- **Doctor schema v2 — `capabilityMatrix` replaces `sharedCapabilities` /
  `zaiOnlyCapabilities`.** `DiagnosticsReport.schemaVersion` bumped from `1`
  to `2` (a TypeScript literal type, so any missed consumer fails at compile
  time). The old two-array derivation silently hid any capability supplied by
  2-of-3 providers; the matrix lists, for each advertised capability, exactly
  which providers supply it. `deriveSharedCapabilities` and
  `deriveZaiOnlyCapabilities` are removed and replaced by
  `deriveCapabilityMatrix`. No capability information is lost — the matrix is
  strictly more informative.

## [0.6.4] - 2026-07-21

Boundary-tightening patch — the F3/F4/F5 follow-ups from the
`code-review-baseline` review. No current confirmed leak; these remove
the codebase's dependence on upstream message-author discipline and close
two classifier/regex precision gaps.

### Changed (boundary tightening)
- **F3 — MiniMax `ApiError` rewrap no longer echoes upstream messages.**
  `normalizeMiniMaxError` (`adapter.ts`) rebuilt the outward `ApiError`
  from `error.message` verbatim. Today every upstream ApiError message is
  a hardcoded constant, but the boundary trusted it unconditionally — a
  future change embedding a raw Provider body would leak through
  normalization, the cache, and stdout. The rewrap now builds the message
  from a status-keyed constant table. The single intentional exception is
  the 2038 real-name-verification URL (a curated upstream constant), which
  is preserved so the user sees the actionable URL.
- **F4 — encoded-error quota classifier no longer matches bare "quota".**
  `classifyEncodedMcpError` (`encoded-error.ts`) classified any encoded
  message containing the substring "quota" as terminal `QuotaError`,
  which mis-fired on non-exhaustion messages ("quota window reset
  succeeded") and blocked the legitimate single retry. Exhaustion is now
  signalled only by code 1310 (authoritative) or the explicit phrases
  "exhausted" / "limit reached" / "limit exceeded".
- **F5 — named-key redaction accepts colon separators.**
  `redactCredentialString` (`redact.ts`) accepted only `=` for
  `Z_AI_API_KEY` / `ZAI_API_KEY` / `MINIMAX_API_KEY`, so the JSON/YAML/
  HTTP-header form `Z_AI_API_KEY: sk-foo` slipped the named-key backstop.
  The separator class is now `\s*[=:]\s*`. Bare whitespace is
  intentionally NOT a separator for these names: they appear in prose
  error messages ("MINIMAX_API_KEY environment variable is required") and
  a whitespace separator would over-redact that prose (the first
  iteration of this fix did exactly that and was corrected before ship).

### Added (tests)
- F3: a thrown `ApiError` carrying a "raw body" is rebuilt from the
  status-keyed constant (raw body does not leak).
- F4: a bare-"quota" non-exhaustion message stays retryable ApiError 429
  (not terminal QuotaError).
- F5: colon-separator forms redacted; a prose mention with no separator
  token is left intact.

### Verification
Build ✓; offline suite **1676/1676** passing (+3 boundary tests). No
public CLI behaviour change for documented paths: the 2038 verification
URL still survives (existing C1 test), and the documented quota phrases
("limit reached/exceeded", "exhausted", code 1310) still classify as
terminal QuotaError (existing P6-04B tests).

### Out of scope (follow-up)
- Evaluator refinements F6/F7/F8 (chart comma-separated swap,
  extract-text semantic-key elision, loose "up" trend synonym) — defer
  until `chart` is live-attested or a semantic-keyed fixture lands.

## [0.6.3] - 2026-07-21

Patch release closing a redaction-contract gap surfaced by the
post-v0.6.2 baseline code review (`code-review-baseline` artifact).
Success-path output and response-cache writes were the two outward
boundaries that did NOT apply the recursive credential redaction the
error path and tool-discovery cache already applied. A credential
embedded in a provider response could reach stdout (via `scoutline call`
raw passthrough or `scoutline read` page content) and persist to
`~/.scoutline/cache/<hash>.json` in cleartext across runs.

### Fixed (security — redaction contract)
- **F1 — success-path output is now redacted.** `invokeCommand`
  (`command-invocation.ts`) threaded `secrets` only through the error
  branch; the success branch emitted `result.data` / presentation
  overrides verbatim. Secrets are now resolved once and applied at both
  boundaries. Most exposed surface: `scoutline call <raw-tool>` (raw
  provider response) and `scoutline read` (page content).
- **F2 — response-cache writes are now redacted.** `ZaiMcpClient.callTool`
  / `callToolWithPublicCacheIdentity` (`mcp-client.ts`) wrote raw
  responses via `writeCache`; a credential embedded in a response
  persisted in cleartext. Responses are now scrubbed (mirroring
  `writeToolCache`'s `redactTool`) before both the cache write and the
  return, so the on-disk cache and the in-memory return value are
  consistent and clean.

Both fixes use the existing `redactSecrets` / `configuredSecrets`
helpers. Redaction is a no-op for normalised Capability data (it carries
no credential-shaped fields), so legitimate output is unchanged.

### Added (tests)
- New `invokeCommand` success-redaction cases (credential-keyed field,
  presentation-override embedded value, TextCommandResult).
- New `ZaiMcpClient` response-cache-redaction case proving both the
  returned value and the on-disk cache file carry `[REDACTED]`. The prior
  suite exercised only `noCache: true`, so the cache-write path was
  previously untested.

### Verification
Build ✓; offline suite **1673/1673** passing (+4 redaction tests). No
public CLI behaviour change for normalised data. The two CRITICAL-fan-in
symbols touched (`invokeCommand`, and `writeCache`'s call sites) have
unchanged signatures; the change is additive redaction. Scoped to the
legacy response cache; the partitioned (normalised) cache stores no
credential-shaped fields and is unaffected.

### Out of scope (follow-up patches)
- F3 (MiniMax ApiError message constant-table), F4 (encoded-error bare
  `"quota"` substring), F5 (`redact.ts` separator consistency) —
  boundary-tightening passes with no current confirmed leak; tracked in
  the `code-review-baseline` artifact.

## [0.6.2] - 2026-07-21

Patch release extending MiniMax specialized-Vision runtime support from
two operations to four, plus attestation-tooling fixes that the live
re-attestation run surfaced. `extract-text` and `diagram` are now
live-attested against the direct MiniMax transport and routable through
MiniMax at runtime. `chart` remains pending: its fixture image has a
rotated, low-resolution Y-axis label that VLMs read inconsistently — a
fixture-image-quality blocker, not an evaluator or transport issue.

### Added (runtime-supported capabilities)
- **MiniMax `vision extract-text` and `vision diagram` are now supported
  at runtime** through MiniMax. The specialized-vision live-attested set
  grows from {`ui-artifact`, `diagnose-error`} to {`ui-artifact`,
  `extract-text`, `diagnose-error`, `diagram`}. Both were live-attested
  against the v0.6.0 direct transport (`scoutline-direct@0.5.0`);
  selecting MiniMax for either now routes through the Adapter instead of
  failing `UNSUPPORTED_CAPABILITY`. `chart` remains `live: pending` and
  fail-closed.

### Changed (conformance evaluators)
- The three specialized-vision conformance evaluators were loosened to
  admit natural VLM output while preserving content fidelity (the design
  intent of "do not accept paraphrase" of *content*). The previous
  evaluators required output to match a hand-crafted ideal shape; the
  offline suite passed but live VLM output varied enough to fail.
  - **diagram** (`evaluateDiagram`): edges now accept any
    intrinsically-directional connector — ASCII `->`, Unicode `→`, or a
    verb (`connects to`, `leads to`, `points to`, `goes to`, `flows to`,
    `flows into`, `feeds into`, `followed by`) — as a
    `${from} … <connector> … ${to}` match scoped to one sentence.
    Reversed edges still fail. A proposed positional "structural
    fallback" was dropped after pressure-testing (passive voice and "X
    receives from Y" defeat surface-order checks).
  - **chart** (`evaluateChart`): trend broadened to 17 word-boundary
    synonyms (`increasing`, `rising`, `upward`, `growth`, `higher`, …);
    axes matched sentence-scoped (`\bx\b`/`\by\b` word boundaries + the
    label co-occurring in the same sentence). The former
    `forbiddenTrends` naive-substring check was **removed**: it flagged
    correct answers that mentioned a forbidden word in negation ("the
    trend is increasing, not flat"). The positive trend requirement is
    the load-bearing filter.
  - **extract-text** (`evaluateExtractTextLines`): now matches on the
    alphanumeric content body after prefix/separator stripping
    (case-insensitive, forward-cursor preserved). Tolerates
    `1. hello` ≈ `Line 1: HELLO`; still rejects missing, reordered, or
    substituted content. `EXTRACT_TEXT_INTENT` also prescribes
    prefix/punctuation/casing preservation and forbids preamble/markdown
    wrappers.
- `specialized-cases.json`: the chart assertion's `forbiddenTrends`
  field removed (the evaluator no longer consults it).
- New offline rejection suite ("evaluators reject wrong answers and
  admit natural VLM variants"): reversed diagram edges, node-only
  paragraphs, wrong/swapped chart axes, wrong trend, and
  missing/reordered/substituted extract-text lines all MUST fail;
  natural variants (Unicode arrows, directional verbs, trend synonyms,
  prefix/case/fence tolerance) MUST pass. The prior suite had no
  negative cases.

### Fixed (attestation tooling — surfaced by the live re-attestation run)
- `scripts/attest-minimax-vision.mjs` was broken by the v0.6.0
  direct-transport refactor: it imported `createMiniMaxSdk` from the
  deleted `sdk-client.ts`. Rewired to the Adapter's direct path
  (`resolveImageSource` → `convertToDataUri` → `fetchMiniMaxVlm`). The
  shipped v0.6.0/v0.6.1 attestations were re-pinned via `--refresh`, so
  this breakage was not observed at release time.
- `attest-minimax-vision.mjs` `canFlipLiveState` / `flipLiveStateToPass`:
  the state-flip regex was built with `JSON.stringify(operation)`,
  producing `"diagram":` — but `diagram` and `chart` are bare object
  keys in the conformance source. The regex now treats the surrounding
  quotes as optional. Never exercised before because `diagram`/`chart`
  had never been attested.
- `vision-specialized-conformance.test.js`: "compiled attestation
  manifest matches the attested set" now compares as sets (sorted)
  rather than ordered arrays — the manifest is in append-history order
  while the attested set is canonical order, which diverge once an op is
  attested out of sequence.

### Documentation
- README, `docs/architecture.md`, `docs/configuration.md`,
  `docs/troubleshooting.md`, and `skills/scoutline/SKILL.md` updated
  for the four-operation MiniMax specialized-vision support set. Stale
  Implementation-identity references (`mmx-cli-sdk@1.0.16`) corrected to
  `scoutline-direct@0.5.0`; the troubleshooting "Adapter routing" note
  corrected from `sdk.vision.describe` to the direct VLM transport.

### Known Issues
- `chart` remains `live: pending`. Three independent VLM reads of
  `tests/fixtures/vision/chart.png` (320×200) disagree on the Y-axis
  label (Sales / Revenue / Rupees); the rotated, tiny label is
  unreadable. Regenerating the fixture image with a clear, large,
  horizontal label is the follow-up that unblocks it.

### Verification
Build ✓; offline suite **1669/1669** passing; live attestation run
**2/3 passing** (extract-text, diagram attested; chart blocked on the
fixture image). Public `scoutline.zai.*` raw tool surface unchanged.

## [0.6.1] - 2026-07-21

Patch release fixing the Z.AI Search name-translation defect that
surfaced during the 0.6.0 release's live verification run. The P2-03
public→internal name-translation fix had landed for `zread` and
reader methods but missed `webSearch` and all 8 vision methods.

### Fixed
- **Z.AI `webSearch` capability no longer fails with a generic
  "MCP tool call failed" error.** `webSearch` was routing through
  the unresolving `callTool` path, which forwarded the public dotted
  name (`scoutline.zai.search.web_search_prime`) verbatim to UTCP —
  but UTCP registered the tool under the sanitized internal name
  (`scoutline_zai.search.web_search_prime`, with the manual-segment
  dots replaced by underscores). UTCP couldn't find the public name
  and the call failed. The fix routes `webSearch` through
  `callToolWithPublicCacheIdentity`, which resolves the public name
  to the internal UTCP identity on a cache miss — the same pattern
  already in use for `zread` and reader methods.
- **All 8 vision methods (`analyze_image`, `ui_to_artifact`,
  `extract_text_from_screenshot`, `diagnose_error_screenshot`,
  `understand_technical_diagram`, `analyze_data_visualization`,
  `ui_diff_check`, `analyze_video`) received the same fix.** They
  had the identical routing bug; they were equally broken but
  unexercised by the live suite unless `ZAI_TEST_ENABLE_VISION=1`
  was set. Fixing all 9 methods (webSearch + 8 vision) in one pass
  prevents the same bug class from surfacing later.

### Changed
- Three P0-03 baseline tests in `tests/mcp-live.test.js` updated to
  reflect the fixed state:
  - **"Normal Search via webSearch reports translation defect
    (P0-03 baseline)"** — was a negative test asserting the defect
    existed (expecting `webSearch` to throw with a name-mismatch
    error). Rewritten as **"Normal Search via webSearch returns a
    Z.AI result array (P2-03 regression)"** — a positive regression
    test asserting `webSearch` succeeds and returns an array. The
    stale negative structure should have been flipped when P2-03
    landed but wasn't.
  - **"includes expected core tools"** — search tool name corrected
    from `webSearchPrime` (camelCase) to `web_search_prime`
    (snake_case) to match what the Z.AI server actually exposes.
    Reader keeps `webReader` (camelCase — the server exposes reader
    under that exact name).
  - **"calls every discovered tool via mapped raw names"** — same
    snake_case correction for the search handler key + invocation.

### Verification

Build ✓; offline suite **1668/1668** passing (unchanged from 0.6.0
— the fix is live-gated); live run **6/6 passing** (3 Z.AI tests
that previously failed now pass; 2 MiniMax parity tests still pass;
1 discovery smoke test still passes). Public `scoutline.zai.*` raw
tool surface unchanged.

## [0.6.0] - 2026-07-21

The MiniMax direct-transport series lands ten commits across three
phases (A: foundation; B: adapter rewire; C: release verification).
The transitional `mmx-cli/sdk` runtime dependency is removed from
the Adapter's call path and replaced with two pure functions that
POST directly to the MiniMax Coding Plan endpoints. The SDK remains
installed as a devDependency so the live envelope-parity test can
compare the new transport against the legacy SDK for ongoing
regression coverage.

### Added
- `packages/scoutline/src/providers/minimax/coding-plan-client.ts`
  direct-transport module. Two pure functions (`fetchMiniMaxSearch`,
  `fetchMiniMaxVlm`) plus a shared `MiniMaxTransportDeps` shape
  mirror the existing `quota-client.ts` pattern. Owns HTTP-status
  error mapping (Layer 1) and `base_resp.status_code` error mapping
  (Layer 2). Sends `MM-API-Source: Scoutline` and
  `User-Agent: scoutline/<version>` headers.
- `convertToDataUri` in `packages/scoutline/src/providers/minimax/media.ts`.
  Performs the data-URI conversion the SDK used to do. Three branches:
  `data:` passthrough, HTTP fetch (30 s timeout via injected
  `setTimeout`, 50 MiB cap), local file read. MIME table mirrors the
  SDK's `IMAGE_MIME_TYPES` 1:1.
- Unified `MiniMaxTransportDeps` injection seam (replaces
  `sdkConstructor` + `quotaFetch`/`quotaSetTimeout`/`quotaClearTimeout`).
  Flows through `MiniMaxAdapterDependencies.transport` to all
  capabilities (search, vision, quota, diagnostics).
- `ProviderImageFetchResponse` type in `providers/types.ts`. Extends
  `ProviderQuotaFetchResponse` with `headers` and `arrayBuffer` for
  image-fetching transports.
- Optional `help` parameter on `TimeoutError` (strict superset of the
  previous signature; existing Z.AI callers unchanged).
- Layer T1 transport contract tests:
  `tests/minimax-coding-plan-client.test.js` (119 tests covering every
  HTTP status + every `base_resp` code, MIME matrix, sentinel
  message-integrity across all error paths).
- Adapter-level regression test in `tests/minimax-adapter.test.js` for
  the 2038 verification URL survival through `normalizeMiniMaxError`.
- Offline helper tests for the attestation script:
  `tests/attest-minimax-vision-helpers.test.js` (15 tests including a
  regression test for the manifest-manipulation bug discovered during
  live verification).
- Live envelope-parity fixture in `tests/mcp-live.test.js`. Compares
  direct-transport responses against the legacy SDK; verifies MiniMax
  does not echo `MM-API-Source` / `User-Agent` into response bodies.
  Gated behind `ZAI_LIVE_TESTS=1` + `MINIMAX_API_KEY`.
- `--refresh` flag on `scripts/attest-minimax-vision.mjs`. Re-issues
  attestations against a new implementation identity; refuses by
  default to prevent accidental overwrite; refuses `"fail"` state
  unconditionally.
- `scripts/lib/attest-manifest.mjs`. Pure manifest-manipulation
  helpers extracted from the attestation script for testability.

### Changed
- MiniMax Adapter rewired. `adapter.ts` calls `fetchMiniMaxSearch` /
  `fetchMiniMaxVlm` (direct transport) instead of constructing
  `MiniMaxSDK` instances. Three call sites updated; specialized-vision
  path inserts `convertToDataUri` between `resolveImageSource` and
  `fetchMiniMaxVlm`. `createMiniMaxDescriptor` consumes the unified
  `transport` seam.
- `normalizeMiniMaxError` preserves typed errors through the rewrap:
  `QuotaError` passes through (terminal retry preserved); `ApiError`
  message preserved (2038 verification URL survives); `AuthError` uses
  the 2-arg form (keeps `MINIMAX_API_KEY` in help text); `TimeoutError`
  uses `MINIMAX_TIMEOUT` help text (was `Z_AI_TIMEOUT`).
- MiniMax error code mapping tightened. `base_resp.status_code` 1028/1030
  (quota exhausted) now throws `QuotaError` (was `ApiError`); 1004
  (invalid key) → `AuthError` with `MINIMAX_API_KEY` keyName; 2038
  (real-name verification) → `ApiError(403)` with verification URL;
  1002/1039 (content filter) → `ApiError(400)`; 2061 (wrong plan) →
  `ApiError(403)`.
- MiniMax request headers changed: `MM-API-Source: Scoutline` (was
  `Minimax-MCP`); `User-Agent: scoutline/<version>` (was
  `mmx-cli/<version>`). Live envelope-parity fixture confirms MiniMax
  does not echo these into response bodies.
- `MINIMAX_VISION_IMPLEMENTATION_ID` bumped from `mmx-cli-sdk@1.0.16`
  to `scoutline-direct@0.5.0`. Both shipped attestations (`ui-artifact`,
  `diagnose-error`) re-pinned; `mappingRevision` values refreshed
  (Implementation ID participates in the SHA-256 digest, so all five
  revisions regenerated). Live re-attestation against the direct
  transport confirmed both operations still pass.
- `mmx-cli` moved from runtime `dependencies` to `devDependencies`.
  The direct transport owns the runtime path; the SDK remains for the
  live envelope-parity test. Exact-pin `1.0.16` preserved.
- Boundary test (`tests/provider-boundary.test.js`) enforces ZERO
  `mmx-cli/sdk` imports across the source tree (was: exactly one
  allowed in `sdk-client.ts`).
- Attestation script's `removeAttestationFromManifest` replaced with a
  brace-counting parser (handles nested objects inside `assertions`
  arrays; the previous regex corrupted the manifest on entries with
  nested `{...}`).
- Attestation script's `main()` calls a read-only `canFlipLiveState`
  precheck BEFORE writing (was: write first, check after — could leave
  a partial manifest on refusal).

### Removed
- `packages/scoutline/src/providers/minimax/sdk-client.ts` deleted.
  The `MMX_CONFIG_DIR` sentinel workaround disappears with it.
- `MiniMaxSdkPort` and `MiniMaxSdkConstructor` types removed from
  `providers/types.ts`.
- Two obsolete Adapter-layer scrubbing tests removed from
  `tests/minimax-adapter.test.js`. The raw-body-scrubbing invariant
  moved to the transport layer via T1 sentinel message-integrity
  tests at `tests/minimax-coding-plan-client.test.js`.

### Fixed
- `QuotaError` no longer downgraded to a retryable `ApiError(500)` by
  the Adapter's `normalizeMiniMaxError` rewrap. Exhausted-quota
  requests now terminate after one attempt instead of being retried.
- 2038 real-name-verification URL no longer stripped from the error
  message by the Adapter rewrap. Users hitting the China-platform
  verification requirement now see the actionable URL.
- `MINIMAX_API_KEY` name now appears in `AuthError` help text for
  MiniMax auth failures.
- `MINIMAX_TIMEOUT` now appears in `TimeoutError` help text for
  MiniMax timeouts (was hardcoded to `Z_AI_TIMEOUT`).

### Known Issues
- Three live-only Z.AI translation-defect baseline tests fail in
  `tests/mcp-live.test.js` (`includes expected core tools`,
  `Normal Search via webSearch reports translation defect`,
  `calls every discovered tool via mapped raw names`). These are
  pre-existing — unrelated to the MiniMax direct-transport work —
  and tracked in a separate follow-up ticket. Does not affect
  MiniMax-direct-transport behavior; targeting a `0.6.1` patch
  release once root-caused.

## [0.5.0] - 2026-07-20

The Cache Module Unification series lands three commits across two
parallel tickets (02: tool cache extraction from `ZaiMcpClient`; 03:
CLI surface + Doctor + documentation migration). The release gate
will promote this section to a versioned entry once the cohesive cold
review returns DELIVERED or DELIVERED WITH RESIDUAL RISK.

### Added
- `scoutline cache` command with `stats` and `clear` subcommands.
  `scoutline cache stats` prints the unified cache directory, status
  (enabled/disabled, TTL, size cap), and per-subdirectory entry count
  and total size for both the response cache and the tool discovery
  cache. `scoutline cache clear` deletes every file under `<root>/cache/`
  and `<root>/tools/` while preserving the directory shells (no
  directory-creation race on the next invocation) and reports the count
  and bytes freed. The orphaned legacy `~/.cache/zai-cli/` directory is
  never touched.
- One-line cache summary embedded in the `DiagnosticsReport` returned
  by `scoutline doctor` under the `cache.summary` field. The summary
  is formatted by the dispatcher from `cacheStats()` output and threaded
  through `DoctorDiagnosticsDependencies.cacheSummary`; the report
  builder only embeds it (L1 fix from the cold-critique).
- Unified on-disk cache layout: `~/.scoutline/cache/` (Provider
  responses) and `~/.scoutline/tools/` (MCP tool discovery) as sibling
  subdirectories under one root. Same convention on Linux, macOS, and
  Windows.
- Unified environment-variable surface: `SCOUTLINE_CACHE`,
  `SCOUTLINE_CACHE_TTL_MS`, `SCOUTLINE_CACHE_SIZE_MB`, and
  `SCOUTLINE_CACHE_DIR` control both caches.
- Extracted `src/lib/tool-cache.ts`. The tool-discovery cache that
  previously lived inline in `src/lib/mcp-client.ts` (`ZaiMcpClient`)
  is now its own module with its own enable check, versioned envelope,
  redaction-on-write, and TTL semantics. Consumed by `ZaiMcpClient`;
  the response cache never touches it.
- New `tests/tool-cache.test.js` covering the extracted tool-discovery
  cache and new `tests/cache-command.test.js` covering the
  `cache stats` / `cache clear` command surface (format helpers, exit
  codes, isolated `SCOUTLINE_CACHE_DIR`, doctor embeds the summary).

### Changed
- Cache directory renamed from `~/.cache/zai-cli/` (XDG-flavoured) to
  `~/.scoutline/` (dotfile). Both `cache/` and `tools/` live under one
  root on every platform.
- Cache environment variables renamed: the previous `ZAI_CACHE*` and
  the tool-cache-specific `ZAI_MCP_TOOL_CACHE*` / `ZAI_MCP_CACHE_DIR`
  are replaced by `SCOUTLINE_CACHE*`. Old names remain as silent
  lower-precedence aliases.
- All cache env reads are call-time (H1 fix). Module-load capture was
  removed so per-suite env mutations in tests remain observable.
  Affects `isCacheEnabled`, `getCacheTtlMs`, `getCacheSizeCapBytes`,
  and the tool-cache enable check.
- `cacheStats()` return shape extended with nested `responseCache`
  and `toolCache` sections. The previous top-level `entries` and
  `totalBytes` fields are removed; callers must read from the nested
  sections. `clearAllCaches()` returns `{ responsesCleared,
  toolsCleared, bytesFreed }`.
- The LRU eviction loop in `src/lib/cache.ts` scans `cache/` only and
  never deletes files under `tools/`. Eviction coupling between the
  two caches is now structurally impossible.
- Doctor's `DiagnosticsReport` carries an optional `cache` field. The
  field is present when the dispatcher supplies a `cacheSummary`
  through `DoctorDiagnosticsDependencies`; older callers that omit
  the dependency produce a report without the field (backward
  compatible).

### Removed
- `XDG_CACHE_HOME` consultation. The unified cache adopts the dotfile
  convention (`~/.scoutline/`) on every platform; the Linux-only
  XDG branch is gone.
- `ZAI_MCP_TOOL_CACHE*` independence. The tool cache no longer has its
  own enable/TTL env vars; `SCOUTLINE_CACHE*` controls both caches.
  Old names alias silently to the unified names. (The D3 granularity
  deviation in `src/lib/cache.ts` is preserved: setting `SCOUTLINE_CACHE=0`
  disables BOTH caches; the legacy `ZAI_MCP_TOOL_CACHE=0` alone still
  disables ONLY the tool cache so existing operator configurations
  keep working.)
- Top-level `entries` and `totalBytes` fields on `cacheStats()` output.
  Callers must read `responseCache.entries` / `toolCache.entries`
  (and the matching `totalBytes`) instead.

### Migration
- **Hard cut.** The new code never reads from `~/.cache/zai-cli/`.
  The directory is not migrated and not deleted; clean it up manually
  with `rm -rf ~/.cache/zai-cli/`.
- First invocation creates `~/.scoutline/cache/` and
  `~/.scoutline/tools/` fresh. Response cache entries start fresh
  (24h TTL); tool cache re-discovers on first call.
- Old `ZAI_CACHE*` / `ZAI_MCP_TOOL_CACHE*` / `ZAI_MCP_CACHE_DIR` env
  vars are silently accepted as lower-precedence aliases. An operator
  with `ZAI_CACHE=0` in their shell profile sees the same behaviour
  (caching disabled) with no warning. `SCOUTLINE_CACHE*` wins when
  both are set.
- Inspection and clearing: prefer `scoutline cache stats` and
  `scoutline cache clear` over manually deleting files. The CLI
  commands honour the unified env policy and never race with running
  invocations.

## [0.4.0] - 2026-07-20

### Added
- Provider-selected Reader Capability. `scoutline read` participates in the
  existing Provider selection order (explicit `--provider`, then
  `SCOUTLINE_PROVIDER`, then default `zai`). The Z.AI descriptor advertises
  the `reader` Capability and the Z.AI Reader Adapter
  (`src/providers/zai/reader.ts`) supplies it through a typed
  `executeReaderOperation` wrapper over `executeProviderOperation`
  (`src/lib/execution.ts`). MiniMax does not advertise the Capability;
  selecting MiniMax (explicitly or via the environment) for `read` returns
  `UNSUPPORTED_CAPABILITY` before descriptor configuration, Adapter creation,
  credential resolution for use, cache identity, or transport construction,
  with no implicit Z.AI fallback.
- Schema-version-1 Reader result envelopes. Content reads return
  `{schemaVersion, url, finalUrl, title, content, contentFormat, truncated,
  originalContentLength}` (with optional `metadata` and `external` when the
  Provider returns them). Extract reads (`--extract code|links|tables|
  headings`) return `{schemaVersion, url, finalUrl, mode, items, truncated,
  originalItemCount}`. The four extract modes and their item shapes are
  unchanged from v0.2; only the outer envelope is new. The total decoder
  starts from `unknown`, rejects malformed values without throwing, and
  preserves `metadata`/`external` verbatim when present.
- URL rewrite observability. The Provider-side URL rewrite (today: gist
  URLs to their raw form) is recorded as the `finalUrl` field on every
  Reader envelope. The v0.2 stderr rewrite notice is removed; the signal
  now lives in the result. The rewrite is idempotent on URLs already
  ending in `/raw` and preserves fragments.
- Reader cache namespace
  `v2.reader-reader-fetch.<provider>.<credential-hash>.<request-hash>.json`,
  where the credential hash is the full lowercase SHA-256 hex digest of
  the Adapter-resolved credential and is never re-hashed by cache code.
  The canonical request URL is the **rewritten** URL so two requests that
  normalize to the same fetched URL (e.g. `gist.github.com/<id>` and
  `gist.github.com/<id>/raw`) share one cache entry. Legacy v0.2 Z.AI
  cache entries remain readable **read-only** — their key is reconstructed
  from the same Adapter-resolved credential using the exact v0.2 args-
  order algorithm (the Adapter never sends `no_cache`, so `--no-cache`
  entries written by v0.2 — if any — are intentionally unreconstructible;
  the contract requires `--no-cache` to perform no reads or writes).
  `--no-cache` performs no reads or writes. Injected credentials drive the
  fingerprint and legacy-key construction; ambient environment is never
  reread.
- Encoded MCP error taxonomy for Reader operations, recognized before
  success parsing through the shared `classifyEncodedMcpError` helper
  factored out of `repository.ts` in 0.3.0 (`src/providers/zai/encoded-error.ts`).
  Exhausted WebReader quota (code `1310` or explicit exhausted-limit
  meaning) surfaces as a normalized `QUOTA_ERROR` 429 and is terminal;
  transient 429/5xx and a malformed envelope retry once; auth 401/403 and
  other 4xx are terminal. Raw Provider body, reset metadata, and error-
  text strings are discarded. The P6-04A/B/C corrections (code 1310 wins
  regardless of status; "rate limited" excluded; "limit reached/exceeded"
  included; 403 → `AUTH_ERROR` status 403 exact; 5xx retryable) apply to
  Reader for free.
- Descriptor-derived `DiagnosticsReport` inventories extended to Reader.
  `reader` appears under `zaiOnlyCapabilities` while still participating
  in selection, and Doctor help names MiniMax as unsupported for `read`.
- A fake second Reader Adapter conformance suite under
  `tests/helpers/fake-adapter.js` and `tests/reader-conformance.test.js`
  that proves the seam without making MiniMax claim support. The fake
  Adapter is registered under the `"zai"` ID because production
  `parseProviderId` rejects unknowns — this proves the dispatcher branches
  on descriptor metadata and Adapter handles, never on Provider ID itself.
  The matrix asserts byte-identical public stdout across content × extract
  × {data, json, pretty, compact}.

### Changed
- **`scoutline read` data-mode success payloads are intentionally
  breaking.** This release replaces the v0.2 raw content string for
  content reads and the bare JSON array for extract reads with the
  schema-version-1 contract. The migration table:

  | Read shape | v0.2 (legacy, now obsolete) | v1 (current) |
  | --- | --- | --- |
  | Content read (default) | Raw content string | `{schemaVersion, url, finalUrl, title, content, contentFormat, truncated, originalContentLength}` |
  | Extract read (`--extract <mode>`) | Bare JSON array of items | `{schemaVersion, url, finalUrl, mode, items, truncated, originalItemCount}` |

  Any consumer that did `scoutline read URL > file.md`, `scoutline read
  URL | jq -r .content`, or `scoutline read URL --extract code | jq -c .[]`
  against v0.2 output must switch to the v1 envelope.
- Output modes for `read` results are intentionally asymmetric with `repo`
  because Reader content is naturally prose:
  - `data` emits the schema-version-1 envelope object (content or extract).
  - `json` and `pretty` emit the standard `{success, data, timestamp}`
    envelope (indent 0 for `json`, indent 2 for `pretty`).
  - Text-oriented modes (`compact`, `markdown`, `refs`, `tty`) emit the
    `content` string directly for **content reads** (prose presentation);
    they fall back to the JSON envelope for **extract reads** because
    extracted items are data, not prose. (`repo` always supplies JSON
    fallback because every `repo` result is structured data.)
- The v0.2 URL rewrite **stderr notice is removed**. The same signal now
  lives on the `finalUrl` field of every Reader envelope. Scripts that
  parsed the stderr notice must read `finalUrl` from the v1 result.
- The `--full-envelope` flag is **silently deprecated**. It is still
  accepted for compatibility but has no effect and emits no warning: the
  envelope is always returned at v1. The deferred decision to add a
  one-time deprecation notice in a future release is recorded in the
  reader-migration-core-flows artifact.
- `--max-chars` is **ignored on extract reads.** Content reads truncate
  the envelope's `content` (set `truncated: true` and preserve
  `originalContentLength`); extract reads report `originalItemCount`
  instead because truncating a code block or link list mid-item would be
  harmful. `--max-chars` never invokes a model — it is post-normalization
  projection only.
- The static `commands/read.ts` Module is now a thin read handler: parse-
  level validation (URL scheme, `--extract` mode), `executeReaderOperation`
  invocation, schema-v1 envelope projection (`--max-chars` content
  truncation, `--extract` slicing), and output-mode presentation. Provider
  selection (explicit `--provider`, `SCOUTLINE_PROVIDER`, default Z.AI),
  the capability support gate, the configured-but-unconfigured check, and
  Adapter creation live in `src/index.ts`. Direct `ZaiMcpClient`
  construction/close, raw WebReader name resolution, URL rewrite, response
  parsing, cache/retry policy, and close lifecycle have moved to the Z.AI
  Reader Adapter. Reader has no Explorer module — a single fetch does not
  need one; projection lives in the thin handler.
- `ZaiMcpClient.webRead` TypeScript return type widened from `Promise<string>`
  to `Promise<ReaderRawResponse>` (`ReaderRawObjectResponse | string`). The
  characterization probe proved the runtime shape was always the union;
  the v0.2 type was a lie. The package's `main` entry is the CLI dispatcher
  and does not re-export `ZaiMcpClient` or `webRead`, so external consumers
  are unaffected unless they deep-import `scoutline/dist/lib/mcp-client.js`
  (a discouraged pattern). Internal callers were migrated: the Reader
  Adapter uses `callToolRaw` directly and `commands/tools.ts` uses
  `callToolRaw`; zero `.webRead(` call sites remain in `src/`. The
  `webRead` wrapper itself stays on `ZaiMcpClient` for raw-tool callers
  (`scoutline.zai.reader.webReader` via `tools` / `tool` / `call`).
- The shared encoded-MCP error classifier (`src/providers/zai/encoded-error.ts`)
  introduced in 0.3.0 is reused by the Reader Adapter. The Reader migration
  consumed the P6-04A/B/C corrections for free with zero changes to the
  classifier; `repository.ts` and `reader.ts` share one helper.

### Out of scope (not added)
- MiniMax Reader Adapter implementation. MiniMax still does not advertise
  `reader`; an explicit MiniMax `read` fails closed with
  `UNSUPPORTED_CAPABILITY`.
- mmx-cli/sdk replacement (still pinned to `1.0.16` for the MiniMax
  Search/Vision transport).
- Removing the deprecated `--full-envelope` flag.
- Future `--max-items` truncation policy for extract reads.
- Automatic summarization or an implicit `--summarize` mode.
- Reopening P5 specialized Vision attestation state.

## [0.3.0] - 2026-07-20

### Added
- Provider-neutral repository exploration. `scoutline repo search`,
  `scoutline repo read`, and `scoutline repo tree` participate in the
  existing Provider selection order (explicit `--provider`, then
  `SCOUTLINE_PROVIDER`, then default `zai`). The Z.AI descriptor
  advertises the `repository-exploration` Capability and the Z.AI
  Repository Adapter supplies it through a Provider-neutral Explorer
  (`src/commands/repository-explorer.ts`) plus shared
  `executeRepositoryOperation` (`src/lib/execution.ts`). MiniMax does not
  advertise the Capability; selecting MiniMax (explicitly or via the
  environment) returns `UNSUPPORTED_CAPABILITY` before descriptor
  configuration, Adapter creation, credential resolution for use, cache
  identity, or transport construction, with no implicit Z.AI fallback.
- Schema-version-1 structured `repo` successes (`RepositorySearchResult`,
  `RepositoryFileResult`, `RepositoryTreeResult`) with strict request
  defaults: Search carries `language: "en" | "zh"`, Directory root is
  `path: ""`, File paths are non-root, repeated and trailing `/`
  collapse, leading `./` is normalized on File, and actual `.`/`..`
  segments, backslashes, and ASCII control characters are rejected.
  Provider sibling order and Search excerpt order are preserved.
- Deterministic, local `--max-chars` projection. `--max-chars` never
  invokes a model. Absent, zero, or negative means no truncation.
  `repo search` applies one total budget across `excerpts[].text` in
  Provider order, truncates the final retained excerpt with the existing
  ellipsis rule, and omits later excerpts. `repo read` truncates only
  `content` and preserves `originalContentLength`. `repo tree` is never
  character-limited. The flag is post-normalization projection — it
  never enters the Provider request or cache identity.
- Repository cache namespace
  `v2.repository-exploration-<operation>.<provider>.<credential-hash>.<request-hash>.json`,
  where the credential hash is the full lowercase SHA-256 hex digest of
  the Adapter-resolved credential and is never re-hashed by cache code.
  Legacy v0.2 Z.AI cache entries remain readable **read-only** — their
  key is reconstructed from the same Adapter-resolved credential using
  the exact v0.2 algorithm, and a valid hit is written through to the
  new key without rewriting, migrating, or deleting the legacy file.
  `--no-cache` performs no reads or writes. Injected credentials drive
  the fingerprint and legacy-key construction; ambient environment is
  never reread.
- Encoded MCP error taxonomy for repository operations, recognized
  before success parsing. Exhausted ZRead quota (code `1310` or explicit
  exhausted-limit meaning) surfaces as a normalized `QUOTA_ERROR` 429
  and is terminal. Transient 429 / 5xx and a malformed envelope retry
  once. Auth 401/403 and other 4xx are terminal. Raw Provider body,
  reset metadata, and error-text are discarded.
- Best-effort per-attempt transport close. Each `operation.invoke`
  creates a fresh ZRead client with internal cache and retry disabled
  and best-effort closes it once in `finally`, bounded by the existing
  2000 ms semantic. Close rejection or timeout never replaces a
  successful result or masks a primary failure. Cache hits construct
  and close no transport.
- Descriptor-derived `DiagnosticsReport` inventories. `sharedCapabilities`
  is the intersection across built-in Provider capabilities; `zaiOnlyCapabilities`
  is Z.AI support minus the union of every other built-in Provider.
  `repository-exploration` therefore appears under Z.AI-only while still
  participating in selection, and Doctor help names MiniMax as
  unsupported for `repo`.
- A fake second Repository Adapter conformance suite under
  `tests/helpers/fake-adapter.js` and `tests/repository-conformance.test.js`
  that proves the seam without making MiniMax claim support, plus an
  integrated legacy-cache, retry, transport, close, selection, and
  credential-clean test matrix.

### Changed
- **`scoutline repo` data-mode success payloads are intentionally
  breaking.** This release replaces the v0.2 raw-string Search/File
  returns and the depth-dependent raw Tree/deep-snapshot shape with the
  schema-version-1 contract. Any consumer parsing the v0.2 raw text or
  the v0.2 split-depth Tree shape must switch to the v1 fields. The
  raw `scoutline.zai.*` namespace remains available for callers that
  need the legacy grammar; it is not wrapped in the v1 envelope.
- Output modes for `repo` results:
  - `data` emits the raw schema-version-1 value as plain JSON (no envelope).
  - `json` and `pretty` emit the standard `{success, data, timestamp}`
    envelope (indent 0 for `json`, indent 2 for `pretty`).
  - Text-oriented modes (`compact`, `markdown`, `refs`, `tty`) receive
    the JSON fallback — the same value as `data` mode — because `repo`
    supplies no per-mode prose presentation override.
  Root Tree path is `""` and Tree is structured at every depth
  including depth 1.
- Search default `language` is `"en"`; pass `--language zh` for Chinese.
  File paths must be non-root; canonical paths normalize leading and
  trailing separators, collapse repeated `/`, and reject actual `.`/
  `..`, backslashes, and ASCII controls. Percent escapes are never
  decoded — they remain literal characters in the canonical path.
- The static `commands/repo.ts` Module is now a thin command routing
  layer: parse-level validation, dispatch table, Explorer invocation,
  and `CommandResult` wrapping. Provider selection (explicit
  `--provider`, `SCOUTLINE_PROVIDER`, default Z.AI), the capability
  support gate, the configured-but-unconfigured check, and Adapter
  creation live in `src/index.ts`. Direct `ZReadMcpClient`
  construction/close, raw ZRead name resolution, response parsing,
  cache/retry policy, and close lifecycle have moved to the
  Provider-neutral Explorer, shared execution, and the Z.AI Repository
  Adapter.
- Specialized MiniMax Vision mappings remain independent and conformance-
  gated; they are not claimed complete by this release. The conformance
  registry, attestation workflow, fallback behavior, and the `vision.diff`
  / `vision.video` Z.AI-only scope are unchanged.

### Out of scope (not added)
- MiniMax repository implementation.
- Reader migration.
- Automatic summarization or an implicit `--summarize` mode.
- Dynamic Provider loading or external Adapter packages.
- Implicit Z.AI fallback for an unsupported Provider.
- Reopening P5 specialized Vision attestation state.

## [0.2.0] - 2026-07-18

### Added
- Provider selection (`--provider <zai|minimax>` / `SCOUTLINE_PROVIDER` /
  default `zai`) for shared capabilities: `search`, `vision analyze`,
  `quota`, `doctor`. Unknown or empty values fail with `VALIDATION_ERROR`
  before any Provider invocation; credentials never participate in selection.
- MiniMax Token Plan Provider Adapter. Supports Search, general single-image
  Vision (`vision analyze`), normalized quota, and Provider diagnostics.
  Implemented on top of the transitional `mmx-cli/sdk@1.0.16` for Search and
  Vision, with a narrow Adapter-local transport for quota. Configured via
  `MINIMAX_API_KEY`, `MINIMAX_REGION` (`global` default, `cn`), and an
  optional `MINIMAX_BASE_URL` HTTPS override.
- `quota` command returns a schema-version-1 normalized `QuotaDashboard`
  (ADR-0001). Default mode reports the effective Provider; `--all-providers`
  queries every configured Provider in registry order with settled
  collection, preserves successful entries, and exits 1 when any Provider
  fails.
- `doctor` command returns a schema-version-1 `DiagnosticsReport` listing
  every built-in Provider with its configured state, declared Capabilities,
  and probe status. Probes every configured Provider unless `--no-tools` is
  supplied. Z.AI connectivity uses MCP tool discovery; MiniMax connectivity
  uses a raw single-attempt quota probe.
- Provider-partitioned cache keys (`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`).
  Legacy `zai-cli` cache entries remain readable for Z.AI as Adapter-owned
  candidates; old entries are never migrated or deleted.
- Recursive, case-insensitive credential redaction at every outward
  boundary: output, errors, diagnostics, quota failures, cached metadata,
  and fatal shell errors. Covers `Z_AI_API_KEY`, `ZAI_API_KEY`,
  `MINIMAX_API_KEY`, Bearer / `x-api-key` values, and embedded credential
  strings.
- Specialized MiniMax Vision conformance registry and attestation workflow.
  Five operations (`ui-artifact`, `extract-text`, `diagnose-error`,
  `diagram`, `chart`) have dedicated prompt-composition modules with
  offline-conformance fixtures, generated SHA-256 mapping revisions, and a
  per-operation live attestation script. Two operations (`ui-artifact`,
  `diagnose-error`) are live-attested and enabled at runtime; the remaining
  three are offline-pass but pending live conformance.

### Fixed
- Raw Provider response bodies no longer leak to public error output.
  Adapter error normalization, MCP init paths, and Code Mode init paths
  now surface clean typed messages while preserving error codes and status
  for retry classification.
- `ZAI_API_KEY` alias fully honored by the Z.AI adapter (was only accepted
  by `lib/config.ts`; the adapter read `Z_AI_API_KEY` exclusively).
- Provider selection default (`zai`) no longer consults credentials or
  descriptors (FR-003 compliance). The "is configured?" check moved to
  the dispatch layer.
- Missing credentials throw `ConfigurationError` (exit 3) instead of
  `AuthError` (exit 1). `AuthError` is reserved for Provider-rejected
  credentials (401/403).
- Retry classification corrected: HTTP 404 is terminal (was retried as
  500); unexpected-system errors map to positive 500 (was negative -500,
  which escaped retry).
- Injected `MainDependencies.env` credentials properly redacted (was
  reading ambient `process.env` only).
- Invalid `--count` values rejected with `VALIDATION_ERROR` before provider
  resolution or credential checks. `--count` without a value is an error.
  Uses `Number.isSafeInteger`.
- Offline test suite makes zero network calls regardless of ambient
  credentials (NFR-001 compliance).
- Pre-invocation errors (invalid provider, invalid output mode) respect
  the requested output format.
- `TimeoutError` preserves original duration when rewrapped by adapters.

### Changed
- Quota output is now a schema-version-1 normalized `QuotaDashboard`
  (ADR-0001). Provider-specific quota fields (Z.AI `usageDetails`,
  `nextResetTime` shape; MiniMax `model_remains`, `end_time`,
  `weekly_end_time`) no longer cross the Interface. The previous
  Z.AI-specific quota payload is replaced — this is a deliberate
  machine-readable compatibility change. See `docs/adr/0001-normalize-provider-quota-output.md`.
- Z.AI Search public tool names resolve through `scoutline.zai.*` and use the
  Adapter's name-translation fix; the previous UTCP internal sanitized names
  (`web_search_prime` and similar) are reachable only via the raw
  `scoutline call` flow.

## [0.1.0] - 2026-07-16

### Added
- Scoutline CLI for visual media, web, and repository source investigation.
- Provider-qualified Z.AI raw-tool namespace: `scoutline.zai.*`.