import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../dist/index.js";
import { resolveFanoutPlan } from "../dist/commands/search.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

function configuredSearchDescriptors(created, invoked) {
  return ["deepseek", "tavily"].map((id) => ({
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create() {
      created.push(id);
      return { id, search: {
        validate() {},
        cacheIdentity(request) {
          return { provider: id, capability: "search", credentialFingerprint: `fixture-${id}`, request };
        },
        async invoke() {
          invoked.push(id);
          return [{ title: id, url: `https://example.test/${id}`, summary: "Fixture" }];
        },
      } };
    },
  }));
}

describe("present provider pins before search fan-out", () => {
  for (const pin of ["", "   "]) {
    it(`CLI rejects ${JSON.stringify(pin)} before constructing or billing fan-out arms`, async (t) => {
      let httpCalls = 0;
      t.mock.method(globalThis, "fetch", async () => { httpCalls++; throw new Error("unexpected HTTP"); });
      const created = [], invoked = [], consumption = [], stdout = [], stderr = [];
      const status = await main(["--provider", pin, "search", "q"], hermeticMainDeps({
        configFanout: true,
        loadScoutlineConfig: async () => ({ version: 1, providers: {}, fanout: true }),
        providerDescriptors: configuredSearchDescriptors(created, invoked),
        quotaState: { version: 1, providers: {} },
        consume: { async record(event) { consumption.push(event); } },
        invocation: { stdoutIsTTY: false, stdinIsTTY: false, environmentOutputMode: "data",
          readStdin: async () => "", writeStdout: (v) => stdout.push(v), writeStderr: (v) => stderr.push(v),
          runQuietly: async (op) => op(), setExitCode() {} },
      }));
      assert.equal(status, 1);
      assert.equal(JSON.parse(stderr.join("")).code, "VALIDATION_ERROR");
      assert.deepEqual(stdout, []);
      assert.deepEqual(created, []);
      assert.deepEqual(invoked, []);
      assert.deepEqual(consumption, []);
      assert.equal(httpCalls, 0);
    });
  }

  it("resolver rejects an empty environment pin before the fan-out config tier", () => {
    for (const pin of ["", "   "]) {
      assert.throws(() => resolveFanoutPlan({
        explicitProviderRaw: undefined,
        env: { SCOUTLINE_PROVIDER: pin }, configFanout: true,
        descriptors: configuredSearchDescriptors([], []),
      }), { code: "VALIDATION_ERROR" });
    }
  });

  for (const [pin, mode, arms] of [["deepseek", "single", ["deepseek"]],
    ["deepseek,tavily", "fanout", ["deepseek", "tavily"]], ["all", "fanout", ["deepseek", "tavily"]]]) {
    it(`explicit ${pin} retains precedence over an invalid environment pin`, () => {
      for (const envPin of ["", "   ", "invalid-provider"]) {
        const plan = resolveFanoutPlan({
          explicitProviderRaw: pin, env: { SCOUTLINE_PROVIDER: envPin }, configFanout: true,
          descriptors: configuredSearchDescriptors([], []),
        });
        assert.equal(plan.mode, mode);
        assert.deepEqual(plan.arms, arms);
      }
    });
  }
});
