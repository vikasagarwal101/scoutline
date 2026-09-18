/**
 * Zone-anchoring instant parser shared by quota normalizers.
 *
 * Provider quota payloads sometimes carry zone-less ISO-8601 timestamps
 * (e.g. `"2026-09-01 00:00:00"`). Bare `Date.parse` anchors those to the
 * HOST timezone, so the same payload yields different `resetsAt` values
 * per machine (#207 SearchApi, #212 Firecrawl). The zone-less form is
 * normalized to an explicit UTC `Z` before parsing. Values already
 * carrying a zone (`Z` or `±HH:MM`) parse as-is; anything unparseable
 * yields `NaN` (callers omit the field).
 */
export function parseZonedInstant(value: string): number {
  const ZONELESS_RE =
    /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*$/; // #217: optional seconds + trim
  const normalized = ZONELESS_RE.test(value) ? `${value.trim().replace(" ", "T")}Z` : value;
  return Date.parse(normalized);
}
