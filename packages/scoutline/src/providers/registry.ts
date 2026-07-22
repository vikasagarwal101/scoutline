/**
 * Static Provider Registry (DESIGN.md §5, P2-05).
 *
 * The production registry is a static list of the two real Search
 * Provider Descriptors, in the fixed order [zai, minimax]. It performs
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
 */
export const BUILT_IN_PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  createZaiDescriptor(),
  createMiniMaxDescriptor(),
  createTavilyDescriptor(),
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
