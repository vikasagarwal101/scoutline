# Scoutline Context

Scoutline presents source-investigation capabilities through stable command
meaning while external Providers supply the underlying results.

## Language

**Provider**:
An external product that supplies one or more Scoutline Capabilities. A Provider
does not need to supply every Capability.
_Avoid_: backend, vendor

**Capability**:
A user-visible meaning that can be supplied by more than one Provider, such as
Search or single-image interpretation.
_Avoid_: tool, endpoint

**Normal command**:
A predictable Scoutline command whose meaning is independent of the selected Provider.
_Avoid_: provider command, raw command

**Raw provider tool**:
A provider-qualified operation exposed without provider-neutral normalization,
such as an operation under `scoutline.zai.*`.
_Avoid_: normal command

**Provider fallback**:
The always-on default (0.11.0+) in which Scoutline silently reroutes a
shared-capability command to the next eligible configured Provider
(registry order `[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina]`) when
the selected Provider does not advertise the Capability or fails at
runtime. Every Provider switch is announced on stderr; the data
envelope on stdout is unchanged. `--no-fallback` (or
`SCOUTLINE_NO_FALLBACK=1`) restores the previous strict
single-Provider, fail-loud behavior. For `crawl` / `map` / `research`,
fallback after a runtime failure can result in two charges across
Providers because the Providers do not offer idempotency or refunds
— the kill-switch is the documented opt-out for cost-sensitive
workflows.

**Direct command**:
A command that communicates directly with a target origin or public index
without an AI provider, provider fallback, or LLM/markdown synthesis
(`scoutline fetch`, `scoutline archive`).
_Avoid_: provider command, reader command

**Evidentiary Fetch**:
Direct HTTP retrieval (`scoutline fetch <url>`) supporting binary-safe byte
preservation with checksums (`--md5`), browser-like User-Agents, and raw
REST/API interaction (`--method`, `--data`, `--header`).
_Avoid_: scrape, AI reader

**Archival Intelligence**:
Historical web index discovery and snapshot replay through the Internet
Archive Wayback Machine (`scoutline archive cdx`, `scoutline archive get`).
Keyless and deterministic; never routes to AI providers.
_Avoid_: live search, cache replay

**Provider Health Diagnostics**:
An active, concurrent operational probe (`scoutline doctor --health`) evaluating
live reachability, latency, and operational health across all configured
providers prior to pipeline dispatch (quota/credit status remains read from
stored snapshots and is not live-probed).
_Avoid_: providers command, passive diagnostics

**MiniMax Token Plan**:
The second Provider. Its confirmed source-investigation Capabilities
are Search and single-image interpretation through subscription-backed access.
The base release also normalizes its quota reporting and diagnostic probe as
operational Capabilities.
_Avoid_: MiniMax Coding Plan, MiniMax platform

**Tavily**:
The third Provider. Its confirmed Capabilities are Search, Reader
(via the Tavily extract endpoint), Crawl (multi-page website
traversal), Map (URL-set discovery without fetching pages), and
Research (asynchronous deep research with citations). The base release
also normalizes its quota reporting and diagnostic probe as
operational Capabilities. Tavily is the only Provider that advertises
`research`.
_Avoid_: Tavily API, Tavily MCP

**Exa**:
The fourth Provider. Its confirmed Capabilities are Search, Reader
(via the Exa `/contents` endpoint with per-URL status inspection),
and Research (via the Exa Agent API with `Exa-Beta` header and
state-file resume). The base release also normalizes its diagnostic
probe as an operational Capability. Quota is deferred pending
investigation of the team-management API (separate service key and
dollar-unit modeling). Exa advertises neither Crawl nor Map.
_Avoid_: Exa API, Exa AI

**Brave**:
The fifth Provider. Its confirmed Capabilities are Search (web,
news via a dedicated endpoint, and video — Brave is the only Provider
that advertises `--type video`) and the `--content-size high` overload,
which maps to the Brave LLM Context endpoint (extracted passages
joined into summaries). The base release also normalizes its quota
reporting and diagnostic probe as operational Capabilities. Brave does
not supply Reader, Crawl, Map, Research, or Vision. Brave quota is
read from `X-RateLimit-*` response headers on a probe rather than a
spend endpoint, so it reports a rate-limit window, not credits
consumed (Brave uses metered billing).
_Avoid_: Brave Search API, Brave MCP

**Firecrawl**:
The sixth Provider. Its confirmed Capabilities are Search, Reader
(via the /v2/scrape endpoint — returns genuine page titles, unlike
Tavily's null), Crawl (asynchronous multi-page traversal via /v2/crawl
with a create→poll→resume lifecycle), and Map (URL-set discovery via
/v2/map). Firecrawl is credit-based (quota unit `"credits"`, not
`"requests"`); its async crawl resumes after Ctrl-C via a state file and
reclaims an in-flight job on a lost create-POST (cost-safety). The
release also normalizes its quota reporting and diagnostic probe (a
single basic scrape) as operational Capabilities. Firecrawl does NOT
advertise `research` (/deep-research is deprecated).
_Avoid_: Firecrawl API, Firecrawl MCP

**Parallel AI**:
The seventh Provider. Its confirmed Capabilities are Search, Reader,
and Research (asynchronous deep research with citations). Parallel AI
accepts the `--topic` cross-Provider search control (via keyword
append in `applySearchTopic`) and rejects domain, recency,
content-size, location, and type controls. It does not supply Crawl,
Map, Vision, or Quota. The base release normalizes its diagnostic
probe as an operational Capability.
_Avoid_: Parallel API, Parallel AI API

**Perplexity**:
The eighth Provider. Its confirmed Capabilities are Search (via the
dedicated `/search` endpoint, which returns per-result URLs unlike
chat-completions mapping) and Research (via the `sonar-deep-research`
model on the chat-completions endpoint with `search_results[]`
citations). Perplexity accepts domain, recency, content-size, and
topic controls natively; it rejects location and type. It does not
supply Reader, Crawl, Map, Vision, or Quota. The base release
normalizes its diagnostic probe as an operational Capability.
_Avoid_: Perplexity API, Perplexity AI

**Jina AI**:
The ninth Provider. Its confirmed Capabilities are Search (via
`s.jina.ai`), Reader (via `r.jina.ai`), and Research (via
`deepsearch.jina.ai`). Jina AI is keyless-capable — `JINA_API_KEY`
is optional and enables higher rate limits but is not required.
Jina accepts the `--topic` cross-Provider search control (via keyword
append in `applySearchTopic`) and rejects domain, recency,
content-size, location, and type controls. It does not supply Crawl,
Map, Vision, or Quota. The base release normalizes its diagnostic
probe as an operational Capability.
_Avoid_: Jina API, Jina Reader API

## Flagged Ambiguities

**Vision**:
The current command family contains six single-image operations, two-image
comparison, and video analysis. The shared Capability currently proven across
Z.AI and MiniMax Token Plan is only single-image interpretation; broader Vision
parity remains unresolved.

**Crawl, Map**:
These two Capabilities are multi-provider (Tavily + Firecrawl). The
other Providers (Z.AI, MiniMax Token Plan, Exa, Brave) do not supply
them. By default (0.11.0+), selecting a non-supplier emits a stderr
notice and Provider fallback silently reroutes to the next eligible
configured supplier; the data envelope on stdout is unchanged. Under
`--no-fallback` the previous strict behavior applies and the command
returns `UNSUPPORTED_CAPABILITY`. Firecrawl's crawl is asynchronous
(credit-based, resumable after Ctrl-C); Tavily's is synchronous.

**Research**:
The `research` Capability is shared between Tavily and Exa. Firecrawl's
`/deep-research` endpoint is deprecated. By default (0.11.0+),
selecting Z.AI, MiniMax, Brave, or Firecrawl for `scoutline research`
emits a stderr notice and Provider fallback silently reroutes to the
next eligible configured supplier (Tavily or Exa). Under
`--no-fallback` the previous strict behavior applies and the command
returns `UNSUPPORTED_CAPABILITY`.

The cross-Provider search control `--topic <general|news|finance>` is NOT
a Crawl/Map/Research control; those Capabilities do not currently accept
a topic.

**fetch vs read**:
`scoutline read` is a Normal command that routes through configured AI reader
providers (Jina, Firecrawl, Tavily, etc.) to convert HTML web pages into Markdown
or extracted structured fields. `scoutline fetch` is a Direct command that
executes direct HTTP requests against target origins without AI mediation,
preserving byte-exact data (e.g. PDFs, CSVs) with `--md5` verification or
querying raw JSON REST endpoints without markdown corruption.

**archive vs read/search**:
`scoutline archive` communicates exclusively with the Internet Archive Wayback
Machine (CDX API for historical capture enumeration and `id_` raw replay). It
is a Direct command, keyless, and never routes to AI search/reader providers.

## Example Dialogue

Developer: "Does the MiniMax Token Plan Provider support every Normal command?"

Domain expert: "No. A Provider can supply only some Capabilities. MiniMax Token
Plan currently proves Search and single-image interpretation, while its Raw
provider tools remain distinct from Scoutline's Normal commands."

Developer: "Can I run a deep-research task with the Z.AI Provider?"

Domain expert: "By default (0.11.0+), yes. Scoutline emits a stderr notice
that Z.AI does not advertise `research` and silently reroutes to the
next eligible configured supplier (Tavily or Exa). If you want strict
behavior, pass `--no-fallback` (or set `SCOUTLINE_NO_FALLBACK=1`); the
command then returns `UNSUPPORTED_CAPABILITY` for Z.AI. The same
applies to `scoutline crawl` and `scoutline map` — those two are
Tavily + Firecrawl under the default, and Exa does not advertise them
either."

Developer: "Is `--topic` available on every Provider?"

Domain expert: "Yes. `--topic <general|news|finance>` is accepted by every
Provider, but its implementation differs: Tavily passes the topic natively to
its API; Z.AI, MiniMax, Parallel AI, Perplexity, and Jina AI lack a native
topic parameter, so the Adapter appends a small keyword to the query string
inside `invoke()` (see `lib/search-topic.ts`); Exa maps it to a `category`
parameter; Brave routes `news` to a dedicated news endpoint."

Developer: "Can I search for videos with the Brave Provider?"

Domain expert: "Yes. Brave is the only Provider that advertises `--type video`,
which routes to a dedicated videos endpoint. `--type` is mutually exclusive
with `--topic`. Brave also maps `--content-size high` to its LLM Context
endpoint (extracted passages joined into summaries)."

Developer: "When should I use `scoutline fetch` instead of `scoutline read`?"

Domain expert: "Use `scoutline read` when you want an AI-cleaned Markdown article
or extracted structure from a webpage across our reader providers (Jina,
Firecrawl, etc.). Use `scoutline fetch` when you need byte-exact downloads (PDFs,
datasets, archives) with cryptographic hashes (`--md5`), or when you need to
issue raw HTTP POST/JSON requests to an API without AI translation."

Developer: "Does `scoutline archive` trigger provider fallback?"

Domain expert: "No. `archive` is a Direct command targeting the Internet
Archive Wayback Machine directly. It does not use AI providers, does not
consume provider tokens, and does not fall back."
