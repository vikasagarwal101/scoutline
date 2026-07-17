# Scoutline Context

Scoutline presents source-investigation capabilities through stable command
meaning while external Providers supply the underlying results.

## Language

**Provider**:
An external product that supplies one or more Scoutline Capabilities. A Provider
does not need to supply every Capability.
_Avoid_: backend, vendor

**Capability**:
A user-visible meaning that can be supplied by more than one Provider, such as
Search or single-image interpretation.
_Avoid_: tool, endpoint

**Normal command**:
A predictable Scoutline command whose meaning is independent of the selected Provider.
_Avoid_: provider command, raw command

**Raw provider tool**:
A provider-qualified operation exposed without provider-neutral normalization,
such as an operation under `scoutline.zai.*`.
_Avoid_: normal command

**MiniMax Token Plan**:
The selected second Provider. Its confirmed source-investigation Capabilities
are Search and single-image interpretation through subscription-backed access.
The base release also normalizes its quota reporting and diagnostic probe as
operational Capabilities.
_Avoid_: MiniMax Coding Plan, MiniMax platform

## Flagged Ambiguities

**Vision**:
The current command family contains six single-image operations, two-image
comparison, and video analysis. The shared Capability currently proven across
Z.AI and MiniMax Token Plan is only single-image interpretation; broader Vision
parity remains unresolved.

## Example Dialogue

Developer: "Does the MiniMax Token Plan Provider support every Normal command?"

Domain expert: "No. A Provider can supply only some Capabilities. MiniMax Token
Plan currently proves Search and single-image interpretation, while its Raw
provider tools remain distinct from Scoutline's Normal commands."
