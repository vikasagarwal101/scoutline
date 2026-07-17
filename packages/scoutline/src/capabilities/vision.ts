/**
 * Provider Vision Capability (DESIGN.md §8, PRD FR-020, FR-022 to FR-026,
 * FR-050, NFR-004, NFR-006).
 *
 * Defines the normalized Vision Capability shared by every Provider that
 * supports single-image interpretation. Commands pass a `VisionRequest`
 * (a discriminated union over the eight operation shapes) and the
 * shared `invokeVision` helper:
 *
 *   1. Maps the operation to a stable `vision.<operation>` Capability id.
 *   2. Reads descriptor-level capability metadata (pure; no Adapter
 *      construction). If the descriptor does not advertise the
 *      Capability, throws `UnsupportedCapabilityError(provider, ...)`
 *      BEFORE `descriptor.create()` is called. No credentials, no media,
 *      no transport, no cache, no fallback Adapter are observed.
 *   3. Calls `descriptor.create(context)` and defensively double-checks
 *      the Adapter's `supports(operation)`. If the Adapter says no,
 *      throws the same error before `invoke` runs.
 *   4. Calls `adapter.vision.invoke(request)` and returns the normalized
 *      text. Vision never uses the response cache and never falls back
 *      to another Provider.
 *
 * This module imports no Provider transport and no Provider Adapter.
 * The error class import below is from `lib/errors.ts` (a shared error
 * contract, not Provider transport), which is the existing boundary
 * pattern for the Search Capability Module. The retry wrapper lives
 * above `invokeVision` and passes a `() => Promise<string>` closure so
 * Vision can be invoked through `executeProviderOperation("vision",
 * ...)` (DESIGN.md §10) without coupling this file to that contract.
 *
 * P3-01 introduces only the contract + the early-fail ordering proof.
 * Real Z.AI and MiniMax `vision` Adapters arrive in P3-03; the
 * built-in descriptor factories in `providers/types.ts` advertise
 * `vision.<operation>` Capability metadata now so the support check is
 * wired through descriptor metadata from the start.
 */

import { UnsupportedCapabilityError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Request: discriminated union over the eight operations
// ---------------------------------------------------------------------------

/**
 * A Provider-neutral Vision request. Commands construct one of these
 * shapes from their semantic arguments; Adapters map them to the
 * Provider's transport shape. Adding a new operation requires extending
 * this union, the `ProviderCapability` union in `providers/types.ts`,
 * and the `ALL_VISION_OPERATIONS` set below.
 */
export type VisionRequest =
  | {
      operation: "interpret-image";
      source: string;
      instruction: string;
    }
  | {
      operation: "ui-artifact";
      source: string;
      instruction: string;
      outputType: "code" | "prompt" | "spec" | "description";
    }
  | {
      operation: "extract-text";
      source: string;
      instruction: string;
      programmingLanguage?: string;
    }
  | {
      operation: "diagnose-error";
      source: string;
      instruction: string;
      context?: string;
    }
  | {
      operation: "diagram";
      source: string;
      instruction: string;
      diagramType?: string;
    }
  | {
      operation: "chart";
      source: string;
      instruction: string;
      focus?: string;
    }
  | {
      operation: "diff";
      expectedSource: string;
      actualSource: string;
      instruction: string;
    }
  | {
      operation: "video";
      source: string;
      instruction: string;
    };

/** Convenience: the set of every supported operation. */
export type VisionOperation = VisionRequest["operation"];

/** Every operation that exists in the discriminated union. */
export const ALL_VISION_OPERATIONS: ReadonlySet<VisionOperation> = new Set([
  "interpret-image",
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "diff",
  "video",
]);

// ---------------------------------------------------------------------------
// Operation → Capability id mapping (no Provider imports)
// ---------------------------------------------------------------------------

/**
 * Stable Capability id for a Vision operation. Each id matches a member
 * of the `ProviderCapability` union declared in `providers/types.ts`.
 * This mapping is the single source of truth: Adapters advertise the id;
 * `invokeVision` reads it; commands never branch on the id directly.
 */
export function visionOperationToCapability(
  operation: VisionOperation,
):
  | "vision.interpret-image"
  | "vision.ui-artifact"
  | "vision.extract-text"
  | "vision.diagnose-error"
  | "vision.diagram"
  | "vision.chart"
  | "vision.diff"
  | "vision.video" {
  switch (operation) {
    case "interpret-image":
      return "vision.interpret-image";
    case "ui-artifact":
      return "vision.ui-artifact";
    case "extract-text":
      return "vision.extract-text";
    case "diagnose-error":
      return "vision.diagnose-error";
    case "diagram":
      return "vision.diagram";
    case "chart":
      return "vision.chart";
    case "diff":
      return "vision.diff";
    case "video":
      return "vision.video";
  }
}

// ---------------------------------------------------------------------------
// Vision Capability interface
// ---------------------------------------------------------------------------

/**
 * Vision Capability contract. Every Adapter that supports a Vision
 * operation implements this interface and exposes it as `adapter.vision`.
 * The Adapter owns Provider field mapping, transport, and credentials;
 * commands call only these two methods.
 *
 * `supports` is a pure metadata check. It MUST NOT construct a
 * transport, read a credential, inspect a source, or perform I/O. The
 * shared `invokeVision` helper uses descriptor metadata first and
 * `supports` only as a defensive double-check after `create()`.
 */
export interface VisionCapability {
  /**
   * Report whether the Adapter can perform `operation` against the
   * current environment. Pure metadata; no construction.
   */
  supports(operation: VisionOperation): boolean;

  /**
   * Invoke the Provider and return the normalized text result. The
   * Adapter owns credentials, transport lifecycle, Provider field
   * mapping, and failure normalization. The Adapter closes its
   * transport and never retries inside this method.
   */
  invoke(request: VisionRequest): Promise<string>;
}

// ---------------------------------------------------------------------------
// Shared invocation helper
// ---------------------------------------------------------------------------

/**
 * Minimal Adapter shape `invokeVision` needs. Defined here (instead of
 * importing from `providers/types.ts`) so this file remains free of
 * any Provider imports — the Boundary rule for Capability Modules
 * (ARCHITECTURE.md §2).
 *
 * The descriptor's `create(context)` returns a `ProviderAdapter`; the
 * shared helper accepts anything that exposes `id` and an optional
 * `vision` VisionCapability, matching the Phase 3 ProviderAdapter
 * shape defined in DESIGN.md §5.
 */
export interface VisionInvocationDescriptor {
  readonly id: string;
  capabilities(): ReadonlySet<string>;
  create(context: { readonly env: NodeJS.ProcessEnv }): {
    readonly id: string;
    readonly vision?: VisionCapability;
  };
}

/**
 * Invoke a Vision request through a Provider descriptor. The support
 * check happens BEFORE `descriptor.create()` (using descriptor
 * metadata) and is then double-checked against the Adapter's
 * `supports` after construction. Failures throw
 * `UnsupportedCapabilityError` and never touch credentials, media,
 * transport, cache, or a fallback Adapter.
 *
 * Phase 3 P3-01 introduces the contract and the early-fail ordering
 * proof; Phase 3 P3-03 supplies the real Adapter implementations.
 * Until then the built-in descriptors advertise metadata so the
 * ordering is provable today.
 */
export async function invokeVision(
  descriptor: VisionInvocationDescriptor,
  request: VisionRequest,
  context: { readonly env: NodeJS.ProcessEnv },
): Promise<string> {
  const capabilityId = visionOperationToCapability(request.operation);

  // Step 1: descriptor-level metadata. NO create(), NO construction.
  if (!descriptor.capabilities().has(capabilityId)) {
    throw new UnsupportedCapabilityError(descriptor.id, capabilityId);
  }

  // Step 2: create() is allowed now — it is side-effect-free, only
  // captures the injected env. Credentials, transport, and SDK are
  // built lazily inside Capability invocation.
  const adapter = descriptor.create(context);

  // Step 3: defensive double-check against the Adapter's own metadata.
  // If the Adapter says no, fail closed before invoke runs.
  const vision = adapter.vision;
  if (!vision || !vision.supports(request.operation)) {
    throw new UnsupportedCapabilityError(descriptor.id, capabilityId);
  }

  // Step 4: invoke. No cache lookup, no fallback Adapter. Retries live
  // above this call in `executeProviderOperation("vision", ...)`.
  return vision.invoke(request);
}
