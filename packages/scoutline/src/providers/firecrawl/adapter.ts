/**
 * Firecrawl Provider Adapter — foundation stub (FC-02).
 *
 * Firecrawl is the fourth built-in Provider, supplying the shared
 * search, reader, crawl, and map capabilities plus quota and
 * diagnostics. This ticket lands only the foundation: a Descriptor that
 * advertises the capability set and throws "not yet implemented" from
 * `create()`. The transport client (FC-03) and the async-crawl resume
 * mechanism (FC-04) build on this skeleton; quota and diagnostics
 * arrive in FC-05.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential Module.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * The Descriptor is side-effect-free: `isConfigured()` and
 * `capabilities()` construct no Adapter or transport. `create()` throws
 * until FC-03 supplies the real Adapter, so the Provider is registerable
 * and selectable from day one without pretending to work.
 */

import type { ProviderCapability, ProviderDescriptor } from "../types.js";
import { isFirecrawlConfigured } from "./credentials.js";

/**
 * Build the Firecrawl Provider Descriptor (foundation). Advertises the
 * full Firecrawl capability set so Provider selection, `doctor`, and
 * quota inventory derive from a single source of truth. `create()`
 * throws until FC-03 supplies the real Adapter; the throw surfaces the
 * unfinished Adapter during testing rather than silently failing later.
 */
export function createFirecrawlDescriptor(): ProviderDescriptor {
  return {
    id: "firecrawl",
    isConfigured(env) {
      return isFirecrawlConfigured(env);
    },
    capabilities() {
      return new Set<ProviderCapability>([
        "search",
        "reader",
        "crawl",
        "map",
        "quota",
        "diagnostics",
      ]);
    },
    create() {
      throw new Error("Firecrawl Adapter is not yet implemented; arrives in FC-03.");
    },
  };
}
