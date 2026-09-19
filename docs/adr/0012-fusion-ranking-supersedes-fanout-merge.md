# Fusion Ranking — supersedes the ADR-0004 merge clause

Status: accepted (2026-09-19; implemented by the fan-out fusion lane —
`feat/fanout-fusion`, tickets T1-T6)

## Context

ADR-0004 (2026-08-15) shipped multi-provider search fan-out with a
deliberately minimal merge: canonical-URL dedupe, occurrence
counting, best-position tiebreak — and decision 4 capped it: "No
model, no scoring beyond occurrence counts."

Two defects have since become user-visible inside that cap:

1. **Position-blind ranking.** Occurrence counting treats "found at
   rank 9 by three providers" as equal-or-better than "found at rank
   1 by one" in exactly the cases where it should not. The ADR's own
   rationale — "surfaces consensus sources" — is the claim rank-aware
   fusion formalizes; the cap prevents the formalization.
2. **Near-duplicate pollution.** Canonicalization deliberately does
   not collapse `www.`/apex hosts (a recorded gate in
   `src/lib/url.ts:37-40`), and cross-domain syndication is invisible
   to URL identity entirely — so one story routinely occupies
   multiple top slots of a merged list.

Product ruling (owner, 2026-09-18 grill of seed 24, Q1–Q7): RRF
should be the DEFAULT ordering, not an option — "rrf should be better
than simple occurrence mapping if built correctly and exhaustively" —
selected by config key only, disclosed at init. That default-on
behavior change is the reason this is a superseding ADR rather than an
amendment: ADR-0004's decision 4 and its default-off posture are
replaced, not annotated.

## Decision

1. **Deterministic, model-free rank-fusion scoring is sanctioned for
   the search merge family.** RRF (`score = Σ 1/(k + rank)`, k = 60
   fixed) is the default ordering of every merged list. Model-based
   re-ranking and provider-score normalization remain excluded
   (provider scores stay dropped at adapter normalization).
2. **Carried forward from ADR-0004 verbatim**: activation tiers
   (decision 2), arm-set rule (3), URL-canonicalization-as-identity
   discipline (5, widened below), count semantics (6), option-drop
   policy (7), cost disclosure (8), stdout additive-fields-only
   contract (9).
3. **Surface**: the `fusion` config key (`rrf|occurrence`, strict)
   + `SCOUTLINE_FUSION` env. **No query flag.** Default `rrf`. The
   init wizard asks with a plain-language disclosure (default rrf).
   `occurrence` is the supported legacy mode, byte-identical to
   pre-ADR behavior.
4. **One seam**: the mode governs `mergeResults` everywhere — fan-out
   AND single-provider `--merge`. No arm-count-dependent split.
5. **Identity widening**: canonicalization collapses `www.`/apex in
   the identity key only (emitted URLs stay verbatim — the D3
   rule). Near-duplicate clustering (title shingles, fixed
   deterministic thresholds) collapses same-story results to one
   representative; provenance accumulates. Both layers are
   rank-independent identity corrections, active in BOTH modes.
6. **Inspectability**: every rrf result carries additive-optional
   `fusionScore` (fixed 3 decimals); clustered results carry
   `clusterUrls`.
7. **Weights excluded**: provider weighting is NOT sanctioned until a
   provider-specialty / routing-preference capability exists and is
   separately decided.

## Consequences

- Merged output (fan-out and `--merge`) reorders on upgrade — a
  release-visible Changed bullet; `config set fusion occurrence`
  restores the legacy ordering byte-identically.
- ADR-0004 decision 4 is superseded; ADR-0004 remains as history
  with a superseded pointer (ADR hygiene: supersede, never delete).
- Cache identity, request shapes, billing, and the journal are
  untouched — fusion is local post-normalization.
- The `www.`/apex recorded gate in `url.ts` is resolved (key-only
  collapse); origin semantics for every other consumer are
  unchanged.
- Adding scoring beyond this family (models, provider scores,
  weights) starts a new ADR — this one sanctions RRF + occurrence
  only.

## Considered Options

- **Amend ADR-0004 decision 4** — rejected (owner): a default-on
  behavior change deserves a full superseding record, not an
  annotation.
- **RRF opt-in, default stays occurrence** — rejected (owner): the
  better ranker should be the default; the legacy mode remains as
  the escape hatch.
- **Query flag (`--fusion rrf`)** — rejected (owner): config-key-only
  surface; no per-invocation flag.
- **Fan-out-only scope** — rejected (owner Q7): one algorithm at one
  seam; arm-count-dependent behavior would be incoherent.
- **Near-dup clustering deferred** — rejected (owner Q4): URL
  permutation + syndication pollution is a live defect today.
