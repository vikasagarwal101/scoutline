# Local Investigation Pipeline — agent-synthesis default

Status: accepted (2026-09-20; owner grill of seed
`docs/plans/v2/06-investigate-pipeline.md`, Q1–Q7; implementation not
yet scheduled — plan set to follow in `docs/plans/investigate-pipeline/`)

## Context

Provider-side Research (Tavily/Exa/Parallel/Perplexity/Jina/You/Linkup)
is a black box: credits burn, steps are invisible, intermediates are
discarded. Scoutline already owns every primitive the providers
bundle — search fan-out (ADR-0004/0012), Reader, Fusion ranking,
response cache, always-on journal (ADR-0008), and the evidentiary
toolchain (ADR-0006). The `investigate` command composes those
capabilities locally into a transparent, deterministic,
cache-resumable pipeline and returns the evidence; the calling agent
writes the prose.

## Decision

1. **`investigate` is a top-level Normal command** — never a mode of
   `research`. It never delegates a provider-side research job; it
   composes fan-out search, Fusion, Reader, and deterministic
   extraction as normal cached operations. Research and Investigation
   both exist with distinct meanings (opaque billed provider job vs.
   local transparent pipeline) — glossary terms are recorded in
   `CONTEXT.md`.
2. **Agent-synthesis is the contract.** The EvidencePack is the
   deliverable; the calling LLM writes the brief. `--synthesize` is
   the explicit escape hatch (Z.AI chat via the existing MCP
   transport, mirroring Code Mode's position) and is **additive
   only** — a brief attaches to the pack, never replaces it.
3. **The pipeline is deterministic and model-free** — the same
   guarantee Fusion carries. Planning uses a three-tier precedence:
   `|`-delimited explicit sub-queries (the `--merge` grammar),
   `--context` derivation (`deriveSubQueries` verbatim), then
   deterministic template decomposition of the bare question
   (≤ 5). Passage extraction is term-based; no model anywhere.
   LLM decomposition is excluded, not merely flagged off.
4. **Hashing discipline extends ADR-0006 §8**: `contentSha256` covers
   provider-normalized content and travels with `contentFormat`;
   byte-evidentiary hashing remains Evidentiary Fetch's job
   (`fetch --sha256`).
5. **Provider selection reuses `search`'s fan-out activation tiers
   verbatim** — no new rules. Cost is explicit: N sub-queries × M
   arms billable searches + K reads. Sources search surfaces but
   Reader cannot fetch are recorded unread in `coverage`, never
   silently dropped.
6. **Lifecycle**: `--isolated` is allowed (no async-job or watch
   state — resumability is pure response-cache replay). Ctrl-C is
   safe by construction. Control surface: `--provider`, `--context`,
   `--sources` (top-K reads, default 5), `--max-chars` (ADR-0007
   budget ladder — absorbs the never-shipped `--budget-tokens` seed),
   `--synthesize`, `--save`. `--depth` and `--arms` are rejected as
   redundant with the tier grammar and `--provider`.
7. **Schema**: `EvidencePack` (`schemaVersion: 1`) lives in
   `src/capabilities/investigation.ts`; persistence is opt-in
   `--save` through the existing artifact seam (no parallel artifact
   format; journal entries come from the underlying ops for free).

## Consequences

- New command family → capability matrix, SKILL, READMEs, help, and
  CHANGELOG updates at ship time.
- Warm re-runs are nearly free (cache replay); the journal already
  records every underlying search/read.
- `verify` mode (claim corroboration) is deferred, not rejected —
  it rides the same extraction and source-overlap machinery in a
  follow-up release.
- Anything model-based entering the pipeline (LLM planning,
  model reranking, synthesis beyond the escape hatch) starts a new
  ADR.

## Considered Options

- **`research --local` mode** — rejected (owner Q1): overloads a
  clean Normal command with an incompatible lifecycle (async-job
  resume, `--isolated` rejection, 4–250-credit billing).
- **Provider-synthesis default** — rejected (owner Q2): breaks
  determinism and provider-neutrality; the primary user is an agent.
- **Synthesis replacing the pack** — rejected (owner Q2): an
  evidence-less brief defeats the evidentiary discipline.
- **`verify` in v1** — rejected (owner Q6): second product surface;
  nothing in v1 blocks adding it later.
- **`--budget-tokens`** — rejected (owner Q7): the ADR-0007 output
  budget ladder already caps returned payloads.
- **`--depth` / `--arms` flags** — rejected (owner Q7): redundant
  with the planning tier grammar and `--provider` arms semantics.
