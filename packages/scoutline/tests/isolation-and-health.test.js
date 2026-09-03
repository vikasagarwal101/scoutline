import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

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
      assert.equal(dir, path.join("/home/user", ".scoutline", "artifacts"));
    });

    it("returns process-isolated directory when SCOUTLINE_ISOLATED=1", () => {
      const dir = resolveArtifactsDir({ SCOUTLINE_ISOLATED: "1" }, { homedir: "/home/user", pid: 99999 });
      assert.equal(dir, path.join("/home/user", ".scoutline", "artifacts", "isolated", "99999"));
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

    it("retries with backoff and acquires lock under contention", async () => {
      const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
      const lockHash = "contention-hash";
      const executionOrder = [];

      try {
        const p1 = withAsyncFileLock(
          lockDir,
          lockHash,
          async () => {
            executionOrder.push("p1-start");
            await new Promise((resolve) => setTimeout(resolve, 100));
            executionOrder.push("p1-end");
            return "first";
          },
          { timeoutMs: 2000, staleMs: 10000, timeoutLabel: "First" },
        );

        // Wait until p1's lockfile exists (deterministic under load), instead of a fixed 20ms.
        const lockPath = path.join(lockDir, `${lockHash}.lock`);
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(lockPath)) {
          if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for p1 lockfile at ${lockPath}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }

        const p2 = withAsyncFileLock(
          lockDir,
          lockHash,
          async () => {
            executionOrder.push("p2-acquired");
            return "second";
          },
          { timeoutMs: 2000, staleMs: 10000, timeoutLabel: "Second" },
        );

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, "first");
        assert.equal(r2, "second");
        assert.deepEqual(executionOrder, ["p1-start", "p1-end", "p2-acquired"]);
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    });
  });
});
