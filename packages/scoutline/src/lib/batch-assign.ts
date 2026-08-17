/**
 * Batch Assignment module (batch-runner DESIGN D4).
 *
 * Deterministic provider distribution for a parsed batch manifest:
 *   - Eligibility per command-group: descriptors that are
 *     `isConfigured(env, capabilityId)` AND `capabilities().has(capabilityId)`,
 *     in registry order.
 *   - Round-robin cursors per capability id (the grouping key). Vision ops
 *     resolve to their per-operation `vision.<operation>` id through the
 *     same chain the manifest parser pins: the local mirror of
 *     `visionOperationForCommand` (module-private in `index.ts`, mirrored
 *     inside `batch-manifest.ts`) chained through the exported
 *     `visionOperationToCapability` (`capabilities/vision.ts`).
 *   - Pin precedence: per-op `provider` > global `--provider` >
 *     distribution. Pinned ops never consume a cursor slot.
 *   - Zero eligible providers for a group that needs distribution →
 *     whole-batch `ValidationError` naming the configured set and the
 *     registry (mirrors `executeFanoutPlan`'s zero-arms wording).
 *
 * Same manifest + same eligible sets → same assignment, always. The
 * module performs no I/O and never calls `descriptor.create()`;
 * descriptors are metadata-only here (the dry-run gates and the runner
 * consume the returned `capabilityId` for their own checks).
 */

import { ValidationError } from "./errors.js";
import { batchCommandCapabilityId } from "./batch-manifest.js";
import type { AllowedBatchCommand, BatchManifest } from "./batch-manifest.js";
import type { ProviderCapability, ProviderDescriptor, ProviderId } from "../providers/types.js";

/**
 * Injected dependencies. `descriptors` is the provider registry in
 * registry order; `env` feeds the capability-aware configuration check;
 * `globalProvider` is the global `--provider` pin (already validated by
 * dispatch) which disables distribution for every unpinned op.
 */
export interface BatchAssignmentDeps {
  readonly descriptors: readonly ProviderDescriptor[];
  readonly env: NodeJS.ProcessEnv;
  readonly globalProvider?: ProviderId;
}

/** One resolved assignment, aligned with manifest order. */
export interface BatchProviderAssignment {
  readonly name: string;
  readonly command: AllowedBatchCommand;
  /** Capability id the op exercises — the cursor's grouping key. */
  readonly capabilityId: ProviderCapability;
  /** Resolved provider: pin (per-op or global) or round-robin assignment. */
  readonly provider: ProviderId;
}

/**
 * Eligible providers for a capability: configured for that capability
 * AND advertising it, in registry order (D4).
 */
function eligibleProviders(
  descriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv,
  capabilityId: ProviderCapability,
): readonly ProviderDescriptor[] {
  return descriptors.filter(
    (d) => d.isConfigured(env, capabilityId) && d.capabilities().has(capabilityId),
  );
}

/**
 * Whole-batch error when distribution is required but impossible. Names
 * the configured set (providers holding credentials for this capability,
 * regardless of what they advertise — the "could serve" half of the
 * mismatch) and the full registry (the "what exists" half), mirroring
 * `executeFanoutPlan`'s zero-arms wording.
 */
function zeroEligibleError(
  descriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv,
  capabilityId: ProviderCapability,
): ValidationError {
  const configuredSet =
    descriptors.filter((d) => d.isConfigured(env, capabilityId)).map((d) => d.id).join(", ") ||
    "(none)";
  const registrySet = descriptors.map((d) => d.id).join(", ") || "(none)";
  return new ValidationError(
    `batch distribution produced no eligible providers for capability "${capabilityId}"; configured providers: ${configuredSet} (registry: ${registrySet}).`,
    "Configure at least one provider's API key for this capability, or pin operations to a specific provider.",
  );
}

/**
 * Assign every operation in the manifest a provider (DESIGN D4).
 *
 * Walks ops in manifest order. Pinned ops (per-op `provider`, then
 * `deps.globalProvider`) resolve to their pin and never touch a cursor;
 * unpinned ops receive `eligible[cursor++ % len]` from their capability
 * group's eligible list. Groups are keyed by capability id, so a
 * mixed-vision batch holds separate cursors per sub-operation and a
 * search op never consumes a vision or read slot. The zero-eligible
 * error fires only for a group that actually needs distribution — a
 * global pin disables distribution entirely, and per-op pins are
 * validated (registry + capable) at manifest parse.
 */
export function assignBatchProviders(
  manifest: BatchManifest,
  deps: BatchAssignmentDeps,
): readonly BatchProviderAssignment[] {
  const eligibleByCapability = new Map<ProviderCapability, readonly ProviderDescriptor[]>();
  const cursors = new Map<ProviderCapability, number>();

  return manifest.operations.map((op) => {
    // The strict parse proved `input` matches the field table for
    // `command`; the interface union cannot be narrowed to the parser's
    // Record shape here — hence the double cast.
    const capabilityId = batchCommandCapabilityId(
      op.command,
      op.input as unknown as Readonly<Record<string, unknown>>,
    );

    if (op.provider !== undefined) {
      return { name: op.name, command: op.command, capabilityId, provider: op.provider };
    }
    if (deps.globalProvider !== undefined) {
      return {
        name: op.name,
        command: op.command,
        capabilityId,
        provider: deps.globalProvider,
      };
    }

    let eligible = eligibleByCapability.get(capabilityId);
    if (eligible === undefined) {
      eligible = eligibleProviders(deps.descriptors, deps.env, capabilityId);
      if (eligible.length === 0) {
        throw zeroEligibleError(deps.descriptors, deps.env, capabilityId);
      }
      eligibleByCapability.set(capabilityId, eligible);
    }

    const cursor = cursors.get(capabilityId) ?? 0;
    cursors.set(capabilityId, cursor + 1);
    // `eligible.length > 0` is established above; the index is in range.
    const provider = eligible[cursor % eligible.length]!.id;
    return { name: op.name, command: op.command, capabilityId, provider };
  });
}
