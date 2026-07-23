/**
 * Brave Provider Adapter (brave-tech-plan §2, §5, §6).
 *
 * T1 ships the foundation: the descriptor advertises NO capabilities
 * and `create()` returns a bare `{ id: "brave" }`. Credentials, the
 * direct-HTTP GET transport, and the header-bearing fetch seam are
 * wired and tested; Capability Modules (search, quota, diagnostics,
 * reader, etc.) arrive in later tickets.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 */

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type { BraveTransportDeps } from "./client.js";
import { isBraveConfigured } from "./credentials.js";

/**
 * Dependencies the Brave Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; later tickets (search,
 * quota) will consume it. T1 does not invoke any transport in
 * `create()` or in any Capability path (no Capability is wired yet),
 * but the seam is declared now so the future Capability factories can
 * thread the same transport through.
 */
export interface BraveAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: BraveTransportDeps;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Brave Provider Descriptor. The descriptor advertises the
 * empty capability set (T1) and constructs an Adapter whose every
 * Capability slot is `undefined`. Construction is side-effect-free;
 * the transport is never invoked at module load or in `create()`. The
 * Adapter captures but does not immediately inspect the injected
 * environment; credential resolution and transport construction are
 * allowed only inside Capability invocation after validation — and
 * T1 has no Capability invocation path.
 */
export function createBraveDescriptor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dependencies?: BraveAdapterDependencies,
): ProviderDescriptor {
  return {
    id: "brave",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isBraveConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // T1 foundation: no capabilities. Later tickets (search T2,
      // quota T6, etc.) widen this set in lockstep with the matching
      // Adapter slots.
      return new Set<ProviderCapability>();
    },
    create(_context: ProviderContext): ProviderAdapter {
      return { id: "brave" };
    },
  };
}
