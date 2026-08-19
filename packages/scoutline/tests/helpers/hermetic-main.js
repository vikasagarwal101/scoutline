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
 */
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
    ...partial,
  };
  if (deps.configFanout === undefined) deps.configFanout = false;
  return fillOmittedTriples(deps);
}
