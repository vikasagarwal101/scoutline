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
