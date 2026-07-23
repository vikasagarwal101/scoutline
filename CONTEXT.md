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
operational Capabilities. Tavily alone advertises `crawl`, `map`, and
`research` at launch.
_Avoid_: Tavily API, Tavily MCP

**Brave**:
The fourth Provider. Its confirmed Capabilities are Search (web,
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

## Flagged Ambiguities

**Vision**:
The current command family contains six single-image operations, two-image
comparison, and video analysis. The shared Capability currently proven across
Z.AI and MiniMax Token Plan is only single-image interpretation; broader Vision
parity remains unresolved.

**Crawl, Map, Research**:
These three Capabilities are Tavily-only at launch. They are not
shared with Z.AI, MiniMax Token Plan, or Brave, and there is no
Provider fallback. Selecting a non-Tavily Provider for any of these
commands returns `UNSUPPORTED_CAPABILITY` with no fallback. The cross-Provider
search control `--topic <general|news|finance>` is NOT a Crawl/Map/
Research control; those Capabilities do not currently accept a topic.

## Example Dialogue

Developer: "Does the MiniMax Token Plan Provider support every Normal command?"

Domain expert: "No. A Provider can supply only some Capabilities. MiniMax Token
Plan currently proves Search and single-image interpretation, while its Raw
provider tools remain distinct from Scoutline's Normal commands."

Developer: "Can I run a deep-research task with the Z.AI Provider?"

Domain expert: "No. Tavily is the only Provider that currently advertises the
`research` Capability. Selecting Z.AI or MiniMax for `scoutline research`
returns `UNSUPPORTED_CAPABILITY` with no fallback. The same is true for
`scoutline crawl` and `scoutline map`."

Developer: "Is `--topic` available on every Provider?"

Domain expert: "Yes. `--topic <general|news|finance>` is accepted by every
Provider, but its implementation differs: Tavily passes the topic natively to
its API; Z.AI and MiniMax lack a native topic parameter, so the Adapter
appends a small keyword to the query string inside `invoke()` (see
`lib/search-topic.ts`)."

Developer: "Can I search for videos with the Brave Provider?"

Domain expert: "Yes. Brave is the only Provider that advertises `--type video`,
which routes to a dedicated videos endpoint. `--type` is mutually exclusive
with `--topic`. Brave also maps `--content-size high` to its LLM Context
endpoint (extracted passages joined into summaries)."
