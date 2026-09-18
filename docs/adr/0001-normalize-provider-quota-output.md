# Normalize Provider Quota Output

Status: accepted

Scoutline will replace its shipped Z.AI-specific quota output with one
provider-neutral Interface. Each Adapter maps its provider response into named
quota categories with current and optional weekly windows, optional counts,
remaining percentage, and reset time so callers do not need provider-specific
knowledge.

## Considered Options

- Add normalized fields beside the existing Z.AI fields. Rejected because it
  preserves two competing meanings and makes the Interface shallow.
- Return provider-specific payloads. Rejected because callers would need to
  branch on Provider and duplicate normalization.
- Use separate quota commands. Rejected because both Providers expose the same
  user meaning despite different response shapes.

## Consequences

- The next release must document the machine-readable output change.
- Z.AI and MiniMax Token Plan quota responses must pass the same Interface tests.
- Provider-only details may be omitted unless they fit optional normalized
  fields without changing shared meaning.

## Amendment — per-tool usage on a quota category (GitHub #191)

Status: accepted (additive)

`QuotaCategory` gains one OPTIONAL field, `toolUsage?: readonly { tool:
string; usage: number }[]`, mapped by the Z.AI Adapter from
`TIME_LIMIT.usageDetails` (`modelCode` -> `tool`, `usage` -> `usage`;
entries without a nonempty tool id or with a non-positive count are
dropped, and an all-dropped list omits the field rather than publishing
an empty array). This is an amendment under the SAME schema version,
not a new one — the PB-T5 precedent: the field is additive and optional,
every pre-#191 consumer (TTY renderer, snapshot round-trip, JSON
envelope) handles its absence via fall-through, and `QuotaDashboard`
stays `schemaVersion: 1`.

Two boundary notes:

- **Redaction.** The per-tool ids are Provider tool identifiers, not
  secrets, but the field still transits the standard redaction seam.
  No new code is needed for this: the success path runs `redactSecrets`
  over the whole data envelope before formatting
  (`invokeCommand` -> `selectOutput`), so anything carried inside a
  category is redacted by construction — belt and suspenders rather
  than a second mechanism.
- **Independence from the consistency guard.** The rows are
  informational window detail and are mapped independently of the
  #191 self-consistency test on the window. A counter that contradicts
  itself loses its `current` window but keeps its per-tool rows.
