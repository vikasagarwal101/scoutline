/**
 * Test helper: createFakeAdapter — a ProviderAdapter double that records
 * every Capability invocation. Each omitted Capability method is wired up
 * to throw so an unexpected call fails the test instead of silently returning
 * undefined.
 */
export function createFakeAdapter(overrides = {}) {
  const calls = {
    search: [],
    vision: [],
    quota: [],
    diagnostics: [],
  };

  const mustOverride = (name) => {
    throw new Error(
      `FakeAdapter was invoked for "${name}" but no override was provided. ` +
        `Provide createFakeAdapter({ ${name}: () => ... }) for this test.`,
    );
  };

  const adapter = {
    id: overrides.id || "fake",
    capabilities: () => overrides.capabilities || new Set(),
    async search(request) {
      calls.search.push(request);
      if (typeof overrides.search === "function") {
        return overrides.search(request);
      }
      mustOverride("search");
    },
    async visionInterpretImage(request) {
      calls.vision.push(request);
      if (typeof overrides.visionInterpretImage === "function") {
        return overrides.visionInterpretImage(request);
      }
      mustOverride("visionInterpretImage");
    },
    async quota() {
      calls.quota.push({});
      if (typeof overrides.quota === "function") {
        return overrides.quota();
      }
      mustOverride("quota");
    },
    async diagnostics() {
      calls.diagnostics.push({});
      if (typeof overrides.diagnostics === "function") {
        return overrides.diagnostics();
      }
      mustOverride("diagnostics");
    },
    async close() {
      return Promise.resolve();
    },
  };

  return { adapter, calls };
}
