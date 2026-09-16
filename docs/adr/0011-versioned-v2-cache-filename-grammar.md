# ADR 0011: Versioned v2 Cache-Filename Grammar (Dotted Capabilities, Keyless Credentials)

- Status: Proposed (ships with #140)
- Date: 2026-09-16
- Deciders: owner, session orchestrators
- Supersedes: the flat 6-segment grammar implied by ADR-0002-era cache docs

## Context

The provider-partitioned response-cache filename (`buildProviderCacheKey`,
`src/lib/cache.ts`) was introduced as:

```
v2.<capability>.<provider>.<credential-hash>.<request-hash>.json
```

`parseCacheFileName` — the selector-matching parser behind `cache stats`
byProvider/byCapability buckets and `cache prune --provider/--capability` —
enforced EXACTLY six non-empty dot-separated segments. That grammar held while
every capability id was dash-separated (`repository-search`, `reader-fetch`)
and every credential fingerprint was a full SHA-256 hex.

The science vertical (#140) broke both invariants at once:

1. **Dotted capabilities.** Science cache identities carry
   `"science.search"` / `"science.get"` verbatim (the journal derives the same
   key — `scienceCacheKey` — so renaming was not an option), yielding 7 segments.
2. **Keyless credentials.** The five scholarly suppliers are keyless-by-design;
   their `credentialFingerprint` is the EMPTY STRING (DESIGN D4 note: keyless
   responses are user-independent, one shared partition). An empty segment made
   the exactness check reject every keyless science key.

With the naive 6-segment parser, every science cache entry bucketed under
"legacy" in `cache stats` and became invisible to prune selectors — a defect
the #140 lane itself created (mid-lane ruling T4b), so the lane fixed it.

## Decision

`parseCacheFileName` uses **right-split parsing with format validation**,
replacing segment-count exactness:

- Guard: name starts `v2.` and ends `.json` (unchanged).
- Split the remainder on `.`; require ≥ 4 parts.
- From the RIGHT: `[n-1]` = request-hash (must be 64-char lowercase hex),
  `[n-2]` = credential-hash (**may be empty** — the keyless partition),
  `[n-3]` = provider (must be non-empty), and everything left of that,
  re-joined on `.`, = capability (may contain dots).
- Anything else returns `null` → legacy bucket, age-only prune (unchanged).

Two tightenings shipped with the widening (external-review round, F3):

- credential-hash must be either empty or 64-char lowercase hex;
- no empty field inside the joined capability (`science..search` → null).

Junk-shape rejection (non-hex/uppercase/short hashes, `__proto__` payloads,
missing `.json`) is pinned; `__proto__` hardening (null-prototype accumulators)
is unchanged.

## Consequences

- **Back-compat**: every key that parsed under the old grammar parses
  identically (pinned per shape).
- **Migration edge**: hand-authored or foreign cache filenames with non-hex
  request/credential hashes now bucket as `legacy` and stop matching
  provider/capability selectors. House-generated keys are always SHA-256, so
  this only affects externally planted files. Age-based prune still applies.
  Disclosed in the CHANGELOG.
- **Grammar is now load-bearing for tooling**: any future capability id MAY
  contain dots; any future keyless provider reuses the empty-credential
  segment. New producers must keep provider/hashes dot-free, which SHA-256
  hex guarantees.
- **ADR-0002-era doc text** spelling the flat grammar should reference this
  ADR's right-split form.

## Alternatives considered

- **Rename science capabilities to dash-form** — rejected: the journal cacheKey
  derives the identical string (ADR-0008 warm-repeat markers match on it);
  renaming would fork the two derivations.
- **Hash the capability segment** — rejected: `cache stats`/`prune` selector
  matching is a pure filename-string operation by design (zero content reads);
  hashing would force content reads for bucketing.
- **Docs-only fix** (leave science entries "legacy") — rejected: the lane
  created the misbucket; shipping it would make prune selectors silently
  wrong for an entire capability family.
