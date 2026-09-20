# GLM-OCR supersession — exhaustion-aware routing for `vision extract-text`

Status: accepted (2026-09-20; owner grill of seed
`docs/plans/v2/20-glm-ocr-supersede-vision-ocr.md`, Q1–Q5, with live
API investigation; implementation not scheduled — plan set to follow)

## Context

`vision extract-text` routes OCR through the generalist vision chat
model (plan-covered, $0 marginal). Z.AI ships a purpose-built OCR
specialist — GLM-OCR (0.9B, OmniDocBench V1.5 SOTA 94.6) — via a
dedicated tool endpoint `POST /paas/v4/layout_parsing`, token-metered
at $0.03/1M tokens uniform input+output (≈$0.00004/image). The
endpoint is PAYG-balance-gated, NOT covered by the GLM Coding Plan:
the plan key returns `1113` on both endpoint paths (live-verified
2026-09-10 and 2026-09-20), while a funded key returns 200. Owner
directive: supersede the existing surface — never add a new command.

## Decision

1. **Exhaustion-aware supersession.** `vision extract-text` routes
   to `layout_parsing`; error `1113` maps to the exhaustion seam
   (`QUOTA_ERROR`) and triggers a loud one-line stderr fallback to
   the plan-covered vision chat path. Cost-safe in both directions:
   a 1113 charges nothing; the fallback is $0 marginal. All other
   errors ride the existing Z.AI taxonomy unchanged.
2. **Unconditional routing, no input-sniffing.** Every extract-text
   input goes to glm-ocr (PDFs land there as the only PDF-capable
   path — a capability gain on the existing surface, ≤50MB).
   Document-vs-screenshot heuristics are rejected — the same
   fragile class as credential-inferred provider selection.
   `diagram` stays on the vision path (interpretation, not
   extraction); `vision analyze` untouched; `vision batch`
   inherits the routing by composition.
3. **Minimal wire surface.** The adapter sends `{model:"glm-ocr",
   file: <url|base64>}` only — no page-range flags in v1, no
   client-side page cap (Z.AI's own pages conflict — guide says 100
   pages, the OpenAPI says 30 — so the server owns page-count
   policy; a hardcoded cap is stale-on-arrival). Client pre-checks
   only the stable size caps (image ≤10MB, PDF ≤50MB) before the
   base64 upload. `md_results` becomes the extract-text text blob;
   `layout_details`/bboxes stay internal, and the adapter never
   conflates the two bbox spaces (md_results embeds PIXEL
   coordinates; layout_details.bbox_2d is normalized 0–1).
4. **Caching departs from the vision rule.** Vision results are
   never cached because `analyze` is prompt-driven; layout_parsing
   is a deterministic function of the input file and PAYG-billed,
   so it IS cached: file-content-SHA-256 keyed (path-independent),
   v2 namespace per the established grammar, 24h TTL family,
   `--no-cache` honored, cache hits record no ledger rows.
5. **Quota truth.** The existing monitor endpoint
   (`/api/monitor/usage/quota/limit`) serves PAYG keys too
   (verified: funded key returns the same TIME_LIMIT/TOKENS_LIMIT
   window rows) — `scoutline quota` needs no change. The credits
   balance itself has NO API (docs index, official SDK, and
   endpoint probes all negative) — console-only; the 1113 fallback
   notice is the only in-CLI credits signal.
6. **Usage ledger**: layout_parsing invokes count as billed
   vision-class ops (linear, one row per call attempt).

## Consequences

- Plan-only subscribers silently-with-notice lose the vision path's
  interpretive richness on extract-text (the A/B showed commentary
  and UI-sectioning on the generalist side; verbatim fidelity on
  the specialist side — contract-true for "extract text"). Users
  wanting the interpretive flavor have `vision analyze`.
- PDF input support arrives on `extract-text` free of new surface.
- Wire drift on page limits is documented and server-owned.
- ZHIPU mode gets nothing: bigmodel.cn's OCR is a different product
  (`POST /files/ocr`, multipart, handwriting-oriented, 8MB, no
  PDF) — no layout_parsing parity exists.
- Quality A/B evidence is one image class deep (UI screenshot);
  deeper document/code/table A/Bs are plan-time work on the funded
  key.

## Considered Options

- **Unconditional supersession, no fallback** — rejected (owner):
  hard-fails plan-only subscribers on 1113.
- **Input-aware routing (document sniffing)** — rejected (owner):
  fragile heuristic class; the codebase's own precedent is never to
  infer routing from input shape.
- **Config opt-in, default-off** — rejected (owner): friction on
  the quality win; the fallback already makes opt-out unnecessary.
- **Shelve until plan-covered** — rejected (owner): specialist
  quality + ~$0.00004/image now beats waiting on bundling.
- **Inherit vision's no-cache rule** — rejected (owner): PAYG
  repeat-runs on a deterministic function are pure waste.
