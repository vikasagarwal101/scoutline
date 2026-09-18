/**
 * Static Provider Registry (DESIGN.md §5, P2-05).
 *
 * The production registry is a static list of built-in Provider
 * Descriptors in canonical fallback order. It performs
 * NO dynamic imports, accepts no package names, file paths, or
 * externally supplied factories. Tests inject descriptor lists through
 * the explicit optional parameters of {@link getProviderDescriptor} and
 * {@link getConfiguredProviderDescriptors}; production uses the static
 * built-in list by default.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - Imports the real Adapter Modules (`providers/zai/adapter.js`,
 *     `providers/minimax/adapter.js`), NOT the P2-01 stubs in `types.ts`.
 *   - Must NOT import command Modules, shared execution, or transport.
 */

import { createZaiDescriptor } from "./zai/adapter.js";
import { createMiniMaxDescriptor } from "./minimax/adapter.js";
import { createTavilyDescriptor } from "./tavily/adapter.js";
import { createExaDescriptor } from "./exa/adapter.js";
import { createBraveDescriptor } from "./brave/adapter.js";
import { createFirecrawlDescriptor } from "./firecrawl/adapter.js";
import { createParallelDescriptor } from "./parallel/adapter.js";
import { createPerplexityDescriptor } from "./perplexity/adapter.js";
import { createJinaDescriptor } from "./jina/adapter.js";
import { createLinkupDescriptor } from "./linkup/adapter.js";
import { createYouDescriptor } from "./you/adapter.js";
import { createSpiderDescriptor } from "./spider/adapter.js";
import { createBochaDescriptor } from "./bocha/adapter.js";
import { createSearchApiDescriptor } from "./searchapi/adapter.js";
// The science verticals ship their real adapters; none of the seats
// still import the stub factories from types.js.
import { createArxivDescriptor } from "./arxiv/adapter.js";
import { createOpenalexDescriptor } from "./openalex/adapter.js";
import { createCrossrefDescriptor } from "./crossref/adapter.js";
import { createPubmedDescriptor } from "./pubmed/adapter.js";
import { createEuropepmcDescriptor } from "./europepmc/adapter.js";
import type { ProviderDescriptor, ProviderId } from "./types.js";
import {
  getProviderDescriptor as lookupProviderDescriptor,
  getConfiguredProviderDescriptors as lookupConfigured,
} from "./types.js";

/**
 * Built-in Provider Descriptors in canonical order. Each Descriptor is
 * constructed once at module load with its production (no-argument)
 * factory; the Adapters bind their real transports lazily, only inside
 * Capability invocation.
 *
 * IO-FREE IMPORT INVARIANT (#159): module import constructs every
 * descriptor below, so a descriptor factory must perform NO filesystem
 * I/O and must not resolve environment-derived paths into strings at
 * construction time — a value like `asyncJobStateDir(...)` captured
 * here freezes against the import-time env and never sees a
 * `SCOUTLINE_CACHE_DIR` set later. Environment-derived defaults must
 * stay deferred pure computations, resolved inside `create()` (or
 * later). The spawn-based import canary in
 * `tests/async-job-state-lazy.test.js` pins the no-writes half of this
 * invariant; the lazy-resolution pins in the same file pin the
 * deferred-resolution half.
 */
export const BUILT_IN_PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  createZaiDescriptor(),
  createMiniMaxDescriptor(),
  createTavilyDescriptor(),
  createExaDescriptor(),
  createBraveDescriptor(),
  createFirecrawlDescriptor(),
  createParallelDescriptor(),
  createPerplexityDescriptor(),
  createJinaDescriptor(),
  createYouDescriptor(),
  createLinkupDescriptor(),
  createSpiderDescriptor(),
  createBochaDescriptor(),
  createSearchApiDescriptor(),
  // Science suppliers (T2 seats) — real adapters ship here; the stub
  // seats live in types.ts's BUILT_IN_PROVIDER_DESCRIPTORS.
  // D2 listing order — openalex-first is the executor fan-out ARM
  // order, NOT the registry insertion order.
  createArxivDescriptor(),
  createOpenalexDescriptor(),
  createCrossrefDescriptor(),
  createPubmedDescriptor(),
  createEuropepmcDescriptor(),
];

/**
 * Look up a built-in Descriptor by ID. The optional `descriptors`
 * parameter lets tests inject doubles; production defaults to the
 * static built-in list.
 */
export function getProviderDescriptor(
  id: ProviderId,
  descriptors: readonly ProviderDescriptor[] = BUILT_IN_PROVIDER_DESCRIPTORS,
): ProviderDescriptor {
  return lookupProviderDescriptor(id, descriptors);
}

/**
 * Return the built-in Descriptors that are configured for the given
 * environment. Pure metadata; no Adapter is constructed.
 */
export function getConfiguredProviderDescriptors(
  env: NodeJS.ProcessEnv,
  descriptors: readonly ProviderDescriptor[] = BUILT_IN_PROVIDER_DESCRIPTORS,
): readonly ProviderDescriptor[] {
  return lookupConfigured(env, descriptors);
}
