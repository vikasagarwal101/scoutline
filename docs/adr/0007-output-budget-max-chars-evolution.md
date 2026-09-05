# Output Budget: Evolve `--max-chars` Into Whole-Envelope Reference-Preserving Compaction

Status: accepted (2026-09-05) — implementation pending (seed 10 pickup,
`docs/plans/v2/10-token-budget-output.md` grilling decisions 1–8)

## Context

The only output-sizing tool was `--max-chars`: a per-field character
guillotine on five commands (read, crawl, research, repo,
repository-explorer), with search separately exposing `--max-summary`
and `--count`. Seed 10 originally proposed a new `--budget-tokens`
flag with token estimation and lossy trimming. Grilling (2026-09-05)
rejected both the new flag and lossy trimming.

## Decisions

1. **Evolve `--max-chars` in place** into the whole-envelope Output
   Budget: "fit everything this command prints in ~N characters." No
   new flag surface; the unit stays chars (token estimation via
   `chars/4` was dropped as fake precision). `--max-summary` remains
   the per-field lever; `--count` remains result semantics, never
   reduced by sizing.
2. **Reference-preserving compaction, not truncation.** Whenever the
   budget fires, the FULL untrimmed envelope is implicitly written to
   the `--save` artifacts store and the in-band projection carries
   `compaction { budget, ref, … }`. The deterministic ladder decides
   what appears in-band, never what is destroyed; trimmed material is
   recoverable via `history show`. True meaning-preserving compaction
   would require a model and remains out of scope; any future version
   must be an explicit opt-in synthesis pass (Code-Mode-style escape
   hatch), never a default.
3. **Scope**: exposed only on the six commands with real ladders
   (the five above + search); all other commands reject with
   `UNSUPPORTED_OPTION` at parse time (accept-and-drop is banned by
   the controls-conformance doctrine). `repo brief` switches from
   verbatim per-call forwarding to consuming the flag once on its
   final assembled envelope.
4. **Edge rules**: budgets below the minimum viable envelope clamp to
   the floor with `compaction.note: "floor"` (never error); `--count`
   applies before budget.
5. **The `compaction` field lives inside the data payload**, so it
   survives every output mode including `-O data` — the mode
   scripting agents consume most.

## Consequences

- One documented behavior change to `--max-chars` semantics (per-field
  → whole-envelope), CHANGELOG'd at release.
- `--max-chars` below natural output size now writes to the local
  artifacts store unconditionally — a local-only side effect, the
  price of the "nothing gathered is lost" promise.
- URLs, titles, and citations are never cut in-band; measurement is
  serialized payload length (deterministic, offline-testable);
  fan-out budgets apply post-merge; stderr is untouched.
