import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { resolveArtifactsDir } from "../dist/lib/artifacts.js";
import { buildDiagnosticsReport } from "../dist/commands/doctor.js";
import { withAsyncFileLock } from "../dist/lib/async-file-lock.js";
import { AuthError } from "../dist/lib/errors.js";

function makeMockDescriptor(id, isConfigured, probeFn) {
  return {
    id,
    capabilities: () => new Set(["search", "diagnostics"]),
    isConfigured: () => isConfigured,
    create: () => ({
      diagnostics: {
        id: "diagnostics",
        invoke: async () => {
          if (probeFn) return probeFn();
        },
      },
    }),
  };
}

describe("Concurrency Isolation & Provider Health Diagnostics", () => {
  describe("Artifacts Directory Isolation", () => {
    it("returns standard artifacts directory by default", () => {
      const dir = resolveArtifactsDir({}, { homedir: "/home/user" });
      assert.match(dir, /\.scoutline\/artifacts$/);
    });

    it("returns process-isolated directory when SCOUTLINE_ISOLATED=1", () => {
      const dir = resolveArtifactsDir({ SCOUTLINE_ISOLATED: "1" }, { homedir: "/home/user" });
      assert.match(dir, new RegExp(`\\.scoutline/artifacts/isolated/${process.pid}$`));
    });
  });

  describe("doctor --health active probe", () => {
    it("omits health field when healthProbe is false", async () => {
      const desc = makeMockDescriptor("zai", true, async () => {});
      const report = await buildDiagnosticsReport({
        noTools: false,
        healthProbe: false,
        effectiveProvider: "zai",
        descriptors: [desc],
        env: {},
        sleep: async () => {},
        random: () => 0.5,
      });

      assert.equal(report.providers[0].health, undefined);
      assert.equal(report.providers[0].status, "ok");
    });

    it("attaches latencyMs and status ok when healthProbe is true and probe succeeds", async () => {
      const desc = makeMockDescriptor("zai", true, async () => {});
      const report = await buildDiagnosticsReport({
        noTools: false,
        healthProbe: true,
        effectiveProvider: "zai",
        descriptors: [desc],
        env: {},
        sleep: async () => {},
        random: () => 0.5,
      });

      const provider = report.providers[0];
      assert.ok(provider.health !== undefined);
      assert.equal(provider.health.healthy, true);
      assert.equal(provider.health.status, "ok");
      assert.equal(typeof provider.health.latencyMs, "number");
    });

    it("attaches auth_error when provider probe throws AuthError under healthProbe", async () => {
      const desc = makeMockDescriptor("minimax", true, async () => {
        throw new AuthError("Invalid API token");
      });
      const report = await buildDiagnosticsReport({
        noTools: false,
        healthProbe: true,
        effectiveProvider: "minimax",
        descriptors: [desc],
        env: {},
        sleep: async () => {},
        random: () => 0.5,
      });

      const provider = report.providers[0];
      assert.ok(provider.health !== undefined);
      assert.equal(provider.health.healthy, false);
      assert.equal(provider.health.status, "auth_error");
      assert.match(provider.health.error, /Invalid API token/);
    });
  });

  describe("withAsyncFileLock jittered backoff", () => {
    it("allows single-process critical sections to execute without delay", async () => {
      let executed = false;
      const result = await withAsyncFileLock(
        undefined, // in-memory
        "test-hash",
        async () => {
          executed = true;
          return 42;
        },
        {
          timeoutMs: 1000,
          staleMs: 5000,
          timeoutLabel: "Test lock",
        },
      );

      assert.equal(executed, true);
      assert.equal(result, 42);
    });
  });
});
