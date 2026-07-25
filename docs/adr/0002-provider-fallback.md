# Provider Fallback is the Default

Status: accepted

Scoutline reverses its long-standing "no fallback" contract. Provider
fallback is now **always-on** for every capability that participates in
provider selection: when the selected provider cannot serve the request
(it does not advertise the capability, it is unconfigured, or it fails
at runtime), scoutline silently tries the next eligible provider and
informs the user via a stderr notice. The user no longer has to know or
care which provider ultimately answers.

This ships in **0.11.0** as a minor release because it reverses the most
heavily documented invariant in the project.

## Context

Prior to 0.11.0, every shared-capability command (`search`, `read`,
`repo`, `crawl`, `map`, `research`, `vision`) treated `--provider` and
`SCOUTLINE_PROVIDER` as a *hard pin*: selecting a provider that did
not advertise the capability returned `UNSUPPORTED_CAPABILITY`
before any descriptor configuration, adapter creation, credential
resolution, cache identity, or transport construction. A provider that
failed at runtime failed the whole command. The contract was repeated
across `CONTEXT.md`, `docs/architecture.md`, `docs/configuration.md`,
`docs/development.md`, `docs/troubleshooting.md`, the two `README.md`
files, the agent skill, every command's help text, and the inline
comments in `src/index.ts`.

The contract is wrong for the operating environment scoutline now
serves. Capability coverage is uneven (e.g. only Tavily and Firecrawl
supply `crawl`/`map`; only Tavily and Exa supply `research`; only Z.AI
supplies `repository-exploration`), and a single hard failure mode
forces the user to know which provider is preferred for which command
in order to recover. The "no fallback" guarantee that simplified the
mental model also cost resilience: a transient timeout on Z.AI for
`search` ended the command, even when the next configured provider
could have answered.

## Decision

1. **Always-on by default.** Provider fallback is automatic; the user
   does not opt in. The candidate chain is built once per request:
   the effective (pinned or default) provider first, then every
   remaining built-in provider in registry order
   `[zai, minimax, tavily, exa, brave, firecrawl]`. Providers that are
   not configured or do not advertise the capability (including
   option-level support such as `--type video`) are dropped from the
   chain. The first successful candidate wins; every switch emits a
   single-line stderr notice, and a single summary line is emitted on
   success after one or more switches (`✓ <cmd> completed via
   <provider> (fallback)`). When the effective provider answers
   directly, no notice is emitted — silent success, identical to
   before.
2. **Both failure modes fall back:** *capability mismatch* (the
   selected provider does not advertise the capability) and *runtime
   failure* (the provider errored, timed out, exhausted its quota, or
   has no credential). `ValidationError` (bad user input) short-circuits
   the loop — no provider can fix invalid input, and looping would only
   repeat the same error.
3. **Fallback from an explicit `--provider` choice.** The pin makes
   the provider the *preferred* (first-tried) one, not the *only* one.
4. **Kill-switch:** `--no-fallback` (or `SCOUTLINE_NO_FALLBACK=1`)
   restores the previous strict single-provider, fail-loud behavior for
   scripting and cost-sensitive workflows. The kill-switch runs the
   **same** preflight (capability → configuration → adapter handle
   agreement) for the effective provider only and stops; an incapable
   effective throws `UnsupportedCapabilityError` (exit 1) and an
   unconfigured effective throws `ConfigurationError` (exit 3), with
   no adapter work for the unsupported case.
5. **Notices via stderr only.** The stdout data envelope is unchanged;
   scripting consumers that parse `data` mode are unaffected.
6. **Search-result contract:** the winning provider's output shape is
   returned as-is. There is no cross-provider result normalization
   (e.g. Tavily's null titles vs Firecrawl's real titles) — that is a
   non-goal of this release.

## Pre-charge boundary is unprovable (cold-critique evidence)

The earlier drafts of this decision attempted to give the cost-bearing
async capabilities (`crawl`, `map`, `research`) a "pre-charge
safeguard": a synchronous `create()` step, an explicit acknowledgement
that the provider had not yet charged, and a separate `poll()` step
that the fallback loop would not enter. Cold critique proved that
boundary **unprovable**:

- Firecrawl's `/v2/crawl` accepts the create POST and charges a job,
  then can throw on a lost response (network blip, client crash, proxy
  timeout) after the server has already accepted and started the job.
- Tavily's `/research` create endpoint returns a `request_id` and
  begins the credit-bearing work immediately; the Adapter's state file
  only protects against a *re-run* of the identical request, not a
  fallback hop to a different provider.
- Exa's Agent API begins billing on the create call; a lost response
  leaves the request charged but unpolled.
- None of these providers offer an idempotency key, an explicit
  pre-charge acknowledgement, or a refund for accepted-then-failed
  work. There is no portable way to ask "did you charge me yet?"

A separate create/poll split therefore could not guarantee that
fallback after a runtime failure would not double-charge. The split
was dropped: every capability — sync and async — uses one uniform
single-phase shape, and the cost-bearing async capabilities fall back
the same way as the sync ones (a runtime failure moves to the next
provider).

## Accepted risk

For `crawl`, `map`, and `research`, a runtime failure on the effective
provider may fall back to another provider **even if the failed
provider had already accepted or charged a job.** This can result in
two charged jobs across providers. The tradeoff is accepted in
exchange for resilience: the documented opt-out is
`--no-fallback` / `SCOUTLINE_NO_FALLBACK`, which restores strict
single-provider behavior (no double-charge path reachable).

The worst-case charged-request counts under retry+fallback with both
candidates configured are:

| Capability | maxRetries | Worst-case charged POSTs | Default (winner only) | Under `--no-fallback` |
| --- | --- | --- | --- | --- |
| `crawl` | 0 | ≤ 2 | 1 | 1 |
| `map` | 0 | ≤ 2 | 1 | 1 |
| `research` | 0 | ≤ 2 | 1 | 1 |

The accepted risk is documented in this ADR, the
`crawl` / `map` / `research` command help, and
`docs/troubleshooting.md`. Cost-sensitive workflows should set
`SCOUTLINE_NO_FALLBACK=1`.

## Capability ordering preserved under `--no-fallback`

The capability-before-configuration ordering invariant (FR-023, FR-024)
is **preserved** under the kill-switch, not retired. The kill-switch
narrows the candidate plan to `[effective]` and runs the *same*
preflight (capability metadata → configuration → adapter handle
agreement) on it; the preflight is the documented ordering and the
kill-switch does not bypass it. This is the deliberate fix for the
critique finding that the previous strict path surfaced the same
errors but in a different order — strict mode today still fails on
`UnsupportedCapabilityError` (exit 1) before it ever asks for a
credential, and on `ConfigurationError` (exit 3) before it constructs
an adapter. Zero adapter work for the unsupported case is asserted by
test.

The ordering is **relaxed** for the default (fallback-enabled) path,
because the executor must build a candidate plan across multiple
providers, which requires the configuration check for every candidate.
That check still runs before any adapter is constructed, so the
invariant "the descriptor is the only thing consulted before
configuration" is preserved for the effective provider; the executor
adds the same check for the remaining candidates before constructing
*their* adapters. The cache is provider-partitioned
(`v2.<capability>.<provider>.<credential-hash>.<request-hash>.json`),
so no cross-provider contamination is possible.

## Consequences

- Every public surface that promised "no fallback" is rewritten to
  reflect the new always-on default; the kill-switch is the only
  mention of the previous behavior, and it is documented prominently
  in command help, `docs/troubleshooting.md`, and the agent skill.
- Capability-mismatch auto-reroute is the headline user-visible
  change. `--provider minimax repo tree facebook/react` now succeeds
  via Z.AI with a stderr notice, instead of failing with
  `UNSUPPORTED_CAPABILITY`. Under `--no-fallback` it fails again with
  the exact 0.10.x code, so scripts and cost-sensitive workflows
  retain the strict behavior.
- `crawl` / `map` / `research` commands expose the accepted risk in
  their help text and in `docs/troubleshooting.md`.
- The data envelope is unchanged; the only consumer-visible signal of
  fallback is the stderr notice channel.
- `--no-fallback` is tested to restore exact 0.10.x exit codes for
  every shared-capability command.

## Considered Options

- **Keep the hard-pin contract; require the user to pick the right
  provider.** Rejected: the operating environment now has six
  built-in providers with uneven capability coverage; asking the user
  to know the matrix for every command is a usability regression.
- **Add fallback as opt-in only (`--fallback` flag).** Rejected:
  opt-in means the user must read the new docs to get the resilience
  gain. The current docs already over-promise strict behavior;
  inverting the default keeps docs honest and matches the principle
  that resilience should be the default.
- **Add a synchronous pre-charge acknowledgement via the
  `create()`/`poll()` split for cost-bearing ops.** Rejected: the
  cold-critique finding that the pre-charge boundary is unprovable
  means the split does not deliver its promised safety; the uniform
  single-phase shape is simpler and the documented opt-out is the
  user's safety valve.
- **Provide a per-provider cost ceiling.** Rejected for 0.11.0: a
  maintained cost model requires per-provider price/volume data the
  project does not collect. The registry order already places
  subscription providers before credit-based ones, which is accepted
  as the de-facto cost-aware order.
