/**
 * Shared hermetic `main()` dependency builder (GitHub #42).
 *
 * `MainDependencies` cache triples and `configFanout` are optional with
 * production fallbacks (`defaultResponseCache`, host `config.json`).
 * Tests that construct deps by hand forget a triple and silently hit
 * `~/.scoutline`. Call `hermeticMainDeps({ invocation, ... })` instead:
 * omitted triples get an in-memory cache + no-op sleep + deterministic
 * random, and `configFanout` defaults to `false`. Explicit caller
 * values always win.
 *
 * #119: `main()` also constructs `createDefaultQuotaStore()`
 * unconditionally, and the store's eager `stateFilePath()` resolve trips
 * the resolver guard under NODE_TEST_CONTEXT. An omitted `quotaStore`
 * gets a process-level lazy singleton pointed at an isolated temp dir —
 * lazy (one mkdtemp per test process, not per call) and never written
 * (callers asserting on consumption inject `consume` or `quotaState`).
 * The pre-dispatch agent-registration check has the same ambient seam
 * (`resolveConfigRoot()` + `os.homedir()`), so an omitted
 * `agentRegistrationCheck` defaults to a no-op — same isolation rule as
 * `loadScoutlineConfig` (#73).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultQuotaStore } from "../../dist/lib/quota-store.js";

export const HERMETIC_CAPABILITIES = Object.freeze([
  "search",
  "reader",
  "crawl",
  "map",
  "research",
  "repository",
]);

export function createInMemoryResponseCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

const noopSleep = async () => {};
const stableRandom = () => 0.5;

let hermeticQuotaStore;
function defaultHermeticQuotaStore() {
  hermeticQuotaStore ??= createDefaultQuotaStore({
    filePath: join(mkdtempSync(join(tmpdir(), "scoutline-hermetic-quota-")), "state.json"),
  });
  return hermeticQuotaStore;
}

function firstDefined(deps, suffix) {
  for (const cap of HERMETIC_CAPABILITIES) {
    const value = deps[`${cap}${suffix}`];
    if (value != null) return value;
  }
  return undefined;
}

function fillOmittedTriples(deps) {
  const cache = firstDefined(deps, "Cache") ?? createInMemoryResponseCache();
  const sleep = firstDefined(deps, "Sleep") ?? noopSleep;
  const random = firstDefined(deps, "Random") ?? stableRandom;
  for (const cap of HERMETIC_CAPABILITIES) {
    const cacheKey = `${cap}Cache`;
    const sleepKey = `${cap}Sleep`;
    const randomKey = `${cap}Random`;
    if (deps[cacheKey] == null) deps[cacheKey] = cache;
    if (deps[sleepKey] == null) deps[sleepKey] = sleep;
    if (deps[randomKey] == null) deps[randomKey] = random;
  }
  return deps;
}

/**
 * @param {object} [partial] Caller MainDependencies fields. `invocation`
 *   is required by `main()`; this helper does not invent one.
 * @returns {object} Deps safe to pass to `main()` without real-fs cache
 *   or host fan-out fallbacks.
 */
export function hermeticMainDeps(partial = {}) {
  const deps = {
    env: {},
    configFanout: false,
    // #73: config isolation default — env:{} is NOT isolation; main()
    // falls back to the real config file without this.
    loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    // #119: the default check resolves the ambient config root + real
    // home; its failure degrades to a stderr notice that pollutes
    // main()-driven assertions. No-op keeps the run hermetic.
    agentRegistrationCheck: async () => {},
    ...partial,
  };
  if (deps.configFanout === undefined) deps.configFanout = false;
  if (deps.quotaStore === undefined) deps.quotaStore = defaultHermeticQuotaStore();
  return fillOmittedTriples(deps);
}
