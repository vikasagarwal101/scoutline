/**
 * Stable common mapping runtime for MiniMax specialized Vision mappings
 * (DESIGN.md §15, phases/05-specialized-vision.md P5-02).
 *
 * P5-03's operation-specific Modules (`vision-mappings/{op}.ts`) import
 * shared helpers from this file. Keeping the shared prompt-composition
 * and result-normalization logic here means a single intentional edit
 * invalidates every mapping revision at once — exactly the contract
 * the conformance registry enforces.
 *
 * Boundary rules:
 *   - Pure helpers only. No `process.env`, no filesystem, no network,
 *     no Provider imports.
 *   - No operation-specific knowledge lives here; per-operation
 *     prompts belong in each Module.
 *   - The byte-content of this file is one of the inputs to every
 *     generated mapping revision, so changing it intentionally
 *     invalidates every mapping's attestation.
 *
 * At P5-02 the helpers below are foundational; no operation Module
 * imports them yet. P5-03a–P5-03e will compose prompts through
 * `composeMappingPrompt` and normalize results through
 * `normalizeMappingResult`.
 */

import { ApiError } from "../../../lib/errors.js";

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * A single composed prompt segment. Segments are joined with blank-line
 * separators so each segment (intent, instruction, options) forms a
 * distinct paragraph in the rendered prompt.
 */
export interface MappingPromptSegment {
  readonly kind: "intent" | "instruction" | "option" | "constraint";
  readonly text: string;
}

/**
 * Compose a deterministic multi-paragraph prompt from segments.
 * Trims each segment, drops empties, and joins with exactly one blank
 * line between segments. The composed prompt is stable: identical
 * inputs always produce byte-identical output, which makes the
 * operation Module's revision reproducible.
 */
export function composeMappingPrompt(segments: readonly MappingPromptSegment[]): string {
  const cleaned = segments
    .map((s) => (typeof s?.text === "string" ? s.text.trim() : ""))
    .filter((text) => text.length > 0);
  return cleaned.join("\n\n");
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

/**
 * Normalize the MiniMax Vision `sdk.vision.describe` envelope to a
 * nonempty text string. The characterized envelope is
 * `{ content: string }`; any other shape, or empty content, is a
 * malformed result.
 *
 * Operation Modules in P5-03 will route through this helper so that
 * every specialized mapping applies the same result-shape contract.
 */
export function normalizeMappingResult(raw: unknown): string {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as { content?: unknown };
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content;
    }
  }
  throw new ApiError("MiniMax vision returned a malformed response", 500);
}

// ---------------------------------------------------------------------------
// Option formatting
// ---------------------------------------------------------------------------

/**
 * Format an optional string option as a labelled prompt line, or
 * return the empty string when the value is absent or whitespace-only.
 * Used by operation Modules to render optional fields (programming
 * language, diagram type, focus, context) into the prompt without
 * duplicating the guard logic.
 */
export function formatOptionalOption(label: string, value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return "";
  return `${label}: ${value.trim()}`;
}
