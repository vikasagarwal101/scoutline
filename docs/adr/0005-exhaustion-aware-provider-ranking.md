# Exhaustion-Aware Provider Ranking

Status: accepted (2026-08-31; implemented 2026-08-31)

Ships in: 0.19.4 (see `CHANGELOG.md` "Unreleased"). Fixes #97. The reversal is confined to
`rankProvidersForCapability` (quota-mapping.ts) and
`resolveEffectiveProvider` (selection.ts); scoring's meaning is
unchanged and `lib/provider-fallback.ts` stays byte-identical.

## Context

Plan B's ranking contract put every known-tier provider ahead of every
unknown-tier provider, unconditionally: "a known-tier provider at 0%
still ranks above any unknown-tier provider" (configuration.md,
"Authority tiers" and "Ranking output" sections, pre-#97 wording). The
rule treated a 0% known score the same as a 5% one.

Live behavior demonstrated the flaw (#97): a provider whose
capability-mapped quota category reads `remainingPercent === 0` —
e.g. Tavily's key-pool `requests` at 0% — is out of credit, yet the
tier wall floated it to the top of the selection order. A still-
exhausted provider was attempted first on every command, and users
paid for the predictable failure (reactive fallback only fires after
the exhausted provider errors, wasting latency and, on metered
providers, the attempt itself).

## Decision

A known-tier provider whose capability-mapped category reads 0% on a
snapshot entry whose `observedAt` is within 24h
(`QUOTA_EXHAUSTION_DEMOTION_HORIZON_MS`, quota-store.ts) of the
selection clock is demoted into the unknown tier with the machine
reason `KNOWN_EXHAUSTED` and a matching warning, and ranks **strictly
below every natural unknown**: natural unknowns first in registry
order, then demoted entries in registry order. The demotion lives in
`rankProvidersForCapability`, between staging and the known/unknown
partition — `scoreCapability` is unchanged and still returns
`authority:"known", score:0` for a depleted category (pin survives at
the score level). Freshness is judged against a caller-supplied
`now`; without a supplied clock the exhaustiveness check is skipped
entirely (the module stays clockless, and `resolveEffectiveProvider`
defaults to the current clock, so existing call sites behave
unchanged).

The "5% known still wins" claim survives — for healthy known
providers. The pre-#97 documentation claims in configuration.md
("never wins over a mapped provider, even one at 5%", "a known-tier
provider at 0% still ranks above any unknown-tier provider", the
two-band ranking output, and the selection/dashboard correlation note)
are reversed by this decision.

## Grounds

- **Command-coupled best-effort refresh is not a freshness oracle.**
  Snapshots are refreshed after every recognized credentialed command
  (best-effort, production-mode only, skipped for help/dry-run/batch),
  but that cadence is not a guarantee a routing decision may lean on.
  Trusting a 0% reading is bounded by evidence age, not refresh
  cadence.
- **A 10-minute gate would cause trust-decay ping-pong.** Gating
  demotion on the 10-minute command-cadence threshold
  (`DEFAULT_QUOTA_STALE_THRESHOLD_MS`) ties exhaustion-trust to
  refresh cadence: any >10-minute pause between commands would lapse
  the demotion and float a still-exhausted provider back to the top.
  The 24h horizon decouples exhaustion-trust from that cadence; the
  value is insensitive across the hours-to-days band, so retuning is a
  one-constant change.

## Consequences

- The routing prefix and fan-out arms remain quota-blind (routing is
  an instruction, not a hint); this decision changes only the ranked
  path's first pick and its candidate ordering.
- Reactive fallback (ADR-0002) is unchanged: the demotion moves the
  exhausted provider from "attempted first, then reactively skipped"
  to "not attempted first at all".
- Stale 0% evidence (older than the horizon) scores and ranks exactly
  as before #97 — no demotion, known tier, score 0.
- `scoreCapability` output space is unchanged; every downstream
  consumer of `authority` keeps compiling and behaving identically.
- Callers that invoke the ranker without a clock keep the pre-#97
  ordering byte-for-byte.
