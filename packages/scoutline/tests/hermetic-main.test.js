/**
 * #42 — hermetic `main()` dependency helper.
 *
 * `MainDependencies` cache triples and `configFanout` are optional with
 * production fallbacks. A test that forgets one triple reads/writes the
 * real on-disk cache; an omitted `configFanout` inherits the host
 * `config.json`. This suite pins the helper's public contract: fill every
 * omitted triple, pin fan-out off, and let explicit caller values win.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HERMETIC_CAPABILITIES,
  createInMemoryResponseCache,
  hermeticMainDeps,
} from "./helpers/hermetic-main.js";

const TRIPLE_KEYS = HERMETIC_CAPABILITIES.flatMap((cap) => [
  `${cap}Cache`,
  `${cap}Sleep`,
  `${cap}Random`,
]);

describe("hermeticMainDeps (#42)", () => {
  it("fills all six capability triples and pins configFanout off when omitted", () => {
    const invocation = { kind: "fake-invocation" };
    const env = { MARKER: "1" };
    const deps = hermeticMainDeps({ invocation, env });

    assert.equal(deps.invocation, invocation);
    assert.equal(deps.env, env);
    assert.equal(deps.configFanout, false);
    assert.deepEqual(HERMETIC_CAPABILITIES, [
      "search",
      "reader",
      "crawl",
      "map",
      "research",
      "repository",
    ]);
    for (const key of TRIPLE_KEYS) {
      assert.notEqual(deps[key], undefined, `missing ${key}`);
    }
    for (const cap of HERMETIC_CAPABILITIES) {
      assert.equal(typeof deps[`${cap}Sleep`], "function", `${cap}Sleep`);
      assert.equal(typeof deps[`${cap}Random`], "function", `${cap}Random`);
      assert.equal(typeof deps[`${cap}Cache`].get, "function", `${cap}Cache.get`);
      assert.equal(typeof deps[`${cap}Cache`].set, "function", `${cap}Cache.set`);
    }
  });

  it("lets the caller turn fan-out on", () => {
    const deps = hermeticMainDeps({ invocation: {}, configFanout: true });
    assert.equal(deps.configFanout, true);
  });

  it("fills omitted triples when only searchCache is provided", () => {
    const searchCache = createInMemoryResponseCache();
    const deps = hermeticMainDeps({ invocation: {}, searchCache });
    assert.equal(deps.searchCache, searchCache);
    for (const cap of HERMETIC_CAPABILITIES.filter((id) => id !== "search")) {
      assert.equal(deps[`${cap}Cache`], searchCache, `${cap}Cache should reuse searchCache`);
    }
  });

  it("keeps a caller-provided readerCache and still fills search", () => {
    const readerCache = createInMemoryResponseCache();
    const deps = hermeticMainDeps({ invocation: {}, readerCache });
    assert.equal(deps.readerCache, readerCache);
    assert.notEqual(deps.searchCache, undefined);
    assert.equal(typeof deps.searchCache.get, "function");
    assert.equal(typeof deps.searchCache.set, "function");
  });
});
