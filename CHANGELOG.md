# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Local context refinement (`--context` / `--context-stdin`)

- **`scoutline research "<q>" --context <path> [--context-mode organize|bias|both]`** — load a local notes file (max 256 KiB; NUL-byte detection rejects binary input) to steer deep research. The default `organize` mode re-presents the provider's report following the file's headings (exact-slug section re-mapping; unmatched provider sections are appended, never dropped) purely locally: the wire request and cache identity are byte-identical to a no-context run (golden-pinned). `bias` (and `both`) append a capped `(focus: ...)` term segment to the query before the request is built — derived from the file, so it changes what leaves your machine and fragments the cache key (each mode is a separate paid job). The resume command printed on interrupt carries the context flags (shell-quoted `--context <path>`; `--context-stdin` runs must re-pipe the same content unchanged); the research envelope gains an optional `context` field (source, path, sha256, mode, derived counts — metadata only, never content).
- **`scoutline search "<q>" --context <path>`** — derive up to 8 sub-queries from a local file's headings and questions and join them with the (always-kept, always-first) user query through the merge pipeline (dedupe + occurrence ranking; pipe-only escaping round-trips literal `|` and `\`). `--merge` together with any context flag is a `VALIDATION_ERROR`. JSON data modes wrap the result array as `{ context: { counts, sha256 }, results }`; text modes stay unwrapped; without the flag, output is byte-identical to 0.16.0. Under fan-out every arm runs every sub-query, disclosed once on stderr as `context: N sub-queries × M arms = K billable searches`.
- **`--context-stdin` for both commands** — the same parsing from standard input through the invocation adapter's `readStdin` seam. The source is drained exactly once per invocation, in the handler and before fallback dispatch, so a provider retry can never silently drop the context; oversize input fails with `VALIDATION_ERROR` rather than truncating; a value-carrying `--context-stdin "<q>"` fails validation before the help gate instead of swallowing the query; `--context` and `--context-stdin` are mutually exclusive (`VALIDATION_ERROR`).
- **Privacy boundary (test-enforced)** — parsed file content crosses the wire in exactly two shapes: the research `bias`/`both` focus segment and the search-derived sub-query strings. `organize` sends nothing derived; envelopes, wrappers, and stderr notices carry counts, the source path, and a SHA-256 only — never a heading, question, term, or file byte.
- **Review-hardened parsing** — CRLF-authored notes keep their questions; `--context-stdin` is bounded at the 256 KiB cap before decoding; a heading and a question reducing to the same string emit one sub-query; organize-mode headings with an all-non-Latin (empty) slug never cross-match unrelated provider sections.

## [0.16.0] - 2026-08-16

**Three parallel feature streams, landed as PRs #34/#35/#36:** local cache
maintenance, deterministic repository orientation, and multi-provider search
fan-out (reversing ADR-0002 decision 6 for search per the now-accepted
ADR-0004). Notable review-driven fix: `resolveEnvFromConfig`'s env-wins guard
previously suppressed file-configured credentials for keyless-posture
capabilities (Jina), excluding them from selection and fan-out arms.

### `cache prune` + enriched `cache stats`

- **`scoutline cache prune`:** new `cache` subcommand deleting expired entries from both the response cache and the tool cache by each entry's stored timestamp (`ts` for response entries, `timestamp` for tool entries; never mtime — reads touch mtime for LRU, so it is unreliable for age). Without flags, prune uses the effective TTL as the age threshold; `--older-than <D>` (`24h`, `90m`, `30s`, or a bare integer of seconds) **replaces** the TTL when present. `--provider <id>` and `--capability <id>` selectors AND together and narrow the response-cache scan by parsing v2 filenames only (legacy non-v2 files stay age-selectable but are never selector-selected; unknown selector values are not pre-validated — they filename-match nothing in the response cache, while the selector-free tool scan still prunes expired tool entries). `--provider` works before or after the command token. A valueless `--older-than`, `--provider` (trailing or immediately followed by another option token), or `--capability` fails with `VALIDATION_ERROR` (exit 1), as does an invalid `--older-than`; a validation failure performs no deletion. Response pruning serializes on the response dir's `cache-write` lock (the same identity writes hold), so a prune can never race a concurrent eviction sweep or atomic rename; a lock timeout surfaces as a sanitized `FILE_ERROR` envelope instead of being swallowed, and `.lock`/`.tmp` staging files are never touched. The lock-free tool scan revalidates each file's identity (inode/size — never mtime, which LRU reads touch) before unlinking, so a concurrent tool-cache write that replaces an expired file mid-scan usually survives; this revalidation is best-effort, since the tool cache has no lock convention and a rename landing in the residual stat→unlink window can still be deleted. An explicit `--older-than` run does not short-circuit under a disabled cache (`SCOUTLINE_CACHE=0`) — deletion is not a cache read/write.
- **Enriched `cache stats` (additive):** `responseCache` and `toolCache` gain `live`/`expired` counts from the same `ts`-vs-threshold comparison prune uses, and `responseCache` adds `byProvider`/`byCapability` breakdowns where every bucket repeats `{entries, totalBytes, live, expired}`; non-v2 legacy filenames group under a `legacy` bucket. Existing fields and Doctor's one-line cache summary are unchanged.

### Repository briefing (`repo brief`)

- **New `scoutline repo brief <owner/repo>` subcommand:** composes the existing repository operations — one tree, two searches (`README` and the manifest names), and up to four file reads — into a single schema-version-1 `RepositoryBrief` envelope (`schemaVersion`, `repository`, `focus`, always-present `coverage` and `detected`, plus focus-gated `tree`/`docs`/`entryPoints`/`files` sections). Deterministic by construction: file selection is tree-derived (the shallowest README first, then one manifest per kind in the canonical `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` order; hard cap of 4 reads total — the cap counts the README, so when a README is present only the first three manifest kinds are read), probe queries are constants, and the envelope carries no timestamp or randomness — identical provider responses with a warm cache produce byte-identical output.
- **`--focus` and flag forwarding:** `--focus` accepts only the sealed set `structure, readme, manifest, files` (default all four, order preserved; repeatable — repeated flags combine in first-seen order). Focus gates the optional probes and their envelope sections together: an excluded README/manifest search or read stage does not run and is recorded `skipped`/`focus-excluded` in `coverage.probes`; the tree probe is the exception and always runs, because read-path selection and `detected` both derive from it. `--path`/`--depth` scope the tree probe only; `--no-cache` forwards to every probe; `--max-chars` is forwarded verbatim as a per-call budget to each search and read (the tree is never character-limited). `--depth`/`--max-chars` are strict positive integers validated at parse time, before Provider resolution — fractional or trailing-junk values (e.g. `1.5`, `500x`) fail with `VALIDATION_ERROR` instead of being silently `parseInt`-truncated.
- **Probe degradation is data, not stderr noise:** every probe runs in a settled wrapper — a throw becomes a `failed` record in `coverage.probes` (stable code + redacted message) and the brief continues (a failed tree marks its dependent reads `skipped`/`dependency-failed` and nulls the `detected` fields). Exit stays 0 while any probe succeeded — the tree probe always runs regardless of `--focus`, so its success counts too; exit 1 only when every probe failed. With no configured supplier for `repository-exploration`, the brief fails closed with the inherited typed error before any probe runs. The brief itself is never cached as a unit — its probes reuse the existing per-operation repository cache entries.

### Multi-provider search fan-out (ADR-0004 accepted)

- **One query, many providers, one merged answer.** `scoutline search` can now fan out across several providers in parallel (search only; reader/crawl/map/research/vision stay single-provider). Activation tiers, highest precedence first: `--provider tavily,exa` (comma list) or `--provider all` (every configured search provider, registry order); an explicit single `--provider id` or `SCOUTLINE_PROVIDER` pin (fan-out ignored — stderr says so when the switch is on); `config set fanout true` (arms = `routing.search` when set, else all configured search providers; default **off**); otherwise today's single-provider selection. The single-pin path is byte-identical to the previous behavior (golden-tested).
- **Deterministic cross-provider merge.** Arms run in parallel, one client each, pinned (no per-arm fallback); results are deduped by canonical URL identity (scheme/host lowercased, default `:80`/`:443` ports, fragments, trailing slashes, `utm_*`/`fbclid` removed — dedupe identity only; emitted URLs stay the first arm's originals), ranked by cross-arm occurrence count with arm-order tiebreak, sliced to `--count` post-merge, and carry an additive `mergedFrom` provenance list. `--merge` composes: the grid is arms × sub-queries.
- **Degradation and cost policy (ADR-0004 §7-8).** An arm that rejects a search control drops with a stderr notice naming the control; ≥1 successful arm → merged output, exit 0 (`fanned out to N providers (a, b) → M unique of K results` summary on stderr); all arms failed → the last arm's typed error through the standard boundary. N arms = N billable calls — the cost sentence ships verbatim in `config set fanout true` and `scoutline search --help`. Cache keys stay provider-partitioned (fan-out adds no new key); `--no-cache` forwards to every arm.
- **Review fixes (PR #36).** A typo'd non-empty `--provider` value now fails with `VALIDATION_ERROR` even when `fanout=true` (it used to silently convert into a fan-out activation). `--merge` genuinely composes with fan-out: every arm runs every sub-query and occurrence ranking spans the arms × sub-queries grid (previously each arm received the whole `a|b` string as one query). Fan-out arms record consumption events through the configured sink, so local quota accounting no longer goes stale. The canonical dedupe identity is stricter: percent-encoded tracking names (`?%66bclid=x`) collapse with decoded ones, while raw paths (dot segments) and userinfo are preserved verbatim — D4 authorizes no other normalization; the raw re-slice also follows the WHATWG parser's authority boundary, so parser-equivalent spellings with extra/mixed slash separators (`https:///h/p`, `https:/\h/p`, `https:h/p`) collapse to one identity without duplicating host text or inventing userinfo. `config set fanout true` names only the ELIGIBLE routed providers when `routing.search` narrows the arms (configured ∩ search-capable — the same arm set the resolver computes; zero eligible arms → a zero-arms notice, never a false billable claim), and `config --help` documents `config unset fanout`.
- ADR-0004 flipped to accepted with a ships-in note; README, `docs/architecture.md` (search section), `skills/scoutline/`, and the roadmap updated.

## [0.15.0] - 2026-08-16

### Per-capability provider routing + `config` command family

- **Routing table (`config.json` `routing` key):** an optional per-capability ordered provider preference list. When no explicit `--provider` / `SCOUTLINE_PROVIDER` pin exists, the first configured-and-capable provider in the routed list is selected for that capability — routing is an instruction, not a hint: it wins over quota ranking. Routing never reduces availability (no eligible routed provider → the existing quota-ranked path unchanged), and explicit pins always bypass it. Load-time validation is lenient: unknown provider ids (`UNKNOWN_PROVIDER`) and unknown capability keys (new `UNKNOWN_CAPABILITY`) warn and drop, never failing config load. Known trade-off: an older binary that rewrites the config drops the key (accepted over a `version` bump, which would hard-fail older binaries).
- **`scoutline config get/set/unset`:** a scriptable, non-TTY settings surface over a typed key registry (`fallbackEnabled`, `routing` / `routing.<capability>`, read-only `providers.<id>`). `get` output is always redacted (credential values masked by value match and by field name); `set` is strict — a typo'd provider or capability fails with the accepted list instead of storing something different — and credential-bearing paths refuse outright with a pointer to `init` / env vars (API keys never ride command arguments). Writes are atomic read-modify-write with a round-trip re-parse guarantee.
- **Config family hardening:** `config` commands run before the credential-bearing config load, so a corrupt `config.json` never blocks inspecting or changing settings. Typos fail fast everywhere they can be typed: unknown capabilities and unknown provider ids are rejected with the accepted list, provider field paths (`providers.<id>.<field>`) are refused by `get` rather than dumping the whole provider object, and trailing unexpected arguments are rejected instead of silently ignored. Concurrent `config set`/`config unset` invocations serialize through an advisory lock (same pattern as cache writes), so overlapping changes can no longer silently overwrite each other. `set`/`unset` surface write-time config warnings. The `init` routing editor accepts mixed-case capability keys. Skill docs pin `npx scoutline@<version>` examples; README/roadmap provider-quota, search-controls, and shipped-feature references re-synced.
- **`scoutline init`** re-config menu gains an "Edit routing table" action (interactive wizard for humans; `config` for scripts/agents — both funnel through the same validation). **`scoutline doctor`** embeds the effective routing table additively (`routing` field; schemaVersion stays 2) and its help documents the full selection precedence.

### Documentation: provider-neutral canonization + v2 plan seeds

- **Doc-drift fix (provider-agnostic behavior canonized):** `docs/architecture.md` no longer speaks the two-provider dialect — the Search section now documents the full per-provider control matrix (incl. Parallel's `advanced_settings` controls and Jina's `X-Site`/`gl`, shipped in 0.14.6 but undocumented); Reader/Crawl/Map/Research sections list the real supplier sets (reader: six providers; research: five); the diagnostics-inventory paragraphs derive from the current nine-provider matrix. `skills/scoutline/references/advanced.md`, `skills/scoutline/SKILL.md` (quota now includes Jina; command one-liners fixed; `repository-exploration` typo), `docs/configuration.md` (stale "storage substrate only" paragraph removed; quota-aware selection marked shipped; always-unknown tier table completed with jina/parallel/perplexity), and `README.md` (Search Controls completed for Parallel/Jina/Firecrawl/Perplexity) are aligned to the same facts.
- **PB-T2 honesty note:** `architecture.md` now documents that the consumption seam is wired end-to-end for vision only — the other shared handlers do not yet thread the sink (matching the wiring notes in `src/index.ts`); completing the wiring and adding a retained ledger are open follow-ups.

### Vision default model upgraded to GLM-5V-Turbo

- **Default vision model changed from `glm-4.6v` to `glm-5v-turbo`** (the correct API identifier for Z.AI's GLM-5V-Turbo vision model — there is no `glm-5.0v`). Verified live against the Coding Plan endpoint (`api.z.ai/api/coding/paas/v4`): a vision analysis request with `glm-5v-turbo` succeeds. Override remains available via `Z_AI_VISION_MODEL`. README, `docs/configuration.md`, and `skills/scoutline/` updated to match.

## [0.14.11] - 2026-08-09

### Post-arc tech-debt cleanup (cache lock + Z.AI boundary cast)

- **Inter-process cache lock (finding 5.5):** concurrent `scoutline` invocations writing the same response-cache key now serialize through an advisory lock. `writeCache` + `evictIfNeeded` are wrapped in the existing `lib/async-file-lock.ts` (reused — no new dependency) under a single fixed identity (`cache-write`); reads stay lock-free. The best-effort, never-throws contract is preserved (lock-acquire failures are swallowed alongside write failures). Eviction now skips `*.lock` files so it cannot delete an active lockfile. Previously, concurrent writes were last-write-wins via the atomic temp+rename — tolerable but undefined; the behavior is now defined.
- **Z.AI SDK-boundary double cast removed (finding 4.10):** the `as unknown as McpClientOptions` cast at `defaultZaiClientFactory` is eliminated. The root cause was a mismatch between two internal same-named `ZaiMcpClientOptions` types (lib vs providers); the lib now declares a local structural `McpUtcpClient` port (`getTools(): Promise<Tool[]>`), and the adapter forwards only the fields it uses (omitting `utcpFactory`, which it never injects). Net casts vs main: −1; no replacement cast introduced. Type-only change — runtime behavior unchanged.
- **Tests:** 4 new concurrent-cache tests (parallel writers, external-lock blocking observation, size-cap eviction preserving the lockfile via an aged sentinel). Suite: 2751 → 2755.

## [0.14.10] - 2026-08-09

### Cleanup: jina header harvesting + shared create-lock (Angle 8 follow-ups)

- **Jina quota reporting (8J.5 telemetry):** the transport now harvests `X-RateLimit-Remaining-Requests` and `X-RateLimit-Remaining-Tokens` response headers (verified against Jina's OpenAPI schema — not the `x-ratelimit-limit`/`x-usage-tokens` the original finding claimed). A new `jina/quota.ts` capability infers the account tier from the remaining values, so `scoutline quota --provider jina` reports real remaining quota.
- **Shared async-file-lock (consolidation):** extracted `lib/async-file-lock.ts` from the near-identical `withCrawlLock` (firecrawl) and `withResearchLock` (parallel). Firecrawl + parallel migrated to delegate (no behavior change). Tavily research now uses the shared lock, closing the concurrent-double-create gap. All cleanup paths (404 + terminal) use identity-guarded state removal (remove only when `requestId` matches), preventing a lagging poll from deleting a replacement task's state. Lock timing constants centralized.

## [0.14.9] - 2026-08-09

### Jina research: deepsearch streaming (Angle 8, 8J.6)

- DeepSearch now sends `stream: true` and parses the SSE response (was hardcoded `stream: false`, risking gateway HTTP 524 on long research runs per Jina's explicit warning). The SSE parser accumulates content + citations from the stream, fails closed on premature EOF / malformed JSON, whitelists delta types, de-duplicates annotations/visitedURLs, and produces the same normalized result as the non-stream path — so the adapter is unchanged.
- HTTP 524 (Cloudflare origin timeout) is now classified as `TimeoutError` (was generic `ApiError`), with DeepSearch-specific help text.
- The streaming SSE contract was verified against Jina's docs and a live API call (a 6992-line fixture was captured and the parser validated against it).

## [0.14.8] - 2026-08-09

### Exa research: drop vestigial beta header (EXA-8-01 reclassified)

- **EXA-8-01's premise was inverted.** The finding assumed `/agent/runs` was a deprecated beta to migrate away from and `/research/v1` was the stable target. **Live API verification proved the opposite**: `/research/v1` returns **410 Gone (`RESEARCH_RETIRED`)** and `/agent/runs` is the **current, working** endpoint (confirmed in the OpenAPI spec). The prescribed migration was therefore **not performed** — it would have broken production research.
- The actual defect was a vestigial pinned `Exa-Beta` request header (accepted but unnecessary); removed from create + poll. The now-dead `extraHeaders` transport parameter is also removed.
- Added live-captured `/agent/runs` fixtures (create + completed-poll) and a fixture wire-shape test, grounding the existing research lifecycle against the real response shape.

## [0.14.7] - 2026-08-09

### Parallel research: real Task/Deep Research API (Angle 8, 8P.1 HIGH)

- `scoutline research --provider parallel` now invokes Parallel's real asynchronous Task/Deep Research API (`POST /v1/tasks/runs` → long-poll result) instead of relabeling a search call as research. The create→poll→retrieve lifecycle maps `output.content` → report and `output.basis[].citations[]` → sources, with `run_id` state-file resume (mirrors Tavily's research lifecycle). Processor map: mini→pro-fast, pro→ultra, auto→pro; input limit raised to the documented 15,000 chars.
- A `withResearchLock` (mirroring firecrawl's `withCrawlLock`) prevents concurrent identical research invokes from double-creating/double-billing — the second caller finds the persisted `run_id` and polls it.
- Removes the false-equivalence tests that previously encoded the search-alias as "research".
- Known follow-up: Tavily research has the same concurrent-double-create gap (no lock) — same `withCrawlLock` precedent would apply.

## [0.14.6] - 2026-08-09

### Rejected-but-supported controls + capability gating (Angle 8)

- **Jina capability-aware keyless gating (8J.1, HIGH):** `isConfigured` now takes an optional `capabilityId`. Reader (`r.jina.ai`) remains keyless; Search/Research/Diagnostics (and the Search-based diagnostics probe) require `JINA_API_KEY`, so fallback no longer selects Jina for an operation guaranteed to fail with 401. Backward-compatible — callers that omit `capabilityId` behave as before. The diagnostics probe now fails-closed with `ConfigurationError` when no key is present.
- **Control acceptance (rejected-but-supported pattern):** Parallel now accepts `domain`/`recency`/`location`/`contentSize` via `advanced_settings` and enforces the documented 200-char per-query limit (bounded code-point count); Jina accepts search `domain` (`X-Site`)/`location` (`gl`) and research `domain` (DeepSearch `only_hostnames`); Exa accepts `location` via `userLocation`. A shared domain-validation helper deduplicates the logic.
- Each newly-accepted control carries a wire-parameter regression test; the capability gating carries no-key tests per advertised capability.

## [0.14.5] - 2026-08-09

### Reader-completeness (Angle 8, Track 4)

- Parallel reader now requests `advanced_settings.full_content`, so the full page (not bounded excerpts) is fetched and mapped to content.
- Jina reader now forwards all normalized options (format, image retention, GFM/alt-tag, link/image summaries, timeout) to Jina's documented headers; decodes `data.text` for text-mode responses (previously normalized as empty); echoes the requested `contentFormat`. The timeout now correctly converts the CLI's seconds to Jina's `X-Timeout` (a units bug that would have sent `X-Timeout: 0` was caught in review and fixed). Stale "API bug" comment removed.
- Tavily reader now forwards `format` to the extract API wire body (previously set only the output label); `format` is typed as `"markdown" | "text"`.
- Tavily map client timeout now mirrors the crawl pattern (`max(default, 150s+5s)`), so map operations no longer abort before the 150s server ceiling.
- Each fix carries a wire-level regression test (jina markdown + text-mode fixtures; tavily request-body assertion; parallel `full_content` assertion).

## [0.14.4] - 2026-08-09

### Error-classification hardening (Angle 8, Track 1)

- Parallel: HTTP 402 → terminal `QuotaError`, 422 → `ValidationError` (were generic `ApiError`); direct-API auth switched to the documented `x-api-key` header (was `Authorization: Bearer`).
- Jina: 429 → terminal `QuotaError` (was retryable); 403 body-parsed to distinguish insufficient-balance (`QuotaError`) from credential failure (`AuthError`); the balance-keyword match narrowed so "insufficient permissions" no longer misclassifies as a quota error.
- Brave: 429 → terminal `QuotaError` (was retryable `ApiError(429)`), so the shared retry classifier no longer hammers an exhausted quota.
- Tavily: endpoint-aware 403 — crawl/map "URL is not supported" → `ApiError(403)` (was misleadingly `AuthError`); the endpoint label is now a string-literal union so a typo can't reroute a URL rejection into an auth failure.
- Each fix carries a status-probe regression test asserting the typed error class.

## [0.14.3] - 2026-08-09

### Firecrawl domain-correctness fixes (Angle 8)

- `--depth` now controls crawl depth end-to-end: serialized as the v2 `maxDiscoveryDepth` field (the v1 `maxDepth` was silently ignored by Firecrawl's server), with the correct 0-based mapping (`--depth N` → `maxDiscoveryDepth N-1`; `--depth 1` crawls only the root, matching the CLI contract). Previously every `--depth` invocation was a no-op in production.
- HTTP 402 (insufficient credits) is now mapped to terminal `QuotaError` instead of generic `ApiError`, surfacing the actionable billing signal instead of a retryable-looking failure.
- A server-`cancelled` crawl is now handled as a documented terminal status (`ApiError` 499) instead of a 500 "malformed response".
- Business-error `{success:false}` envelopes now propagate the server code with HTTP 400 (not a hardcoded 422).
- Active-crawls reclaim-on-miss now reads the v2 `createdAt` field (not v1 `created_at`), so the staleness guard actually fires — fixing a silent credit double-charge on Ctrl-C-and-re-run.
- HTTP 503 is now mapped to retryable `NetworkError`.
- The `--depth` cap (1-5) rationale is now documented in the crawl command help.

## [0.14.2] - 2026-08-08

### Test-quality improvements

- Redaction false-positive tests now cover prose-length strings matching the `fc-[a-zA-Z0-9]{20,}` regex, documenting the known trade-off (extremely unlikely in practice) and confirming tokens with spaces are not redacted.
- MCP client retry-count test now verifies actual retry behavior: a fake UTCP client with `ZAI_MCP_RETRY_COUNT=0` produces 1 attempt, `=2` produces 3 attempts — replacing the indirect "env is stored" assertion with a behavioral test.

## [0.14.1] - 2026-08-08

### Post-release audit fixes

- AbortSignal cancellation is now classified as terminal (not retryable) in the shared execution path. Previously, a user-initiated cancel could trigger a retry. The signal is now checked both after `invoke()` rejects and after the backoff sleep, so cancellation during backoff also terminates promptly.
- Diagnostics capability mapping now throws on descriptor/index mismatch instead of silently omitting a provider id, making registry inconsistencies immediately visible.

## 0.14.0 — 2026-08-08

**Actionable errors (minor):**

- The JSON error envelope now includes a `help` field for `UNSUPPORTED_CAPABILITY` and other typed errors, suggesting the next action (e.g., "Use --provider <id> to select a Provider that supports this Capability, or remove --no-fallback to enable cross-Provider rerouting.").
- All typed error classes are now contract-tested through `formatErrorOutput` (parameterized). A regression that drops a field for a specific error type will fail CI.
- The JSON error envelope shape is now documented in the README under "JSON Error Envelope," including the stable error codes (`AUTH_ERROR`, `API_ERROR`, `CONFIGURATION_ERROR`, `QUOTA_ERROR`, `UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_OPTION`, `VALIDATION_ERROR`, `TIMEOUT_ERROR`, `NETWORK_ERROR`, `FILE_ERROR`, `UNKNOWN_ERROR`) and the stream contract (error envelopes go to stderr; data-only stdout is preserved).
- Hot-fix: addresses 4 review findings from the original PR — error-envelope stream corrected to stderr in docs, `UNKNOWN_ERROR` added to the documented codes, `QuotaError` added to the parameterized envelope-contract test, comment direction corrected.

**Backwards compatibility:** the `help` field is additive. Scripts that read the JSON envelope and ignore unknown fields are unaffected. The `code` field remains stable.

## [0.13.14] - 2026-08-08

### Security policy

- `SECURITY.md` now documents the supported version policy, the scope of "vulnerability," and a one-paragraph summary of the redaction guarantees.
- A new ADR records the plaintext-at-rest credential storage as an accepted CLI tradeoff (consistent with AWS CLI, gcloud, kubectl) until OS-keyring integration is adopted.

## [0.13.13] - 2026-08-08

### Redaction and environment

- Firecrawl API keys (`fc-…`) now have a length-constrained regex backstop; previously, only literal-value replacement covered bare Firecrawl keys.
- The redaction regex recognizes non-Bearer auth schemes (`Basic`, `Digest`, custom headers).
- `ZaiMcpClient`'s retry/timeout constants are now resolved from the invocation-local environment, not frozen at module import time.

## [0.13.12] - 2026-08-08

### Type-system cleanups

- `package.json` is now loaded via native import attributes where possible, instead of `createRequire`.
- Global fetch narrowing is centralized in a typed wrapper.
- Cache decoding now accepts a decoder function or returns `unknown`.
- Tool JSON is now `structuredClone`-cloned (preserves future non-JSON fields).

## [0.13.11] - 2026-08-07

### Type-system hardening

- `ScoutlineError.code` is now typed as a tagged union of valid codes; runtime values outside the union are rejected at construction.
- `parseToolArgs` now rejects non-object JSON values (primitives, `null`, arrays) before they reach `callTool`.
- `callToolRaw`'s return type is now correctly modelled as `T | string`; callers receive the union they actually get.
- The provider-fallback executor's capability dispatch is exhaustively typed against `ProviderCapability`; adding a new Capability without updating the executor is now a compile-time error.
- The `init` wizard's Back choice is correctly typed as `ProviderId | undefined`.

## [0.13.10] - 2026-08-07

### Type-system hardening

- `tsconfig.json` now enables `noFallthroughCasesInSwitch` and
  `noUncheckedIndexedAccess`. No public-API change. Some
  previously implicit `T | undefined` returns are now explicit;
  callers that relied on the implicit type are caught at
  compile time.

## [0.13.9] - 2026-08-07

### UX polish

- Stderr newline ownership moved to the invocation adapter (single authority); some messages no longer produce unexpected blank lines.
- `runQuietly` now suppresses dependency `console.error` noise that previously interleaved with structured stderr output.

## [0.13.8] - 2026-08-07

### Cleanup

- Legacy `formatErrorOutput` (1-arg) removed from `lib/errors.ts`; the 2-arg version in `lib/output.ts` is the sole path.
- Superseded `src/lib/silence.ts` removed.
- Unused `resolveTtyMode` removed from `src/lib/tty.ts`.

## [0.13.7] - 2026-08-07

### Test improvements

- `SCOUTLINE_NO_FALLBACK=1` env-var path is now contract-tested through `main()`, mirroring the `--no-fallback` CLI flag.
- Perplexity and Jina diagnostic probes are now offline-tested with a fake transport.
- Firecrawl crawl test now uses an injected `sleep` instead of a real 50 ms `setTimeout`.
- Z.AI reader hang watchdog reduced from 5 s to 1 s.
- `tests/helpers/fake-adapter.js` documents the fresh-state contract.

## [0.13.6] - 2026-08-07

### Programmatic cancellation

- `executeSearch`, `executeRepositoryOperation`, and `executeReaderOperation` now accept an optional `AbortSignal` and forward it to the underlying Provider `invoke()`. CLI behaviour is unchanged (SIGINT still kills the process); the change is additive for programmatic consumers (MCP server, library use).

## [0.13.5] - 2026-08-07

### Hardening

- Cache and tool-cache files now use explicit `0600` mode (directories `0700`); the previous default `0644` relied on the parent directory mode for protection, which did not hold if `SCOUTLINE_CACHE_DIR` redirected the cache outside `~/.scoutline/`.
- `writeCache` and `writeToolCache` now use atomic write (temp-file + rename) so a crash mid-write cannot leave a partially-written cache file. The read path was already self-healing.
- `ZaiMcpClient.close()` and `ZaiCodeModeClient.close()` no longer leak a referenced `setTimeout` timer for up to 2 seconds after each command, eliminating a small post-command event-loop hang.

## [0.13.4] - 2026-08-07

### Documentation

- `CONTEXT.md`, `README.md`, `skills/scoutline/SKILL.md`, and the
  `--help` output now correctly document that `--topic` is accepted
  by every Provider (Perplexity and Jina support added in 0.13.3).
- README, SKILL.md, and `docs/architecture.md` updated to reflect
  all 9 Providers (Parallel AI, Perplexity, and Jina AI were added
  in 0.13.0 but the docs were incomplete).
- `docs/configuration.md`, `docs/troubleshooting.md`, and
  `skills/scoutline/references/advanced.md` synced to the
  9-Provider registry.
- Stale MiniMax SDK section in `docs/architecture.md` and
  `skills/scoutline/references/advanced.md` replaced with the
  current direct-transport description.

## [0.13.3] - 2026-08-07

### --topic every-Provider contract

- Perplexity and Jina now accept `--topic <general|news|finance>`
  via the shared `applySearchTopic` helper (previously raised
  `UnsupportedOptionError`). The user-facing documentation update
  is folded into 0.13.4.

## [0.13.2] - 2026-08-07

### New-adapter conformance

- Parallel, Perplexity, and Jina now sanitize upstream error
  messages, validate requests before Provider access, derive
  normalized `source` from result metadata, and honour cooperative
  cancellation.
- Search conformance test now covers all 9 Providers; a new CI
  guard fails the build if a Provider is added to the registry
  without a corresponding search-conformance factory.

## [0.13.1] - 2026-08-07

### Security

- **File-only configured API keys** (in `config.json` but not in
  `process.env`) are now correctly redacted from the on-disk tool
  cache and from `scoutline tools list/show`. If you previously
  configured keys this way, run `scoutline cache clear --type tool`
  to remove any pre-fix un-redacted entries. The tool cache version
  was bumped from 1 to 2 to invalidate all pre-fix entries.
- **`ZaiApiClient` now fails closed on `Authorization`-bearing HTTP
  redirects** (previously Node undici forwarded the `Authorization`
  header across cross-origin redirects). No known exploitation.

## [0.13.0] - 2026-08-07

### Added
- **Integrated Parallel AI (`parallel`), Perplexity Sonar API (`perplexity`), and Jina AI (`jina`) providers.**
  - **Parallel AI**: Adds `search` (semantic search with dense excerpts), `research` (deep research via `objective=deep-research`), `reader` (Extract API — full page content including PDFs and JS-rendered pages), and `diagnostics` capabilities via `PARALLEL_API_KEY`.
  - **Perplexity Sonar**: Adds `search` (dedicated Search API with ranked results, snippets, and dates), `research` (deep research report synthesis via `sonar-deep-research` model with structured `search_results[]` sources), and `diagnostics` capabilities via `PERPLEXITY_API_KEY`.
  - **Jina AI**: Adds `search` (`s.jina.ai` neural web search), `reader` (`r.jina.ai` web-to-markdown extraction), `research` (`deepsearch.jina.ai` multi-step agentic research with reasoning and citations), and `diagnostics` capabilities via `JINA_API_KEY` (keyless supported).

### Fixed
- **Provider help strings in `crawl`, `map`, `read`, and `research` commands** now include `brave`, which was previously omitted.

## [0.12.1] - 2026-08-06

### Fixed
- **Exa research no longer hard-rejects `--output-length`, `--citation-format`,
  or `--domain`.** The Exa Agent create body has no native fields for those
  provider-neutral options (only `query` + `effort`), so the adapter now
  warn-and-strips them on stderr and continues the run. Previously
  `UNSUPPORTED_OPTION` aborted the Exa attempt and could turn a recoverable
  Tavily→Exa fallback into a total failure ([#4](https://github.com/vikasagarwal101/scoutline/issues/4)).
- **Provider-fallback exhaustion surfaces the last eligible failure when the
  effective provider never ran.** If the preferred provider was skipped as
  incapable/unconfigured and later candidates failed at runtime, the JSON
  error envelope now carries that last actionable error instead of masking
  it behind `UnsupportedCapabilityError` / `ConfigurationError` for the
  skipped effective.

## [0.12.0] - 2026-07-27

### Added
- Added the versioned `~/.scoutline/config.json` storage substrate for the
  upcoming install/onboarding flow: a dedicated `SCOUTLINE_CONFIG_DIR` root,
  strict validation with tolerant repair inspection, unknown-provider
  warnings, blank-key normalization, and private atomic replacement. This is
  additive infrastructure only; existing commands continue to use their
  current environment-variable paths.
- **File-configured API keys now flow to shared commands.** A key stored
  under `providers.<id>.apiKey` in `~/.scoutline/config.json` reaches every
  shared command (`search`, `read`, `crawl`, `map`, `research`, `repo`,
  `vision`, `doctor`, `quota`) through the real provider descriptor/handler
  boundary. Environment variables always take precedence over file keys, and
  the documented alias precedence (`Z_AI_API_KEY` > `ZAI_API_KEY` > file key)
  is preserved. File keys are redacted at every outward boundary exactly like
  environment-variable keys. `process.env` is never mutated. Users without a
  config file see byte-for-byte identical behavior to the previous release.
- **`config.fallbackEnabled` preference is now wired into runtime fallback.**
  Provider fallback is resolved as: invocation flag (`--no-fallback`) or
  environment opt-out (`SCOUTLINE_NO_FALLBACK`) > `config.fallbackEnabled` >
  default `true`. This makes the wizard's onboarding answer effective at
  runtime instead of write-only.
- **Credential-free commands now short-circuit before config load.**
  `--help`, `--version`, and `cache` (stats/clear) never read
  `config.json`, so a corrupt or unreadable file cannot block them.
- **File-configured API keys now flow to the raw Z.AI commands and the
  cache fingerprint.** A key stored under `providers.zai.apiKey` in
  `~/.scoutline/config.json` now reaches `scoutline tools`, `tool`,
  `call`, and `code` through the real `ZaiMcpClient` / `ZaiCodeModeClient`
  boundary, and the on-disk response cache fingerprints against the
  resolved credential rather than ambient `process.env`. Combined with
  the shared-command coverage from the previous entry, a file-only key
  is now sufficient to run **every** command. The normal dispatch path
  no longer reads ambient `process.env` credentials; the load-failure
  adapter (`node-command-invocation-adapter.ts`) and the back-compat
  `lib/monitor-client.ts` quota delegates remain the two documented
  intentional ambient exceptions (the monitor delegates have zero
  in-tree callers; the live Z.AI quota path uses
  `providers/zai/quota.ts`, which passes an explicit key). The
  `ZaiMcpClientOptions` / `ZaiCodeModeClientOptions` / `McpTemplateOptions`
  / `ToolsOptions` / `CallToolOptions` / `CodeRunOptions` option bags
  gain an optional `env` field — additive, source-compatible, and
  ignored by injected test fakes. `buildCacheKey` accepts an optional
  third `env` argument with the same default. The SHA-256 / filename
  cache key algorithm is unchanged; migration of existing cache entries
  across credential sources is deferred (see `docs/roadmap.md`).
- **`scoutline init` interactive onboarding wizard is complete.** The
  wizard writes `~/.scoutline/config.json` (mode 0600) through a
  provider checklist (registry-derived, equal weight, none
  pre-checked), per-provider ask-key-first → hidden input → single
  inline validation probe against an ephemeral in-memory environment,
  honest broad classification of probe failures (`AuthError`/`ApiError`
  reject and re-prompt; `NetworkError` offers save-unverified; no
  false-precise subtypes), credit-cost disclosure before any paid
  probe, env-key import offer, fallback-preference question, and
  atomic write. The candidate credential lives only in the ephemeral
  probe env until the final atomic write — `process.env` is never
  mutated. `@inquirer/prompts` is a new direct runtime dependency;
  the wizard is hermetic (every prompt, config-store, descriptor,
  clock, and TTY access is injected through `MainDependencies.initPrompts`
  / `initConfigStore` seams). Four lifecycle states: absent → fresh
  flow; valid + empty → fresh flow; valid + already-onboarded →
  re-config menu (edit key, add/remove provider, change fallback,
  re-run full, cancel); corrupt → backup + rewrite (init is the
  recovery path). Editing a key invalidates the prior verification
  record. Formal non-TTY refuse: without a terminal the wizard
  refuses before any prompt, prints env instructions, and exits.
  Stale-env-after-import warning notes that env precedence keeps
  winning at runtime.
- **Trigger detection for unconfigured commands (Option B).** When a
  credentialed command runs with environment-variable credentials but
  no `config.json`, scoutline emits a ONE-TIME stderr hint pointing
  at `scoutline init` and persists `config.json.hintShown` so the hint
  never repeats. The command then runs normally with its natural
  output and exit code. A missing credential everywhere continues to
  surface the existing `CONFIGURATION_ERROR` exit 3 through the
  handler's own preflight (the trigger layer does not intercept, so
  the locked validation-before-configuration ordering is preserved).
  Credential-free commands (`--help`, `--version`, `cache`, `init`,
  `<command> --help`) never read the config file — a corrupt
  `config.json` cannot block help rendering. `doctor` and `quota` are
  observational: they report per-Provider state and are exempt from
  trigger detection. Raw Z.AI commands (`tools`, `tool`, `call`,
  `code`) are credentialed and Z.AI-only; the env-only hint applies.
- **Doctor verification promotion.** `scoutline doctor` now flips
  `providers.<id>.verification.status` from `unverified` to `verified`
  after a successful probe. The promotion is awaited and best-effort:
  a write failure is isolated through a stderr notice and never turns
  a successful probe into a Doctor failure. Only `status:"ok"` records
  are promoted; skipped, failed, no-tools, and network-deferred
  records are not. The injected `verificationPromoter` /
  `HintShownStore` seams keep tests hermetic.
- **Tolerant config load in production.** The dispatcher now uses
  `inspectConfig` (absent | valid | corrupt) instead of strict
  `readConfig` for the production path. Corrupt config still refuses
  credentialed commands with `CONFIGURATION_ERROR` exit 3, but
  command-local help (`<cmd> --help`) bypasses the refuse so help
  stays usable. Tests that inject `loadScoutlineConfig` keep the
  strict-throw semantics for backward compatibility.

### Changed
- `loadConfig` and `getApiKey` in `lib/config.ts` now accept an explicit
  `env` parameter (defaulting to `process.env`). The signature is additive;
  existing no-argument callers keep working unchanged.
- **`quota` and `doctor` now surface the PB-T1 quota snapshot that drives selection (PB-T5 — Plan B).** Both commands stay on their existing schema versions (Quota `schemaVersion: 1`, Doctor `schemaVersion: 2`); the new fields are **additive and optional**, so every pre-PB-T5 consumer (TTY renderer, exit-code computation, JSON-envelope scripts, test fixtures) continues to work byte-for-byte. The schema decision is documented in `docs/configuration.md` § "Quota snapshot integration".

  - `scoutline quota` reads each configured provider's snapshot first and labels the row's source: `quotaSource.source = "snapshot"` (within the 10-min freshness threshold, `authoritative: true`) or `"live"` (stale/missing/corrupt → live-probe fallback, `authoritative: true` because just observed). A successful live-probe fallback is **awaited-write-through** so the next dashboard reflects fresh data. The TTY renderer shows a `source` line beneath each provider's categories with a relative age and a `fresh` / `stale · non-authoritative` flag.
  - **Exa no-signal row.** In default (multi-provider) mode, a configured provider without a `quota` capability (today: Exa) now appears as `{ status: "none", reason: "no-capability" }` with **zero adapter/transport calls** — no live-probe fallback is attempted. Pinning Exa explicitly (`--provider exa quota`) still throws `UnsupportedCapabilityError` (the user explicitly asked for one provider's quota — a no-signal row would hide the user error). Pre-PB-T5 the multi-provider dashboard excluded Exa entirely via a capability filter; the no-signal row is the new contract.
  - **Brave rate-limit caveat.** Brave's snapshot stores categories only (PB-T1's contract); provider-authored `warnings` (e.g. Brave's rate-limit caveat) are **not** carried through the snapshot — they surface only when a live probe runs (stale/missing). Extending the snapshot schema to carry warnings is out of scope for PB-T5 (PB-T1 owns the schema).
  - `scoutline doctor` embeds a per-provider `quota` summary (`{ source: "snapshot" | "none", observedAt?, authoritative }`) derived from the snapshot — **never** via a live quota probe (Doctor is observational; the live probe belongs to `quota`). The summary appears even under `--no-tools` (a snapshot read is local state, not transport) and even when the diagnostics probe fails (the snapshot is independent of the probe). Each provider entry also carries a `verification` summary mirroring Plan A's `config.providers[id].verification` record.
  - **Correlating selection with the dashboard.** The `quotaSource.authoritative` flag is the **same flag** PB-T4's selection resolver uses, so a user can correlate a selection pick with the data that drove it without misattributing the pick to fresher data than it is. A non-authoritative row means the selection treated the provider as eligible-but-neutral.
  - Freshness is judged solely from `observedAt` — the snapshot's ground-truth clock. `locallyUpdatedAt` (PB-T2's local decrement) **never** resets the staleness clock; a snapshot with a stale `observedAt` and a fresh `locallyUpdatedAt` is still non-authoritative.
- `buildMcpCallTemplate`, `buildCacheKey`, `ZaiMcpClient`,
  `ZaiCodeModeClient`, and the Z.AI Provider descriptor's default client
  factory now consult a captured credential view (resolved env) instead
  of ambient `process.env`. Each gains an optional `env` parameter /
  option-bag field that defaults to `process.env`, so existing direct
  constructors and injected test fakes keep working unchanged. The
  descriptor's `create(context)` wraps the client factory to merge
  `context.env` into every capability's client construction call.
- **Local consumption decrement (PB-T2).** Shared execution emits one
  typed `ConsumptionEvent` per billable `operation.invoke()` attempt at
  the execution seam (`lib/execution.ts`), bypassing handler-success
  hooks so cache hits do not decrement, retries count one event per
  attempt, and observational handlers (`quota`/`doctor`) emit nothing.
  The event carries provider, canonical capability id, category, unit,
  and an explicit `exact`/`estimate`/`unknown` amount (never a fake
  "1"; Research/Vision/Crawl persist `unknown` for variable cost).
  Production writes through PB-T1's `QuotaStore.writeConsumption`,
  advancing `locallyUpdatedAt` and adjusting the matching category's
  count set; `observedAt` (ground truth) is never moved. The write is
  awaited before the call returns outward and survives the bin's
  immediate `process.exit`. A sink failure is converted to a redacted
  stderr warning and never reaches the retry classifier. The
  `consume?: ConsumptionSink` field is opt-in on
  `ExecutionDependencies` / `HandlerDependencies` /
  `MainDependencies` — without it, no events are emitted and behavior
  is byte-for-byte identical to the previous release. `executeWithFallback`
  and its candidate/error classification remain untouched.
- **Quota normalization — capability mapping + authority-aware scoring
  (PB-T3).** New pure module `lib/quota-mapping.ts` derives a remaining
  score per `(provider, capability)` from PB-T1's raw category
  snapshot, so the upcoming selection algorithm (PB-T4) can rank
  providers without learning any provider's category schema. Two
  review fixes shape the contract:
  - **Map raw categories, not a pre-derived remaining.** A static
    table declares which `QuotaCategory.name` governs which
    `(provider, capability)` pair (Z.AI `requests`/`tokens`; Tavily
    endpoint categories with aggregate `requests` fallback; Firecrawl
    `Credits`; MiniMax model-name aliases with a documented default
    table). The score is the matched category's
    `current.remainingPercent` (already normalized 0..100 by
    `buildQuotaWindow`); no re-derivation, no re-clamp. Aliases are
    matched case-sensitively against the normalizers' emission.
  - **Separate authority from score.** Providers with a real
    credit/token signal form a **known tier**, ranked by score;
    providers without a signal (Brave rate-limit, Exa none) form an
    explicit **unknown tier**, ranked after every known provider.
    Unknown is never encoded as a numeric `50` — the prior "neutral 50
    yet never fullest" contradiction is fixed by keeping authority on
    a separate axis. A known-tier provider at 5% (or even 0%) still
    ranks above an unknown-tier Brave/Exa provider.
  Fail-open is total: a missing snapshot, an empty categories array, a
  renamed/mismatched category, and a corrupt `remainingPercent` each
  return a typed `authority:"unknown"` result with a machine-readable
  reason — never a throw. Every degradation routes through an injected
  `onWarning` callback (the pure module never calls
  `process.stderr.write`). `rankProvidersForCapability` returns the
  deterministic, known-first / unknown-last ordering PB-T4 will walk.
  This is additive derivation only; existing commands are byte-for-byte
  unchanged. PB-T4 wires the scorer into the selection algorithm.
- **Quota-balanced provider selection (PB-T4 — first-pick-only).** When
  no explicit `--provider` / `SCOUTLINE_PROVIDER` pin is supplied and a
  quota snapshot is available, the seven shared handlers (`search`,
  `read`, `crawl`, `map`, `research`, `repo`, `vision`) now resolve the
  effective provider via PB-T3's authority-aware ranking: the
  highest-scored **known-tier** configured provider wins; if none are
  known, the compat default `zai` is returned. An explicit pin still
  bypasses ranking entirely and preserves the existing typed
  `ValidationError` / `UNSUPPORTED_CAPABILITY` errors. When no
  `quotaState` is wired (every existing test and pre-PB-T4 caller),
  selection delegates to `resolveProviderId` byte-for-byte — no
  behavioral change. `executeWithFallback` and its candidate/error
  classification are untouched; only the first-pick resolution changes.
  Doctor and quota remain observational and never participate in
  selection.

### Fixed
- **Test runner isolates `SCOUTLINE_CONFIG_DIR`.** The offline/smoke
  test modes now set `SCOUTLINE_CONFIG_DIR` to a unique per-run temp
  directory so the developer's real `~/.scoutline/config.json` (written
  by `scoutline init`) does not leak into non-hermetic tests that call
  `main()` without injecting `loadScoutlineConfig` /
  `providerDescriptors`. Tests that inject their own config are
  unaffected. Fixes 87 pre-existing failures in repository-command,
  reader-command, and search-type-control suites; the full suite is now
  green.

## [0.11.0] - 2026-07-26

### Changed (contract reversal — please read)
- **Provider fallback is always-on by default.** The long-standing
  "no fallback" contract is reversed: when the selected provider
  does not advertise a capability (for example, MiniMax does not
  advertise `repository-exploration` or `reader`) or fails at
  runtime, Scoutline now emits a stderr notice and silently tries
  the next eligible configured Provider in registry order
  `[zai, minimax, tavily, exa, brave, firecrawl]`. The selected
  provider remains the *first* one tried, so the user-visible
  behavior is identical when the pin works; the change only affects
  what happens when it does not. This reverses the most heavily
  documented invariant in the project, so every public surface that
  promised "no fallback" has been updated; the previous behavior is
  preserved verbatim by the new kill-switch.
- **New kill-switch: `--no-fallback` (or `SCOUTLINE_NO_FALLBACK=1`).**
  Restores the previous strict single-Provider, fail-loud behavior
  for scripting and cost-sensitive workflows. Under the kill-switch
  the candidate plan is reduced to the effective provider only and
  the same preflight (capability metadata → configuration → adapter
  handle agreement) runs on it, so an incapable effective throws
  `UNSUPPORTED_CAPABILITY` (exit 1) and an unconfigured effective
  throws `CONFIGURATION_ERROR` (exit 3) with zero adapter work for
  the unsupported case. The capability-before-configuration
  ordering (FR-023, FR-024) is **preserved** under `--no-fallback`,
  not retired. `--no-fallback` is tested to restore exact 0.10.x
  exit codes for every shared-capability command.

### Added
- New ADR [`docs/adr/0002-provider-fallback.md`](docs/adr/0002-provider-fallback.md)
  records the decision, the kill-switch, the critique's evidence
  that the pre-charge boundary is unprovable, the explicit
  acceptance of the async double-charge risk, and which old
  selection requirements are preserved vs retired.
- A "Why did I get charged twice?" entry in
  [`docs/troubleshooting.md`](docs/troubleshooting.md#why-did-i-get-charged-twice-on-a-single-crawl--map--research)
  documenting the accepted async risk with worst-case charged-request
  bounds: `crawl` ≤ 2, `map` ≤ 2, `research` ≤ 2 under retry+fallback
  with both candidates configured; default (winner only) = 1 each;
  `--no-fallback` = 1/1/1.

### Accepted risk (cost-bearing async ops)
- For `crawl`, `map`, and `research`, a runtime failure on the
  effective provider may fall back to another provider **even if the
  failed provider had already accepted or charged a job**. Providers
  (Firecrawl, Tavily, Exa) do not offer idempotency keys,
  pre-charge acknowledgements, or refunds for accepted-then-failed
  work, so the residual double-charge risk is **accepted** in
  exchange for resilience. `--no-fallback` is the documented opt-out
  for cost-sensitive workflows. The accepted risk is stated in the
  ADR, the `crawl` / `map` / `research` command help, and
  `docs/troubleshooting.md`.

## [0.10.2] - 2026-07-25

### Fixed
- **Vision URL fallback now actually triggers and succeeds.** The 0.10.1
  fallback only fired on HTTP 400/422, but the Z.AI vision MCP surfaces a
  `code 1210` image-format rejection (and URL fetch timeouts) as a
  sanitized `ApiError` 500 with the original detail discarded — so the
  fallback never ran and every retry re-sent the same URL. The trigger
  now fires on any transport/processing failure for an HTTP(S) source
  except auth (401/403) and exhausted quota, catching the 1210-as-500 and
  timeout paths. If the local fetch or retried attempt then fails, a
  terminal 422 error is surfaced (naming both the Provider failure and
  the fallback failure) so the shared retry policy does not multiply
  latency. Verified end-to-end: a URL Z.AI cannot fetch but scoutline can
  (e.g. the Google logo) now succeeds via the temp-file retry.
- **The fallback URL fetch now sends a `User-Agent`.** Many CDNs and
  image hosts reject requests with no User-Agent. (Note: some hosts —
  e.g. Wikimedia hotlink-protected thumbnails — return 400 to every
  caller; for those, the fallback now surfaces a clear "fallback also
  failed" error instead of an opaque 1210.)

## [0.10.1] - 2026-07-25

### Fixed
- **`scoutline repo tree` / `scoutline repo read` returned `API_ERROR` 502
  against the current Z.AI ZRead output.** ZRead now wraps the
  `<structure>` / `<file_content>` block in a preamble (`Directory
  Structure of <repo>:`, `File content for <path> in <repo>.`,
  `Source: <url>`) and a trailing `Tip:` line, and omits the glyph-less
  root label (entries start directly with `├──`). The parsers now locate
  the single wrapper pair anywhere in the response and treat the root
  label as optional, so both the current and the legacy grammar parse.
  Duplicate/nested wrappers, unclosed tags, and glyph-less siblings are
  still rejected.
- **Vision image URLs the Provider cannot fetch now fall back to a local
  fetch.** Z.AI's vision MCP rejects base64 and its server-side URL
  fetcher fails on some image URLs with a fast `code 1210` (HTTP 400) or
  returns empty. On a 400/422 for an HTTP(S) image/video source, the
  Z.AI Adapter now fetches the URL itself (validated against the same
  media limits), writes it to a temp file, retries with that path, and
  cleans up. Timeouts/5xx are untouched (the shared retry policy owns
  them; a fallback there would double latency).

### Changed
- **`scoutline quota` now defaults to multi-Provider.** Plain `scoutline
  quota` reports every configured Provider with a quota Capability, in
  registry order (previously: only the effective Provider). Pin a single
  Provider with `--provider <id>` or `SCOUTLINE_PROVIDER=<id>`;
  `--all-providers` forces the multi-Provider default even under a pin.
  This is the behavior the report flagged — the flag already existed, it
  is now the default.

### Known Limitations
- **`scoutline vision diagnose-error` remains image-only.** A `--text`
  mode is not available: the Z.AI MCP exposes no text-chat tool (the
  operation maps to `vision.diagnose_error_screenshot`, which requires
  an `image_source`), and the raw Z.AI chat-completions API requires a
  separate paid resource package (`code 1113` on the MCP-plan key). The
  workaround is to screenshot the error and pass the image path.

## [0.10.0] - 2026-07-24

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
- `defaultRetryPolicy("map")` is now `maxRetries:0` (grouped with
  `crawl` / `research`) — map is cost-bearing per batch; the documented
  `--no-fallback` cost guarantee of `1/1/1` per command depends on this
  default (0.11.0 review Fix 1). Affects Tavily map too (was 1).
- `lib/research-state.ts` generalized to `lib/async-job-state.ts`
  (reusable async-job resume); the persisted `requestId` field is
  unchanged for wire compatibility.
- Migrated Exa's research test to the renamed `async-job-state` module
  (missed during the FC-01 rename; caught during release verification).

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
