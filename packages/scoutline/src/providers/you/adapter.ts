/**
 * You.com Provider Adapter (SPEC: dual-host — `ydc-index.io` for
 * Search/Contents, `api.you.com` for Research).
 *
 * Implements the You.com Provider Descriptor. The Adapter owns
 * credentials, transport lifecycle, Provider field mapping, and failure
 * normalization; shared execution owns cache and retry policy. This
 * module currently stands up the Descriptor skeleton and the Search
 * validation contract; the wire-level Search transport and the
 * Reader/Research/Diagnostics capabilities land in follow-up commits.
 *
 * Boundary rules (same as the Exa adapter):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential Module.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Control mapping (SearchControls → You.com-native request fields):
 *   type -> rejected (no You.com-native mapping; it is Brave-only and
 *          routes to its video endpoint). Rejection happens in
 *          `validate`, before credential resolution or any transport
 *          call, so option-level provider fallback can continue past
 *          You.com to the capable Provider.
 */

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type {
  SearchCapability,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import { ApiError, UnsupportedOptionError, ValidationError } from "../../lib/errors.js";
import { isYouConfigured, requireYouApiKey } from "./credentials.js";

/**
 * Injectable transport ports. Production resolves to the global `fetch`
 * and timers inside the client transport; tests inject a fake `fetch`
 * and never touch the network.
 */
export interface YouTransportDeps {
  readonly fetch?: typeof fetch;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** Dependencies the You.com Adapter accepts. */
export interface YouAdapterDependencies {
  /** Optional transport injection (fetch, timers). */
  readonly transport?: YouTransportDeps;
}

/**
 * `PROVIDER_IDS` widens with `"you"` when the registry wires this
 * descriptor; until then these local intersections keep the factory's
 * return types assignable to the contract types (`ProviderDescriptor` /
 * `ProviderAdapter`) without widening the public Provider ID union from
 * inside the Adapter.
 */
export type YouAdapter = Omit<ProviderAdapter, "id"> & { readonly id: "you" };
export type YouDescriptor = Omit<ProviderDescriptor, "id" | "create"> & {
  readonly id: "you";
  create(context: ProviderContext): YouAdapter;
};

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

/** Options the You.com Search Capability binds at construction time. */
interface YouSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: YouTransportDeps;
}

function createYouSearchCapability(options: YouSearchCapabilityOptions): SearchCapability {
  const { env } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // type has no You.com-native param (it is Brave-only and routes
      // to its video endpoint); reject before any transport call so the
      // option-level fallback contract can continue past You.com to the
      // capable provider.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("you", "search", "type");
      }
    },

    cacheIdentity() {
      // The real credential-fingerprinted identity (hashYouApiKey over
      // the resolved key) lands together with the wire-level Search
      // client; until then identity requests fail loudly instead of
      // returning a placeholder that could poison shared cache keys.
      throw new ApiError("You.com search is not available yet", 501);
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);
      requireYouApiKey(env);
      // The wire-level transport lands with the Search client; until
      // then a validated request fails loudly instead of fabricating
      // sources (an empty array would be a silent lie).
      throw new ApiError("You.com search is not available yet", 501);
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the You.com Provider Descriptor. Construction is
 * side-effect-free; `create()` captures the injected environment but
 * reads no credentials, constructs no transport, and performs no I/O —
 * credential resolution and transport calls happen only inside
 * Capability invocation after validation.
 */
export function createYouDescriptor(dependencies?: YouAdapterDependencies): YouDescriptor {
  const transport = dependencies?.transport;

  return {
    id: "you",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isYouConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      // Advertises exactly the slots the created Adapter supplies;
      // Reader, Research, and Diagnostics join as their handles land.
      return new Set<ProviderCapability>(["search"]);
    },
    create(context: ProviderContext): YouAdapter {
      const search = createYouSearchCapability({
        env: context.env,
        transport,
      });
      return { id: "you", search };
    },
    credentialEnvVars: ["YDC_API_KEY", "YOU_API_KEY"],
  };
}
