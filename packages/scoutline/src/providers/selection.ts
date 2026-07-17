/**
 * Provider Selection (DESIGN.md §6, PRD FR-001 through FR-005).
 *
 * Pure resolution of a Provider ID from explicit and environment input.
 * No credentials participate; no Adapter is constructed.
 *
 * Precedence:
 *   1. explicit option (trimmed, lowercased)
 *   2. SCOUTLINE_PROVIDER environment variable (trimmed, lowercased)
 *   3. compatibility default `zai`
 *
 * An explicitly empty Provider is present and invalid; it must NOT fall
 * through to the environment or default. Unknown values are invalid in
 * both explicit and environment positions.
 *
 * Only Search, Vision, quota, and diagnostics call this module.
 * Z.AI-only command families (Reader, repository exploration, raw
 * tools, Code Mode) remove the global flag during parsing and never
 * resolve or validate it.
 */

import type { ProviderDescriptor, ProviderId } from "./types.js";
import {
  PROVIDER_IDS,
  getConfiguredProviderDescriptors,
  getProviderDescriptor,
} from "./types.js";
import { ValidationError } from "../lib/errors.js";

// Re-export descriptor helpers at the selection boundary so command
// Modules need only a single import.
export { getProviderDescriptor, getConfiguredProviderDescriptors };

/**
 * Accepted Provider IDs shown in the help message when validation fails.
 */
const ACCEPTED_IDS_HELP = `Accepted provider IDs: ${PROVIDER_IDS.join(", ")}.`;

/**
 * Trim and lowercase a Provider candidate. Returns `null` when the
 * trimmed value is empty so callers can distinguish "absent" from
 * "invalid".
 */
function normalize(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse and validate a Provider ID. Trims and lowercases the input.
 * Empty and unknown values throw `ValidationError` whose `help` lists
 * the accepted IDs.
 */
export function parseProviderId(value: string): ProviderId {
  const normalized = normalize(value);
  if (normalized === null) {
    throw new ValidationError(
      `Provider ID must not be empty. ${ACCEPTED_IDS_HELP}`,
      ACCEPTED_IDS_HELP,
    );
  }
  if (!(PROVIDER_IDS as readonly string[]).includes(normalized)) {
    throw new ValidationError(
      `Unknown provider "${normalized}". ${ACCEPTED_IDS_HELP}`,
      ACCEPTED_IDS_HELP,
    );
  }
  return normalized as ProviderId;
}

/**
 * Resolve the effective Provider ID with explicit precedence over
 * environment over the compatibility default. An explicitly empty
 * value (including whitespace) is treated as present and invalid; it
 * throws `ValidationError` before consulting the environment.
 *
 * `env` defaults to `process.env` for production callers; tests pass
 * an explicit object so they do not touch process globals.
 *
 * `descriptors` is accepted for forward compatibility with P2-05's
 * selection-with-validation hook. P2-01 only uses it to guarantee that
 * an explicitly empty value is rejected before any descriptor lookup.
 */
export function resolveProviderId(
  explicitProvider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  descriptors?: readonly ProviderDescriptor[],
): ProviderId {
  // 1. Explicit option — present (including empty) and invalid if empty/unknown.
  if (explicitProvider !== undefined) {
    return parseProviderId(explicitProvider);
  }

  // 2. Environment variable. An empty value here means "explicitly empty":
  //    present, invalid, and must not fall through to the default.
  const envValue = env.SCOUTLINE_PROVIDER;
  if (envValue !== undefined) {
    return parseProviderId(envValue);
  }

  // 3. Compatibility default. `descriptors` is consulted to surface a
  //    configuration-style error when the default Provider is unavailable,
  //    but only when the caller passes descriptors and `zai` is missing.
  //    Tests that omit descriptors take the plain default.
  if (descriptors !== undefined) {
    const configured = getConfiguredProviderDescriptors(env, descriptors);
    const hasZai = configured.some((d) => d.id === "zai");
    if (!hasZai) {
      // The default `zai` is not registered. Surface this as a validation
      // error so callers receive actionable feedback rather than a silent
      // miss.
      throw new ValidationError(
        `Default provider "zai" is not registered. ${ACCEPTED_IDS_HELP}`,
        ACCEPTED_IDS_HELP,
      );
    }
  }

  return "zai";
}