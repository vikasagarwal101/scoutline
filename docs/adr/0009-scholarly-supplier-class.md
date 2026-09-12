# Scholarly Supplier Class

Science-vertical suppliers (arXiv, OpenAlex, Crossref, PubMed, Europe PMC) are a
distinct architectural class — not Providers, not direct commands. They are
keyless scholarly APIs with their own selection grammar, fan-out merge, and
supplier-level fallback, deliberately excluded from the shared-capability
Provider registry's quota surfaces, exhaustion ranking, and fallback
machinery.

## Why not full Providers?

The Provider model (ADR-0002, ADR-0005) assumes credentialed APIs with quota
telemetry, rate-limit rankings, and cross-capability fallback — none of which
apply to keyless scholarly APIs. Making them Providers would require quota
surfaces they don't have, credential management they don't need, and would
pollute every shared-capability help enumeration with five ids that can never
serve those capabilities.

## Why not direct commands (ADR-0006)?

Direct commands (fetch, archive) are single-source and deterministic. Science
suppliers are multi-source with DOI-deduped fan-out, per-supplier controls,
and their own D5-order fallback on identifier misses — a fundamentally
different consumption model.

## Consequences

- `PROVIDER_IDS` carries all 17 ids; shared-capability help enumerations list
  only the 12 that serve shared capabilities.
- Science suppliers have no quota dashboard rows, no exhaustion-aware ranking,
  no provider-fallback registry participation.
- Science dispatch consults `SCOUTLINE_PROVIDER` env and `--provider` flag,
  but pins route only within the science supplier set.
- The `journaling` and `--save` contracts apply to science as they do to
  search/read/research.
- A future supplier joins by implementing the ScienceSupplier interface and
  registering in the science registry — no Provider adapter needed.
