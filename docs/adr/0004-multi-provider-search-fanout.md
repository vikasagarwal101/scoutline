# Multi-Provider Search Fan-Out

Status: accepted (2026-08-15; implemented 2026-08-16)

Ships in: the first release cut after 0.15.0 (see `CHANGELOG.md`
"Unreleased"). Implemented by the search-fanout plan
(`docs/plans/search-fanout/`, tickets 1-5): activation tiers, parallel
pinned arms, canonical-URL merge with `mergedFrom` provenance, arm-drop
notices, and the `fanout` config toggle with the cost sentence.

## Context

ADR-0002 made provider fallback always-on and, in its decision 6,
declared cross-provider result normalization a non-goal: "there is no
cross-provider result normalization" — a query is answered by exactly
one provider, sequentially.

That position made sense when fallback was the only multi-provider
behavior. Since then the capability seam normalized every search result
to `SearchSource[]`, the cache became provider-partitioned (arms never
collide), and parallel per-arm execution with one transport per arm is
an established pattern (`search --merge` already runs parallel
`executeSearch` calls, `search.ts:206-223`). The cost of the reversal
has collapsed; the recall argument has not changed: single-provider
search inherits one provider's ranking bias, and merging across
providers (dedupe + cross-source occurrence ranking) surfaces consensus
sources single providers miss.

Product decision (2026-08-15): the owner wants fan-out as a first-class
search behavior — faster, more varied results from parallel providers at
a known, explicit credit cost — and deprioritizes the observational
`compare` command that shared the same machinery. This ADR records that
reversal **for search only**.

## Decision

1. **Search may fan out.** When fan-out is active, one query executes
   in parallel across an arm set of providers, each arm pinned to its
   provider (per-arm fallback off), and the normalized results are
   merged into one deduplicated, ranked list.
2. **Activation precedence** (highest first):
   `--provider a,b[,…]` / `--provider all` (explicit multi-pin) →
   fan-out always; explicit single `--provider id` or
   `SCOUTLINE_PROVIDER` → single-provider, fan-out ignored; otherwise
   the `fanout` config key (`config set fanout true|false`, default
   **false**); otherwise today's single-provider selection
   (routing table → quota ranking).
3. **Arm set**: the `routing.search` list when set (it orders the arms);
   otherwise every configured provider advertising `search`, in
   registry order.
4. **Cross-provider merge is deterministic**: URL canonicalization
   (fixed rule, below), occurrence ranking (already the
   `mergeResults` discipline), provider-priority tiebreak (arm order)
   for first-writer-wins metadata, additive `mergedFrom` provenance on
   merged results. No model, no scoring beyond occurrence counts.
5. **URL canonicalization rule (identity only; original URLs are
   preserved in output)**: lowercase scheme and host; drop default
   ports (`:80`/`:443`); strip fragment; strip trailing `/` on the
   path; drop `utm_*` and `fbclid` query parameters; remaining query
   order preserved.
6. **Count semantics**: each arm is asked for `--count` results; the
   merged list is sliced to `--count`.
7. **Option divergence**: an arm that rejects a control
   (`UnsupportedOptionError`) drops with a stderr notice naming the
   arm and the rejected control; it never fails the invocation.
8. **Cost is explicit**: N arms = N billable calls. The `config set
   fanout` message and `--help` state this plainly; the default is off
   so no user spends multiple providers' credits silently.
9. **stdout contract unchanged in shape**: data mode still emits the
   results array; fan-out adds fields (`occurrences` already exists;
   `mergedFrom` is new) and stderr notices (arm drops, merge summary),
   never a new envelope wrapper.

## Consequences

- ADR-0002 decision 6 is superseded **for search**; reader, crawl,
  research, and vision remain strictly single-provider + fallback.
- Single-value `--provider` behavior is byte-identical to today
  (no-change guarantee, tested).
- Per-arm errors are settled: ≥1 successful arm → merged output, exit
  0, dropped arms reported on stderr; all arms failed → exit 1 with
  the last error through the standard boundary.
- `--merge` (multi-sub-query) composes with fan-out: the merge grid is
  arms × sub-queries; `occurrences` counts across the grid.
- `mergedFrom` becomes part of the documented search result shape
  (additive; absent when fan-out is inactive).
- Fan-out arms do not participate in the reactive fallback chain in
  this decision's scope (arms are pinned); revisiting that is a future
  ADR amendment if evidence demands it.

## Considered Options

- **Keep compare, skip fan-out** — rejected (product decision
  2026-08-15): measurement without the merged behavior has little
  standalone value for this user; the machinery is shared anyway.
- **Fan-out via the sequential fallback chain** — rejected:
  `executeWithFallback` is sequential first-winner; parallel arms with
  per-arm pinning are simpler and match the one-client-per-query rule.
- **Wrap merged output in a new envelope** — rejected: breaks every
  existing data-mode consumer of `search`; additive fields + stderr
  notices preserve the contract.
- **Default fan-out on** — rejected: silent multi-credit spend on every
  search violates least-surprise; the default stays off and the toggle
  message teaches the cost.
